/**
 * editor-comment-popover-browser.mts — does adding a comment open its popover,
 * pinned and ready to type into, the way cloud-1 did?
 *
 * REPORTED: creating an inline comment in offline Garden only opened the
 * Comments sidebar. cloud-1 pinned the new comment's popover in edit mode
 * instead, and showed a peek popover when hovering a comment.
 *
 * The run, in the real app against a real gardend:
 *   1. double-click BRAVO, press Mod+Shift+. -> one pinned popover, its
 *      textarea focused, the Comments panel NOT opened, the mark painted as
 *      the active comment (a decoration span inside the mark);
 *   2. type a note, Mod+Enter -> the popover shows the note;
 *   3. close it -> no popover, the mark stays;
 *   4. hover the mark -> a peek popover; move away -> gone;
 *   5. click the mark -> pinned again;
 *   6. comment CHARLIE and close it without typing -> its mark is removed.
 *
 *   SHRUBBERY_BROWSER_ENGINE=webkit pnpm -C apps/organism run test:editor-comment-popover
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
const port = Number(process.env.SHRUBBERY_COMMENT_PORT ?? 5297)
const engineName = process.env.SHRUBBERY_BROWSER_ENGINE ?? 'chromium'
if (engineName !== 'chromium' && engineName !== 'webkit') {
  throw new Error('SHRUBBERY_BROWSER_ENGINE must be chromium or webkit')
}
const engine = engineName === 'webkit' ? webkit : chromium
const GRAPH_ID = 'editor-comment-probe'
const DOC_ID = 'comment-doc'
const CONTENT = '<p>ALPHA first paragraph here.</p><p>BRAVO second paragraph here.</p><p>CHARLIE third paragraph here.</p>'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`editor-comment-popover-browser assertion failed: ${message}`)
}

let cell: GardendCell | null = null
let server: Awaited<ReturnType<typeof createServer>> | null = null
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

async function openDoc(page: Page): Promise<void> {
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
  }, DOC_ID)
  await page.waitForFunction(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    return (host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > p').length ?? 0) >= 3
  }, undefined, { timeout: 60_000 })
  await page.waitForTimeout(1000)
}

/** Centre of the first word of paragraph `index`. */
function wordPoint(page: Page, index: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate((i) => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    const paragraph = host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > p')[i] as HTMLElement | undefined
    const text = paragraph ? document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode() : null
    if (!text) return null
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, Math.min(3, (text.textContent ?? '').length))
    const rect = range.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, index)
}

interface PopoverState {
  readonly id: string
  readonly mode: string
  readonly text: string
  readonly editing: boolean
  readonly textareaFocused: boolean
}

function popovers(page: Page): Promise<PopoverState[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-comment-popover-layer] mn-comment-popover')).map(element => {
      const root = (element as HTMLElement).shadowRoot
      const textarea = root?.querySelector('textarea') ?? null
      return {
        id: element.getAttribute('comment-id') ?? '',
        mode: element.getAttribute('mode') ?? '',
        text: (root?.querySelector('.comment-text')?.textContent ?? '').trim(),
        editing: textarea != null,
        textareaFocused: textarea != null && root?.activeElement === textarea,
      }
    }))
}

function marks(page: Page): Promise<Array<{ id: string; text: string; active: boolean }>> {
  return page.evaluate(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    return Array.from(host?.shadowRoot?.querySelectorAll('.comment-mark[data-comment-id]') ?? []).map(mark => ({
      id: mark.getAttribute('data-comment-id') ?? '',
      text: mark.textContent ?? '',
      active: mark.querySelector('.comment-active') != null,
    }))
  })
}

function commentsPanelShown(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('mn-comments-panel')).some(panel => {
      const rect = (panel as HTMLElement).getBoundingClientRect()
      return rect.width > 0 ? rect.height > 0 : false
    }))
}

