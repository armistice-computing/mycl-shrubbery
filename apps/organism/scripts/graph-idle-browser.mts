/**
 * graph-idle-browser.mts — does the graph stop drawing when you cannot see it?
 *
 * REPORTED (Eschaton and Gamma, 2026-10-17): idle CPU stayed high on a static
 * Home or document. Gamma's sample put the web content process at 89-99% of
 * a core, in a requestAnimationFrame loop that wrote label styles every
 * frame. That loop is mn-graph-three's. sh-graph-host parks the closed graph
 * panel with visibility: hidden, and it kept its size, so it drew unseen.
 *
 * Counts the frames each mn-graph-three draws in two seconds:
 *   1. a document open, the graph panel closed: 0
 *   2. the panel opened (palette: Toggle Graph Panel): it animates
 *   3. closed again: 0
 *   4. opened again: it animates again
 *   5. the left rail switched to Graph, the graph dragged, then back to
 *      Files: the parked host covers no part of the file list
 *
 * Step 5 (Eschaton, 2026-10-17): after Graph -> Files the hidden host kept
 * the sidebar's exact box, and in the app a real wheel went to it, so the
 * file list would not scroll. Synthetic wheels here scroll regardless, so
 * the check is the geometry, not the wheel.
 *
 *   pnpm -C apps/organism run test:graph-idle
 *   SHRUBBERY_BROWSER_ENGINE=webkit pnpm -C apps/organism run test:graph-idle
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { resolveGardendBin, spawnGardend, type GardendCell } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loopbackPath = resolve(appDir, '.gardend-loopback.json')
const port = Number(process.env.SHRUBBERY_GRAPH_IDLE_PORT ?? 5281)
const engineName = process.env.SHRUBBERY_BROWSER_ENGINE ?? 'chromium'
if (engineName !== 'chromium' && engineName !== 'webkit') {
  throw new Error('SHRUBBERY_BROWSER_ENGINE must be chromium or webkit')
}
const engine = engineName === 'webkit' ? webkit : chromium
const GRAPH_ID = 'graph-idle-probe'
const DOCS = ['alpha-doc', 'bravo-doc', 'charlie-doc', 'delta-doc'] as const

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`graph-idle-browser assertion failed: ${message}`)
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
  await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'graph idle probe' })
  for (const [index, documentId] of DOCS.entries()) {
    const title = documentId.split('-')[0]!.toUpperCase()
    await mcp.toolsCall('create_document', { graphId: GRAPH_ID, documentId, title })
    await mcp.toolsCall('write_document', { graphId: GRAPH_ID, documentId, content: `<p>${title} body ${index}.</p>` })
    // Distinct creation times, oldest first.
    await new Promise(r => setTimeout(r, 1100))
  }

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

  browser = await engine.launch({ headless: process.env.SHRUBBERY_HEADED !== '1' })
  const page = await browser.newPage({ viewport: { width: 1512, height: 944 } })
  page.on('pageerror', error => console.error(`[pageerror] ${error.message}`))
  await page.goto(`http://127.0.0.1:${port}/g/${GRAPH_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.organismMode === 'local-cell', undefined, { timeout: 60_000 })
  await page.waitForFunction(
    (ids) => ids.every(id => !!document.querySelector('mn-sidebar-panel')?.shadowRoot?.querySelector(`[data-node-id="${id}"]`)),
    [...DOCS],
    { timeout: 60_000 },
  )

  const openFromSidebar = async (documentId: string): Promise<void> => {
    await page.evaluate((id) => {
      const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
      ;(panel?.shadowRoot?.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null)?.click()
    }, documentId)
    await page.waitForFunction((id) => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const text = host?.shadowRoot?.querySelector('.editor-mount [contenteditable="true"]')?.textContent ?? ''
      return text.includes(id.split('-')[0]!.toUpperCase())
    }, documentId, { timeout: 30_000 })
    await page.waitForTimeout(400)
  }
  await openFromSidebar('alpha-doc')
  await openFromSidebar('charlie-doc')

  // Every mn-graph-three in the page, through shadow roots: how many frames
  // each draws in two seconds, and how big it is on screen.
  const graphFrames = async (label: string) => {
    const result = await page.evaluate(async () => {
      const found: (HTMLElement & { _renderFrame?: () => void })[] = []
      const stack: (Document | ShadowRoot | Element)[] = [document]
      while (stack.length) {
        const root = stack.pop()!
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el.tagName.toLowerCase() === 'mn-graph-three') found.push(el as HTMLElement)
          if (el.shadowRoot) stack.push(el.shadowRoot)
        }
      }
      const counts = found.map(() => 0)
      found.forEach((el, index) => {
        const original = el._renderFrame
        if (!original) return
        el._renderFrame = () => { counts[index]! += 1; original() }
      })
      await new Promise(r => setTimeout(r, 2000))
      return found.map((el, index) => {
        const rect = el.getBoundingClientRect()
        return { frames: counts[index], width: Math.round(rect.width), height: Math.round(rect.height), connected: el.isConnected }
      })
    })
    console.log(`${label}:`, JSON.stringify(result))
    return result
  }
  const togglePanel = async (): Promise<void> => {
    await page.keyboard.press('ControlOrMeta+k')
    await page.waitForTimeout(400)
    await page.keyboard.type('Toggle Graph Panel')
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
  }
  const failures: string[] = []
  const expect = (label: string, frames: { frames: number }[], drawing: boolean): void => {
    if (frames.length !== 1) failures.push(`${label}: ${frames.length} graphs mounted, expected 1`)
    const drawn = frames[0]?.frames ?? 0
    // Headless engines draw near 60fps: two seconds is about 120 frames.
    if (drawing ? drawn < 30 : drawn !== 0) failures.push(`${label}: drew ${drawn} frames`)
  }
  expect('panel closed', await graphFrames('document open, graph panel closed'), false)
  await togglePanel()
  expect('panel opened', await graphFrames('graph panel opened'), true)
  await togglePanel()
  expect('panel closed again', await graphFrames('graph panel closed again'), false)
  await togglePanel()
  expect('panel opened again', await graphFrames('graph panel opened again'), true)

  // 5. Left rail: Graph, orbit the camera, back to Files.
  const leftMode = async (name: string): Promise<void> => {
    await page.evaluate((label) => {
      const bar = document.querySelector('mn-bottom-bar') as HTMLElement
      ;(bar.shadowRoot!.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click()
    }, name)
    await page.waitForTimeout(1500)
  }
  await togglePanel()
  await leftMode('Graph')
  const canvas = await page.evaluate(() => {
    const host = document.querySelector('sh-graph-host') as HTMLElement
    const r = host.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.move(canvas.x, canvas.y)
  await page.mouse.down()
  await page.mouse.move(canvas.x + 80, canvas.y, { steps: 8 })
  await page.mouse.up()
  await leftMode('Files')
  const overlap = await page.evaluate(() => {
    const host = (document.querySelector('sh-graph-host') as HTMLElement).getBoundingClientRect()
    const side = (document.querySelector('mn-sidebar-panel') as HTMLElement).getBoundingClientRect()
    const w = Math.min(host.right, side.right) - Math.max(host.left, side.left)
    const h = Math.min(host.bottom, side.bottom) - Math.max(host.top, side.top)
    return { area: Math.max(0, w) * Math.max(0, h), host: [Math.round(host.left), Math.round(host.top), Math.round(host.width), Math.round(host.height)] }
  })
  console.log('parked host after Graph -> Files:', JSON.stringify(overlap))
  if (overlap.area > 0) failures.push(`the parked graph host covers ${Math.round(overlap.area)}px² of the file list`)
  expect('left rail back to Files', await graphFrames('left rail back to Files'), false)

  assert(failures.length === 0, failures.join('; '))
  console.log(`\n${engineName}: the graph draws only while its panel is open, and parks clear of the file list.`)
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
