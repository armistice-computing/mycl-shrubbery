/**
 * editor-select-across-blocks-browser.mts — do Select All and a drag selection
 * work across blocks?
 *
 * REPORTED: "cmd+a doesn't select all, and the whole thing acts extremely
 * weird if I try to click and drag to select text across blocks."
 *
 * TWO CAUSES, both found with this harness:
 *
 *   1. Every block carried a drag handle, a contenteditable=false widget INSIDE
 *      the block in front of its first character. A drag selection snapped
 *      both ends to block edges (1..60 where 14..73 was dragged), in WebKit and
 *      Chromium alike. The handle now lives beside the document.
 *   2. The host wrote `data-block-focused` onto ProseMirror's block elements on
 *      every selection change. ProseMirror's DOMObserver read each write as an
 *      edit and re-read the selection, which WebKit reports collapsed mid-drag:
 *      the selection died as the pointer entered the next block. It is a
 *      decoration now (editor-kernel FocusedBlock).
 *
 * Ends with the check that the handle, now outside the text, still moves a
 * block: drag BRAVO's handle below CHARLIE.
 *
 * Measured by EFFECT, not by reading the selection, because selection APIs
 * read from outside a shadow root are retargeted in WebKit:
 *
 *   select all  -> type "X" -> the document should be exactly one block "X"
 *   drag from the middle of ALPHA to the middle of CHARLIE, and back up ->
 *              type "Y" -> one block remains, ALPHA's head + "Y" + CHARLIE's tail
 *
 * SHRUBBERY_HIDE_HANDLES=1 hides the drag handle with display:none (the
 * reorder check then fails, as it should).
 *
 *   SHRUBBERY_BROWSER_ENGINE=webkit pnpm -C apps/organism run test:editor-select-across-blocks
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { chromium, webkit, type Page } from 'playwright'
import { createServer } from 'vite'
import { resolveGardendBin, spawnGardend, type GardendCell } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loopbackPath = resolve(appDir, '.gardend-loopback.json')
const port = Number(process.env.SHRUBBERY_SELECT_PORT ?? 5290)
const engineName = process.env.SHRUBBERY_BROWSER_ENGINE ?? 'chromium'
if (engineName !== 'chromium' && engineName !== 'webkit') {
  throw new Error('SHRUBBERY_BROWSER_ENGINE must be chromium or webkit')
}
const engine = engineName === 'webkit' ? webkit : chromium
const hideHandles = process.env.SHRUBBERY_HIDE_HANDLES === '1'
const GRAPH_ID = 'editor-select-probe'
// SHRUBBERY_SELECT_NESTED=1 indents CHARLIE under BRAVO, so the drag crosses a
// parent block, which carries the outliner's fold button inside its text.
// SHRUBBERY_SELECT_BULLETS=1 makes the three blocks bullet list items, which
// is where WebKit painted bands into the gaps between blocks.
// SHRUBBERY_SELECT_WRAP=1 makes ALPHA long enough to wrap onto a second line.
const ALPHA_TEXT = process.env.SHRUBBERY_SELECT_WRAP === '1'
  ? 'ALPHA first paragraph, long enough to wrap onto a second line in the editor column so the selection covers a wrapped block the way real notes do, here.'
  : 'ALPHA first paragraph here.'
const CONTENT = process.env.SHRUBBERY_SELECT_WRAP === '1'
  ? `<p>${ALPHA_TEXT}</p><p>BRAVO second paragraph here.</p><p>CHARLIE third paragraph here.</p>`
  : process.env.SHRUBBERY_SELECT_BULLETS === '1'
  ? '<ul><li><p>ALPHA first paragraph here.</p></li><li><p>BRAVO second paragraph here.</p></li><li><p>CHARLIE third paragraph here.</p></li></ul>'
  : process.env.SHRUBBERY_SELECT_NESTED === '1'
  ? '<p>ALPHA first paragraph here.</p><p>BRAVO second paragraph here.</p><p data-indent="1">CHARLIE third paragraph here.</p>'
  : '<p>ALPHA first paragraph here.</p><p>BRAVO second paragraph here.</p><p>CHARLIE third paragraph here.</p>'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`editor-select-across-blocks-browser assertion failed: ${message}`)
}

let cell: GardendCell | null = null
let server: Awaited<ReturnType<typeof createServer>> | null = null
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

async function openDoc(page: Page, documentId: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/g/${GRAPH_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.organismMode === 'local-cell', undefined, { timeout: 60_000 })
  await page.waitForFunction(
    () => !!document.querySelector('mn-sidebar-panel')?.shadowRoot?.querySelector('[data-file-pane-body]'),
    undefined,
    { timeout: 60_000 },
  )
  await page.evaluate((id) => {
    const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
    const row = panel?.shadowRoot?.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null
    row?.click()
  }, documentId)
  await page.waitForFunction(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    return (host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > :is(p, li)').length ?? 0) >= 3
  }, undefined, { timeout: 60_000 })
  if (hideHandles) {
    await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const style = document.createElement('style')
      style.textContent = '.block-drag-handle { display: none !important; }'
      host?.shadowRoot?.appendChild(style)
    })
  }
  await page.waitForTimeout(1000)
}

async function paragraphs(page: Page): Promise<string[]> {
  const blocks = await page.evaluate(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    return Array.from(host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > *') ?? [])
      .map(node => (node.textContent ?? '').trim())
  })
  // The editor keeps an empty paragraph after a list (the trailing node). It is
  // not part of the fixture; empty blocks anywhere else still count.
  if (process.env.SHRUBBERY_SELECT_BULLETS === '1' && blocks[blocks.length - 1] === '') blocks.pop()
  return blocks
}

function point(page: Page, index: number, fraction: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(([i, f]) => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    const paragraph = host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > :is(p, li)')[i] as HTMLElement | undefined
    if (!paragraph) return null
    // The first TEXT node, not the paragraph's contents: a parent block's fold
    // button sits inside the paragraph ahead of the text, and its rect would
    // come first and be clicked instead.
    const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode()
    if (!text) return null
    const range = document.createRange()
    range.selectNodeContents(text)
    const line = range.getClientRects()[0]
    return line ? { x: line.left + line.width * f, y: line.top + line.height / 2 } : null
  }, [index, fraction] as const)
}

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
  await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'select probe' })
  for (const id of ['select-all-doc', 'drag-down-doc', 'drag-up-doc', 'reorder-doc']) {
    await mcp.toolsCall('create_document', { graphId: GRAPH_ID, documentId: id, title: id })
    await mcp.toolsCall('write_document', { graphId: GRAPH_ID, documentId: id, content: CONTENT })
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

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const results: Record<string, unknown> = { engine: engineName, handlesHidden: hideHandles }

  console.log('[select-all] start')
  // SELECT ALL, typed over.
  {
    const page = await browser.newPage({ viewport: { width: 1512, height: 944 } })
    await openDoc(page, 'select-all-doc')
    const start = await point(page, 1, 0.5)
    assert(start, 'BRAVO is on screen')
    await page.mouse.click(start!.x, start!.y)
    await page.keyboard.press(`${mod}+a`)
    await page.waitForTimeout(200)
    // SHRUBBERY_SELECT_SHOT=<path.png> saves what Select All paints, to check
    // by eye (WebKit fills the gaps between selected blocks).
    if (process.env.SHRUBBERY_SELECT_SHOT) {
      await page.screenshot({ path: process.env.SHRUBBERY_SELECT_SHOT })
    }
    await page.keyboard.type('X')
    await page.waitForTimeout(400)
    results.selectAllThenType = await paragraphs(page)
    await page.close()
  }

  // DRAG a selection from the middle of one paragraph to the middle of another,
  // DOWN (ALPHA to CHARLIE) and UP (CHARLIE to ALPHA), then type over it. The
  // report was that up mostly worked and down did not.
  for (const direction of ['down', 'up'] as const) {
    const page = await browser.newPage({ viewport: { width: 1512, height: 944 } })
    await openDoc(page, `drag-${direction}-doc`)
    const alpha = await point(page, 0, 0.5)
    const charlie = await point(page, 2, 0.5)
    assert(alpha, 'ALPHA is on screen')
    assert(charlie, 'CHARLIE is on screen')
    const [from, to] = direction === 'down' ? [alpha!, charlie!] : [charlie!, alpha!]
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 })
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    // What ProseMirror BELIEVES is selected, read from the editor state. This
    // separates "the browser selected the wrong thing" from "ProseMirror
    // misread a correct browser selection" — the typed result alone cannot.
    results[`drag-${direction}-selection`] = await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as unknown as {
        _editor?: { state: { selection: { from: number; to: number }; doc: { textBetween(a: number, b: number, sep: string): string } } }
      } | null
      const state = host?._editor?.state
      if (!state) return null
      const { from, to } = state.selection
      return state.doc.textBetween(from, to, ' | ')
    })
    await page.waitForTimeout(200)
    await page.keyboard.type('Y')
    await page.waitForTimeout(400)
    results[`drag-${direction}-then-type`] = await paragraphs(page)
    await page.close()
  }

  // THE HANDLE STILL MOVES BLOCKS. It now lives beside the document instead of
  // inside each block; drag it from BRAVO to the lower half of CHARLIE.
  {
    const page = await browser.newPage({ viewport: { width: 1512, height: 944 } })
    await openDoc(page, 'reorder-doc')
    const bravo = await point(page, 1, 0.5)
    assert(bravo, 'BRAVO is on screen')
    await page.mouse.move(bravo!.x, bravo!.y)
    await page.waitForTimeout(100)
    const grip = await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const handle = host?.shadowRoot?.querySelector('.editor-mount > .block-drag-handle') as HTMLElement | null
      if (!handle?.hasAttribute('data-visible')) return null
      const rect = handle.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    assert(grip, 'hovering BRAVO shows the drag handle')
    const charlie = await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const paragraph = host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > :is(p, li)')[2] as HTMLElement | undefined
      const rect = paragraph?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.8 } : null
    })
    assert(charlie, 'CHARLIE is on screen')
    await page.mouse.move(grip!.x, grip!.y)
    await page.mouse.down()
    await page.mouse.move(grip!.x + 4, grip!.y + 4, { steps: 2 })
    await page.mouse.move(charlie!.x, charlie!.y, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(400)
    results.handleReorder = await paragraphs(page)
    await page.close()
  }

  console.log(JSON.stringify(results, null, 2))

  const all = results.selectAllThenType as string[]
  const failures: string[] = []
  if (!(all.length === 1 && all[0] === 'X')) {
    failures.push(`select all + type left ${JSON.stringify(all)}, expected ["X"]`)
  }
  for (const direction of ['down', 'up']) {
    const drag = results[`drag-${direction}-then-type`] as string[]
    const merged = drag.length === 1 ? drag[0]! : ''
    if (!(drag.length === 1 && merged.startsWith('ALPHA') && merged.includes('Y') && merged.endsWith('here.') && !merged.includes('BRAVO'))) {
      failures.push(`drag ${direction} + type left ${JSON.stringify(drag)}, expected one block: ALPHA's head + "Y" + CHARLIE's tail`)
    }
  }
  // Nested, BRAVO is CHARLIE's parent, and a block cannot be dropped into its
  // own subtree: the planner refuses and the order must not change.
  const expectedOrder = process.env.SHRUBBERY_SELECT_NESTED === '1' ? 'ALPHA,BRAVO,CHARLIE' : 'ALPHA,CHARLIE,BRAVO'
  const order = (results.handleReorder as string[]).map(text => text.split(' ')[0])
  if (order.join(',') !== expectedOrder) {
    failures.push(`dragging BRAVO's handle below CHARLIE left ${order.join(', ')}, expected ${expectedOrder}`)
  }
  assert(failures.length === 0, failures.join('; '))
  console.log('\nSelect all, drag selections in both directions, and the block drag handle all do what they should.')
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