async function closePinned(page: Page, id: string): Promise<void> {
  await page.evaluate((commentId) => {
    const popover = document.querySelector(`[data-comment-popover-layer] mn-comment-popover[comment-id="${commentId}"]`) as HTMLElement | null
    ;(popover?.shadowRoot?.querySelector('.close') as HTMLElement | null)?.click()
  }, id)
  await page.waitForTimeout(300)
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
  await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'comment probe' })
  await mcp.toolsCall('create_document', { graphId: GRAPH_ID, documentId: DOC_ID, title: DOC_ID })
  await mcp.toolsCall('write_document', { graphId: GRAPH_ID, documentId: DOC_ID, content: CONTENT })
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
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const log: Record<string, unknown> = { engine: engineName }
  await openDoc(page)
  const panelBefore = await commentsPanelShown(page)

  // 1. Create: pinned, editing, focused, panel untouched, mark active.
  const bravo = await wordPoint(page, 1)
  assert(bravo, 'BRAVO is on screen')
  await page.mouse.dblclick(bravo.x, bravo.y)
  await page.waitForTimeout(150)
  await page.keyboard.press(`${mod}+Shift+Period`)
  await page.waitForTimeout(500)
  const created = await popovers(page)
  const createdMarks = await marks(page)
  log.created = { popovers: created, marks: createdMarks, panelBefore, panelAfter: await commentsPanelShown(page) }
  assert(createdMarks.length === 1, `one comment mark after creating (${createdMarks.length})`)
  const id = createdMarks[0]!.id
  assert(created.length === 1, `one popover after creating (${created.length})`)
  assert(created[0]!.id === id, 'the popover is the new comment')
  assert(created[0]!.mode === 'pinned', `the new comment's popover is pinned (${created[0]!.mode})`)
  assert(created[0]!.editing, 'the new comment opens in edit mode')
  assert(created[0]!.textareaFocused, 'the textarea has focus, ready to type')
  assert(createdMarks[0]!.active, 'the new comment is painted active')
  assert(!(await commentsPanelShown(page)) || panelBefore, 'creating a comment did not open the Comments panel')

  // 2. Type and save.
  await page.keyboard.type('a note on bravo')
  await page.keyboard.press(`${mod}+Enter`)
  await page.waitForTimeout(400)
  const saved = await popovers(page)
  log.saved = saved
  assert(saved.length === 1, 'still pinned after saving')
  assert(!saved[0]!.editing, 'saving leaves edit mode')
  assert(saved[0]!.text === 'a note on bravo', `the popover shows the note (${saved[0]!.text})`)

  // 3. Close: the comment stays. The pointer is still resting on the mark from
  // the double-click, where a peek is correct, so move it off first.
  await page.mouse.move(bravo.x, bravo.y + 200, { steps: 4 })
  await closePinned(page, id)
  log.closed = { popovers: await popovers(page), marks: await marks(page) }
  assert((await popovers(page)).length === 0, `closing removes the popover (${JSON.stringify(log.closed)})`)
  assert((await marks(page)).length === 1, 'closing a comment with text keeps it')

  // 4. Hover peeks.
  const mark = await wordPoint(page, 1)
  assert(mark, 'the mark is on screen')
  await page.mouse.move(mark.x, mark.y, { steps: 4 })
  await page.waitForTimeout(300)
  const peek = await popovers(page)
  log.peek = peek
  assert(peek.length === 1 && peek[0]!.mode === 'peek', `hover shows a peek (${JSON.stringify(peek)})`)
  assert(peek[0]!.text === 'a note on bravo', 'the peek shows the note')
  await page.mouse.move(mark.x, mark.y + 200, { steps: 4 })
  await page.waitForTimeout(300)
  assert((await popovers(page)).length === 0, 'moving away hides the peek')

  // 5. Click pins.
  await page.mouse.click(mark.x, mark.y)
  await page.waitForTimeout(300)
  const clicked = await popovers(page)
  log.clicked = clicked
  assert(clicked.length === 1 && clicked[0]!.mode === 'pinned', `a click pins (${JSON.stringify(clicked)})`)
  await closePinned(page, id)

  // 6. An abandoned new comment leaves nothing behind.
  const charlie = await wordPoint(page, 2)
  assert(charlie, 'CHARLIE is on screen')
  await page.mouse.dblclick(charlie.x, charlie.y)
  await page.waitForTimeout(150)
  await page.keyboard.press(`${mod}+Shift+Period`)
  await page.waitForTimeout(500)
  const abandonedMarks = await marks(page)
  assert(abandonedMarks.length === 2, `a second mark after the second comment (${abandonedMarks.length})`)
  const abandonedId = abandonedMarks.find(m => m.id !== id)!.id
  await closePinned(page, abandonedId)
  const after = await marks(page)
  log.abandoned = after
  assert(after.length === 1 ? after[0]!.id === id : false, `closing an empty new comment removes its mark (${JSON.stringify(after)})`)

  console.log(JSON.stringify(log, null, 2))
  console.log('\nA new comment opens pinned in edit mode; hover peeks, click pins, an empty one is discarded.')
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
