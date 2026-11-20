/**
 * incarnation-header-browser.mts — do the incarnation headers survive the trip
 * to the browser?
 *
 * THE REPORT, on the first full cutover test against an imported cloud-1 graph:
 * making a new document shows "Offline cache cannot be safely fenced", then the
 * workspace goes blank.
 *
 * Those are two different consequences of ONE possible cause. The cell mints
 * two custom response headers and the app reads both:
 *
 *   x-document-incarnation   documentSnapshot()  — missing is SILENT: the call
 *                            returns incarnation:null, and document-activation
 *                            quarantines the document as 'unfenced', which is
 *                            that banner.
 *   x-graph-incarnation      workspaceSnapshot() — missing THROWS a 502, which
 *                            fails the workspace read, which is the blank.
 *
 * Server-side both are set unconditionally (document_ydoc_projection.rs). A
 * node-http probe sees them fine. But the app does not talk to the cell
 * directly — it goes through a proxy, and a proxy that drops unknown response
 * headers would produce exactly this pair of symptoms while every server-side
 * test stays green.
 *
 * So this asks the question from inside the page, over the SAME proxy path the
 * app uses, rather than from Node where the proxy is not in the picture.
 *
 *   pnpm -C apps/organism run test:incarnation-headers
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { resolveGardendBin, spawnGardend, type GardendCell } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loopbackPath = resolve(appDir, '.gardend-loopback.json')
const port = Number(process.env.SHRUBBERY_INCARNATION_PORT ?? 5253)
const GRAPH_ID = 'incarnation-header-probe'
const DOC_ID = 'incarnation-doc'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`incarnation-header-browser assertion failed: ${message}`)
}

let cell: GardendCell | null = null
let server: Awaited<ReturnType<typeof createServer>> | null = null
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

try {
  const bin = resolveGardendBin()
  assert(existsSync(bin), `real gardend binary at ${bin}`)
  cell = await spawnGardend({ bin, readyTimeoutMs: 30_000 })

  const mcp = new LoopbackMcpClient({
    mcpUrl: cell.mcpUrl,
    healthUrl: `${cell.apiUrl}/health`,
    token: cell.token,
    origin: 'http://127.0.0.1',
  })
  await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'incarnation probe' })
  await mcp.toolsCall('create_document', { graphId: GRAPH_ID, documentId: DOC_ID, title: 'Probe doc' })

  // The Node-side reading, for contrast. If this is null the problem is the
  // cell, not the proxy, and the browser half below is beside the point.
  const fromNode = await mcp.documentSnapshot(GRAPH_ID, DOC_ID)
  console.log(`[node ] x-document-incarnation = ${JSON.stringify(fromNode.incarnation)}`)
  assert(fromNode.incarnation, 'the cell mints a document incarnation when asked directly')

  writeFileSync(loopbackPath, JSON.stringify({
    apiUrl: cell.apiUrl,
    mcpUrl: cell.mcpUrl,
    token: cell.token,
    port: cell.manifest.port,
    graphId: GRAPH_ID,
  }, null, 2))

  server = await createServer({
    root: appDir,
    configFile: resolve(appDir, 'vite.config.ts'),
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
    logLevel: 'warn',
  })
  await server.listen()

  browser = await chromium.launch({ headless: process.env.SHRUBBERY_HEADED !== '1' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  await page.goto(`http://127.0.0.1:${port}/g/${GRAPH_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.organismMode === 'local-cell', undefined, { timeout: 60_000 })

  // The same two reads the app makes, issued from the page, over the proxy.
  // NOTE: no named inner function. tsx compiles this with esbuild's keepNames
  // helper, which rewrites `const read = async (…) => …` into a `__name(...)`
  // call — a helper that exists in Node and not in the page, so the evaluate
  // dies with "__name is not defined". Inlined for that reason, not for style.
  const fromPage = await page.evaluate(async ({ graphId, documentId }) => {
    const out: Record<string, unknown> = {}
    const targets: Array<[string, string, string]> = [
      ['document', `/cell/documents/${graphId}/${documentId}/blob`, 'x-document-incarnation'],
      ['workspace', `/cell/documents/${graphId}/workspace/blob`, 'x-graph-incarnation'],
    ]
    for (const [key, path, header] of targets) {
      const response = await fetch(path, { cache: 'no-store' })
      out[key] = {
        status: response.status,
        ok: response.ok,
        header: response.headers.get(header),
        // What the page can see AT ALL. A cross-origin response only exposes
        // headers named in Access-Control-Expose-Headers, so an empty list here
        // beside a populated one server-side is the signature of that rule.
        visibleHeaders: [...response.headers.keys()],
      }
    }
    return out as {
      document: { status: number; ok: boolean; header: string | null; visibleHeaders: string[] }
      workspace: { status: number; ok: boolean; header: string | null; visibleHeaders: string[] }
    }
  }, { graphId: GRAPH_ID, documentId: DOC_ID })

  console.log('\n[page ] document blob:', JSON.stringify(fromPage.document, null, 2))
  console.log('[page ] workspace blob:', JSON.stringify(fromPage.workspace, null, 2))

  assert(fromPage.document.ok, `the page can read a document blob: ${fromPage.document.status}`)
  assert(fromPage.workspace.ok, `the page can read the workspace blob: ${fromPage.workspace.status}`)
  assert(
    fromPage.document.header,
    'x-document-incarnation survives the proxy — without it every document quarantines as unfenced',
  )
  assert(
    fromPage.workspace.header,
    'x-graph-incarnation survives the proxy — without it the workspace read throws and the workspace blanks',
  )
  console.log('\nBoth incarnation headers reach the page. The fence is not being stripped in transit.')
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
