/**
 * editor-arrow-across-blocks-browser.mts — can the caret cross a block boundary
 * with the arrow keys?
 *
 * REPORTED: "you can't click left on keyboard at the start of a block to go to
 * the previous block".
 *
 * SUSPECT. `block-dnd.ts` inserts a drag handle into EVERY block, as a widget at
 * `block.pos + 1` — inside the block, before its first character — and the
 * handle is `contenteditable="false"`. `margin-gloss.ts` does the same on wired
 * blocks. A non-editable inline element at offset 0 is a known caret trap: the
 * browser's native Left arrow runs into it and stops, instead of moving into
 * the previous block.
 *
 * This measures the four boundary moves a writer makes and reports which
 * paragraph holds the caret after each one. The paragraph is read from the
 * DOM selection, not from ProseMirror, because the bug is the browser's.
 *
 *   pnpm -C apps/organism run test:editor-arrow-across-blocks
 *   SHRUBBERY_BROWSER_ENGINE=webkit pnpm -C apps/organism run test:editor-arrow-across-blocks
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
const port = Number(process.env.SHRUBBERY_ARROW_PORT ?? 5277)
const engineName = process.env.SHRUBBERY_BROWSER_ENGINE ?? 'chromium'
if (engineName !== 'chromium' && engineName !== 'webkit') {
  throw new Error('SHRUBBERY_BROWSER_ENGINE must be chromium or webkit')
}
const engine = engineName === 'webkit' ? webkit : chromium
const GRAPH_ID = 'editor-arrow-probe'
const DOC_ID = 'arrow-doc'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`editor-arrow-across-blocks-browser assertion failed: ${message}`)
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
  await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'arrow probe' })
  await mcp.toolsCall('create_document', { graphId: GRAPH_ID, documentId: DOC_ID, title: 'Arrow probe' })
  await mcp.toolsCall('write_document', {
    graphId: GRAPH_ID,
    documentId: DOC_ID,
    // SHRUBBERY_ARROW_NESTED=1 indents CHARLIE under BRAVO, so BRAVO is a
    // parent block and carries the outliner's fold button.
    content: process.env.SHRUBBERY_ARROW_NESTED === '1'
      ? '<p>ALPHA first paragraph.</p><p>BRAVO second paragraph.</p><p data-indent="1">CHARLIE third paragraph.</p><p></p><p>DELTA fifth paragraph.</p>'
      : '<p>ALPHA first paragraph.</p><p>BRAVO second paragraph.</p><p>CHARLIE third paragraph.</p><p></p><p>DELTA fifth paragraph.</p>',
  })

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
    () => !!document.querySelector('mn-sidebar-panel')?.shadowRoot?.querySelector('[data-file-pane-body]'),
    undefined,
    { timeout: 60_000 },
  )
  await page.evaluate((documentId) => {
    const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
    const row = panel?.shadowRoot?.querySelector(`[data-node-id="${documentId}"]`) as HTMLElement | null
    row?.click()
  }, DOC_ID)
  await page.waitForFunction(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    const paragraphs = host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > p') ?? []
    return paragraphs.length >= 5
  }, undefined, { timeout: 60_000 })
  await page.waitForTimeout(1000)

  // Which paragraph the caret is in, read from the live DOM selection. The
  // editor is inside a shadow root, so the selection comes from the root when
  // the engine offers it there and from the document otherwise.
  // THE MEASURE THAT CANNOT BE RETARGETED: type a marker where the caret is,
  // see which paragraph received it, delete it. Selection APIs read from outside
  // a shadow root lie in WebKit (anchor = the host, offset 1, on every press);
  // a character landing in a paragraph is what the writer experiences, in any
  // engine.
  const caret = async (): Promise<{ block: string; offset: number; blocks: number; pm: string }> => {
    // What ProseMirror believes, read before the marker is typed.
    const pm = await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as unknown as {
        _editor?: { state: { selection: { from: number; to: number; $from: { parent: { type: { name: string }; textContent: string }; parentOffset: number } } } }
      } | null
      const selection = host?._editor?.state.selection
      if (!selection) return '(no editor)'
      const dom = ((host as unknown as HTMLElement).shadowRoot as unknown as { getSelection?: () => Selection | null }).getSelection?.()
      const ends = dom
        ? [[dom.anchorNode, dom.anchorOffset], [dom.focusNode, dom.focusOffset]].map(([node, offset]) =>
            `${(node as Node | null)?.nodeName}${(node as Node | null)?.nodeType === 3 ? `"${((node as Node).textContent ?? '').slice(0, 5)}"` : `.${((node as Element | null)?.className ?? '')}`}@${offset}`).join(' -> ')
        : 'n/a'
      return `${selection.from}..${selection.to} in ${selection.$from.parent.type.name} "${selection.$from.parent.textContent.slice(0, 7)}"@${selection.$from.parentOffset} dom=${ends}`
    })
    await page.keyboard.type('§')
    const found = await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const root = host?.shadowRoot ?? null
      const paragraphs = Array.from(root?.querySelectorAll('.editor-mount [contenteditable="true"] > p') ?? [])
      const hit = paragraphs.find(p => (p.textContent ?? '').includes('§'))
      const text = hit?.textContent ?? ''
      return {
        block: text.replace(/[^A-Z]/g, '').slice(0, 7) || (hit ? '(empty)' : '(none)'),
        offset: text.indexOf('§'),
        blocks: paragraphs.length,
      }
    })
    await page.keyboard.press('Backspace')
    return { ...found, pm }
  }
  // Put the caret at the very start of BRAVO: click in its text, then Home.
  const bravo = await page.evaluate(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    const paragraph = host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > p')[1] as HTMLElement | undefined
    const rect = paragraph?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })
  assert(bravo, 'the second paragraph is on screen')
  // The fourth paragraph is empty: nothing but the widgets in front of its
  // (absent) first character, so every arrow key starts at a block edge.
  const empty = await page.evaluate(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    const paragraph = host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > p')[3] as HTMLElement | undefined
    const rect = paragraph?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })
  assert(empty, 'the empty fourth paragraph is on screen')

  // Line start / end. WebKit on macOS follows Mac text bindings, where Home and
  // End scroll the document and Cmd+Left / Cmd+Right move to the line edges. An
  // earlier run pressed Home there, started from the END of BRAVO, and reported
  // that Left "stayed in BRAVO" — correct behaviour, measured from the wrong place.
  const macBindings = engineName === 'webkit' ? process.platform === 'darwin' : false
  const LINE_START = macBindings ? 'Meta+ArrowLeft' : 'Home'
  const LINE_END = macBindings ? 'Meta+ArrowRight' : 'End'

  // At a person's pace. Playwright presses keys faster than Chromium delivers
  // selectionchange, so a second key could otherwise act on ProseMirror's
  // selection from before the first one: Home, then an instant Up, ran Up
  // against the caret's pre-Home position. Nobody types two keys in one
  // millisecond, and the arrow bug this checks does not depend on speed.
  const press = async (key: string): Promise<void> => {
    await page.keyboard.press(key)
    await page.waitForTimeout(80)
  }
  const results: Record<string, unknown> = {}

  await page.mouse.click(bravo!.x, bravo!.y)
  await press(LINE_START)
  results.atStartOfBravo = await caret()
  await press('ArrowLeft')
  results.afterOneLeft = await caret()
  await press('ArrowLeft')
  results.afterTwoLefts = await caret()

  await page.mouse.click(bravo!.x, bravo!.y)
  await press(LINE_END)
  results.atEndOfBravo = await caret()
  await press('ArrowRight')
  results.afterOneRight = await caret()

  await page.mouse.click(bravo!.x, bravo!.y)
  await press(LINE_START)
  await press('ArrowUp')
  results.upFromStartOfBravo = await caret()

  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    await page.mouse.click(empty!.x, empty!.y)
    await press(key)
    results[`${key}FromEmpty`] = await caret()
  }

  console.log(`${engineName}:`, JSON.stringify(results, null, 2))

  const one = results.afterOneLeft as { block: string }
  const right = results.afterOneRight as { block: string }
  const up = results.upFromStartOfBravo as { block: string }
  const failures: string[] = []
  if (one.block !== 'ALPHA') failures.push(`one Left from the start of BRAVO landed in ${one.block}, not ALPHA`)
  if (right.block !== 'CHARLIE') failures.push(`one Right from the end of BRAVO landed in ${right.block}, not CHARLIE`)
  if (up.block !== 'ALPHA') failures.push(`Up from the start of BRAVO landed in ${up.block}, not ALPHA`)
  const fromEmpty: Record<string, string> = { ArrowUp: 'CHARLIE', ArrowLeft: 'CHARLIE', ArrowDown: 'DELTA', ArrowRight: 'DELTA' }
  for (const [key, expected] of Object.entries(fromEmpty)) {
    const landed = (results[`${key}FromEmpty`] as { block: string }).block
    if (landed !== expected) failures.push(`${key} from the empty block landed in ${landed}, not ${expected}`)
  }
  // THE DANGEROUS HALF. When the drag handle sat inside each block, WebKit left
  // the caret inside it, and the Backspace this harness sends to remove its
  // marker JOINED ALPHA into BRAVO. Five blocks in, five blocks out, or a
  // keypress in the wrong place destroyed a paragraph boundary.
  const merged = Object.entries(results).filter(([, value]) => (value as { blocks: number }).blocks !== 5)
  if (merged.length > 0) failures.push(`a block boundary was destroyed during: ${merged.map(([name]) => name).join(', ')}`)
  assert(failures.length === 0, failures.join('; '))
  console.log('\nThe caret crosses block boundaries in both directions with one keypress.')
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
