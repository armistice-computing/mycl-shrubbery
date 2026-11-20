/**
 * recents-surfaces-browser.mts — do Cmd-O and an empty split pane show what
 * was opened and created recently?
 *
 * ASKED (Eschaton, 2026-10-16): Cmd-O "shows all documents by alphabetical"
 * when nothing is typed; an empty split pane should show "recently created
 * and recently opened instead of just saying open document here".
 *
 * Four documents are created in order (ALPHA, BRAVO, CHARLIE, DELTA), then
 * ALPHA and CHARLIE are opened. A-Z would read ALPHA BRAVO CHARLIE DELTA.
 * Expected:
 *   1. Cmd-O with no query lists CHARLIE, ALPHA (opened, newest first), then
 *      DELTA, BRAVO (the rest, newest created first).
 *   2. Split view's empty pane lists Recently opened and Recently created,
 *      and clicking BRAVO opens it in that pane.
 *
 * A gardend without the activity routes (older than garden cb51242) answers
 * 404, and the order comes from this browser's own record: the fallback the
 * installed app runs on until it is rebuilt.
 *
 *   pnpm -C apps/organism run test:recents-surfaces
 *   SHRUBBERY_BROWSER_ENGINE=webkit pnpm -C apps/organism run test:recents-surfaces
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
const port = Number(process.env.SHRUBBERY_RECENTS_PORT ?? 5279)
const engineName = process.env.SHRUBBERY_BROWSER_ENGINE ?? 'chromium'
if (engineName !== 'chromium' && engineName !== 'webkit') {
  throw new Error('SHRUBBERY_BROWSER_ENGINE must be chromium or webkit')
}
const engine = engineName === 'webkit' ? webkit : chromium
const GRAPH_ID = 'recents-probe'
const DOCS = ['alpha-doc', 'bravo-doc', 'charlie-doc', 'delta-doc'] as const

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`recents-surfaces-browser assertion failed: ${message}`)
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
  await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'recents probe' })
  for (const [index, documentId] of DOCS.entries()) {
    const title = documentId.split('-')[0]!.toUpperCase()
    await mcp.toolsCall('create_document', { graphId: GRAPH_ID, documentId, title })
    await mcp.toolsCall('write_document', { graphId: GRAPH_ID, documentId, content: `<p>${title} body ${index}.</p>` })
    // Distinct creation times, oldest first.
    await new Promise(r => setTimeout(r, 1100))
  }
  const activityProbe = await fetch(`${cell.apiUrl}/activity/${GRAPH_ID}/recent`, {
    headers: { Authorization: `Bearer ${cell.token}` },
  })
  console.log(`gardend activity routes: ${activityProbe.status === 404 ? 'absent (fallback path)' : `present (${activityProbe.status})`}`)

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

  const failures: string[] = []

  // 1. Cmd-O, nothing typed.
  await page.keyboard.press('ControlOrMeta+o')
  await page.waitForFunction(() => {
    const el = document.querySelector('mn-document-switcher') as (HTMLElement & { open?: boolean }) | null
    return !!el?.open && (el.shadowRoot?.querySelectorAll('[data-item-id]').length ?? 0) >= 4
  }, undefined, { timeout: 10_000 })
  const switcherOrder = await page.evaluate(() =>
    [...(document.querySelector('mn-document-switcher')?.shadowRoot?.querySelectorAll('[data-item-id]') ?? [])]
      .map(row => row.getAttribute('data-item-id')))
  console.log('Cmd-O, empty query:', switcherOrder)
  const probeOrder = switcherOrder.filter(id => (DOCS as readonly string[]).includes(id ?? ''))
  if (probeOrder.join() !== 'charlie-doc,alpha-doc,delta-doc,bravo-doc') {
    failures.push(`Cmd-O listed ${probeOrder.join(', ')}, not charlie-doc, alpha-doc, delta-doc, bravo-doc`)
  }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // 2. Split view: the new pane is empty and offers both lists.
  // The pane header's split button (headless WebKit does not deliver the
  // Mod+Shift+\ chord to the shell's keymap).
  await page.locator('[data-split-command]').first().click()
  const split = await page.waitForFunction(() => !!document.querySelector('[data-pane-home] .empty-recents'), undefined, { timeout: 10_000 })
    .then(() => true).catch(() => false)
  if (!split) {
    console.log('after the split shortcut:', await page.evaluate(() => ({
      panes: [...document.querySelectorAll('[data-pane-stage]')].map(stage => stage.getAttribute('data-pane-stage')),
      home: document.querySelector('[data-pane-home]')?.outerHTML.slice(0, 400) ?? null,
    })))
    throw new Error('split view showed no empty pane with recent lists')
  }
  const lists = await page.evaluate(() => {
    // No named helper in here: tsx wraps named functions in __name(), which
    // does not exist in the page.
    const empty = document.querySelector('[data-pane-home]')!
    const [opened, created] = ['opened', 'created'].map(kind =>
      [...empty.querySelectorAll(`[data-empty-recent="${kind}"] .empty-recent`)]
        .map(button => button.getAttribute('data-document-id')))
    return { pane: empty.getAttribute('data-pane-home'), opened: opened!, created: created! }
  })
  console.log('empty pane:', JSON.stringify(lists))
  if (lists.opened.slice(0, 2).join() !== 'charlie-doc,alpha-doc') failures.push(`Recently opened was ${lists.opened.join(', ')}`)
  if (lists.created.slice(0, 4).join() !== 'delta-doc,charlie-doc,bravo-doc,alpha-doc') failures.push(`Recently created was ${lists.created.join(', ')}`)

  await page.mouse.click(...await page.evaluate(() => {
    const button = document.querySelector('[data-pane-home] [data-empty-recent="created"] [data-document-id="bravo-doc"]') as HTMLElement
    const rect = button.getBoundingClientRect()
    return [rect.left + rect.width / 2, rect.top + rect.height / 2] as [number, number]
  }))
  const landed = await page.waitForFunction((pane) => {
    if (document.querySelector(`[data-pane-home="${pane}"]`)) return null
    const stage = document.querySelector(`[data-pane-stage="${pane}"]`)
    const host = stage?.querySelector('sh-editor-host') as HTMLElement | null
    const text = host?.shadowRoot?.querySelector('.editor-mount [contenteditable="true"]')?.textContent ?? ''
    return text.includes('BRAVO') ? text : null
  }, lists.pane, { timeout: 15_000 }).then(() => true).catch(() => false)
  if (!landed) failures.push('clicking BRAVO in the empty pane did not open it in that pane')

  assert(failures.length === 0, failures.join('; '))
  console.log(`\n${engineName}: Cmd-O and the empty pane show recent documents, and the pane opens what you pick.`)
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
