import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'
import { resolveGardendBin, spawnGardend } from '../src/cell/spawn-gardend.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.SHRUBBERY_PDF_READER_BROWSER_PORT ?? 5224)
const graphId = 'pdf-safari-harness'
const artifactId = 'sample-copy'
const sourcePath = process.env.SHRUBBERY_PDF_READER_FILE
if (!sourcePath) throw new Error('Set SHRUBBERY_PDF_READER_FILE to a PDF to open.')
const filename = sourcePath.split('/').pop() ?? 'sample.pdf'

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return Buffer.from(binary, 'binary').toString('base64')
}

const bin = resolveGardendBin()
const cell = await spawnGardend({ bin, readyTimeoutMs: 30_000 })
const server = await createServer({
  root: appDir,
  configFile: resolve(appDir, 'vite.config.ts'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  logLevel: 'warn',
})
let closing = false

async function close(): Promise<void> {
  if (closing) return
  closing = true
  await server.close().catch(() => undefined)
  await cell.kill().catch(() => undefined)
}

process.on('SIGINT', () => { void close().then(() => process.exit(0)) })
process.on('SIGTERM', () => { void close().then(() => process.exit(0)) })

try {
  const mcp = new LoopbackMcpClient({
    mcpUrl: cell.mcpUrl,
    healthUrl: `${cell.apiUrl}/health`,
    token: cell.token,
    origin: 'http://127.0.0.1',
  })
  await mcp.toolsCall('create_graph', { graph_id: graphId, title: 'PDF Safari Harness' })
  await mcp.callTool('create_document', {
    graphId,
    documentId: 'pdf-reader-harness-ingested',
    title: 'Harness ingested document',
  })
  const bytes = new Uint8Array(readFileSync(sourcePath))
  const headers = { Authorization: `Bearer ${cell.token}`, 'X-User-ID': 'pdf-safari-harness' }
  const revision = await fetch(`${cell.apiUrl}/artifacts/${graphId}/${artifactId}/revisions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dataBase64: base64(bytes),
      mimeType: 'application/pdf',
      filename,
      label: 'Sample copy',
    }),
  })
  if (!revision.ok) throw new Error(`artifact upload failed: HTTP ${revision.status}`)
  const navigation = await fetch(`${cell.apiUrl}/navigation/${graphId}/artifacts/${artifactId}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label: 'Sample copy',
      originalFilename: filename,
      mimeType: 'application/pdf',
      status: 'ready',
      storageKey: `local://artifacts/${artifactId}/original/${filename}`,
    }),
  })
  if (!navigation.ok) throw new Error(`artifact registration failed: HTTP ${navigation.status}`)

  await server.listen()
  const query = new URLSearchParams({
    apiUrl: cell.apiUrl,
    mcpUrl: cell.mcpUrl,
    token: cell.token,
    graphId,
    artifactId,
    title: 'Sample copy',
  })
  const url = `http://127.0.0.1:${port}/pdf-reader-browser-harness.html?${query}`
  process.stdout.write(`${JSON.stringify({ ready: true, url, pages: 12, embeddedAnnotations: 0 })}\n`)
  await new Promise(() => undefined)
} catch (error) {
  await close()
  throw error
}
