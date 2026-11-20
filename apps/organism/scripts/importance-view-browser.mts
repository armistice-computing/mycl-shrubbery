/**
 * importance-view-browser.mts — do the importance view's value controls rate
 * the block each quote stands for?
 *
 * The view, "What Has Become Important" (gardend geist_important_blocks.rs),
 * is a read-only Geist page of copies: each quote is followed by a line whose
 * wikilink names the source document and block. Every quote shows value
 * controls (no hover), and a click must rate the SOURCE block, never the copy.
 *
 * The run, in the real app against a real gardend built with the view:
 *   1. a document with two blocks, one with an older unprefixed id
 *      ("92498883"), both valued through the agents' `value` tool;
 *   2. gardend rebuilds the view after the valuations settle;
 *   3. opening it shows controls on both entries' source lines, unrated;
 *   4. clicking the importance control on the unprefixed one rates the source
 *      block 3 in gardend, and the control turns active.
 *
 *   GARDEN_BIN=<gardend with the importance view> \
 *     SHRUBBERY_BROWSER_ENGINE=webkit pnpm -C apps/organism run test:importance-view
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
const port = 5304
const engineName = process.env.SHRUBBERY_BROWSER_ENGINE ?? 'chromium'
if (engineName !== 'chromium' && engineName !== 'webkit') {
  throw new Error('SHRUBBERY_BROWSER_ENGINE must be chromium or webkit')
}
const engine = engineName === 'webkit' ? webkit : chromium
const GRAPH_ID = 'importance-view'
const SOURCE_DOC = 'source-notes'
const VIEW_DOC = 'geist-important-blocks'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`importance-view-browser assertion failed: ${message}`)
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** The block's rating from get_block_values ({ blocks: [record] }), or null. */
function userImportanceOf(values: unknown): unknown {
  const block = (values as { blocks?: Array<Record<string, unknown>> }).blocks?.[0]
  return block?.userImportance ?? block?.user_importance ?? null
}

let cell: GardendCell | null = null
let server: Awaited<ReturnType<typeof createServer>> | null = null
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

interface ControlsView {
  readonly rows: number
  readonly quoteIds: string[]
  readonly activeFor: string[]
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
  await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'importance view' })
  await mcp.toolsCall('create_document', { graphId: GRAPH_ID, documentId: SOURCE_DOC, title: 'Source notes' })
  await mcp.toolsCall('write_document', {
    graphId: GRAPH_ID,
    documentId: SOURCE_DOC,
    format: 'xml',
    content: '<paragraph data-block-id="block-keep">The sentence that matters most.</paragraph>'
      + '<paragraph data-block-id="92498883">An older block with a bare id.</paragraph>'
      + '<paragraph data-block-id="block-pass">An ordinary line nobody valued.</paragraph>',
  })
  await mcp.toolsCall('value', { graph_id: GRAPH_ID, document_id: SOURCE_DOC, block_id: 'block-keep', importance: 5 })
  await mcp.toolsCall('value', { graph_id: GRAPH_ID, document_id: SOURCE_DOC, block_id: '92498883', importance: 4 })

  // gardend rebuilds the view after valuations settle (5 s), off the request.
  let viewXml = ''
  for (let i = 0; i < 40; i++) {
    try {
      const read = await mcp.callTool('read_document', { graphId: GRAPH_ID, documentId: VIEW_DOC, format: 'xml' }) as { content?: string }
      viewXml = read.content ?? ''
      if (viewXml.includes('An older block')) break
    } catch { /* not built yet */ }
    await sleep(500)
  }
  assert(viewXml.includes('An older block'), `gardend built the view: ${viewXml.slice(0, 300)}`)
  assert(viewXml.includes('targetBlockId="92498883"'), 'the view links the unprefixed block by its stored id')
  assert(!viewXml.includes('An ordinary line'), 'an unvalued block stays out of the view')

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
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.addInitScript('globalThis.__name = (f) => f')
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message.slice(0, 200)))
  const consoleLines: string[] = []
  page.on('console', message => consoleLines.push(`${message.type()}: ${message.text().slice(0, 200)}`))

  await page.goto(`http://127.0.0.1:${port}/g/${GRAPH_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.organismMode === 'local-cell', undefined, { timeout: 60_000 })
  await page.waitForFunction(
    (id) => !!document.querySelector('mn-sidebar-panel')?.shadowRoot?.querySelector(`[data-node-id="${id}"]`),
    VIEW_DOC,
    { timeout: 60_000 },
  )
  await page.evaluate((id) => {
    const row = document.querySelector('mn-sidebar-panel')?.shadowRoot?.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null
    row?.click()
  }, VIEW_DOC)

  const controls = (): Promise<ControlsView> => page.evaluate(() => {
    const root = (document.querySelector('sh-editor-host') as HTMLElement | null)?.shadowRoot
    const rows = Array.from(root?.querySelectorAll('.block-controls') ?? []) as HTMLElement[]
    return {
      rows: rows.length,
      quoteIds: rows.map(row => row.dataset.blockControlsFor ?? ''),
      activeFor: rows
        .filter(row => row.querySelector('[data-action="importance"].block-controls-button--active'))
        .map(row => row.dataset.blockControlsFor ?? ''),
    }
  })
  await page.waitForFunction(() => {
    const root = (document.querySelector('sh-editor-host') as HTMLElement | null)?.shadowRoot
    return (root?.querySelectorAll('.block-controls').length ?? 0) >= 2
  }, undefined, { timeout: 30_000 }).catch(async (error) => {
    const state = await page.evaluate(() => {
      const hosts = Array.from(document.querySelectorAll('sh-editor-host')) as unknown as Array<HTMLElement & { hostState?: { documentId?: string } }>
      const host = hosts[0]
      const root = host?.shadowRoot
      return {
        hosts: hosts.length,
        documentId: host?.hostState?.documentId ?? null,
        blockIds: Array.from(root?.querySelectorAll('[data-block-id]') ?? []).map(e => e.getAttribute('data-block-id')).slice(0, 8),
        wikilinks: Array.from(root?.querySelectorAll('[data-target-doc-id]') ?? []).map(e => `${e.getAttribute('data-target-doc-id')}#${e.getAttribute('data-target-block-id')}`),
        text: (root?.querySelector('.editor-mount')?.textContent ?? '').slice(0, 200),
      }
    })
    console.log('DEBUG', JSON.stringify(state, null, 1), pageErrors)
    throw error
  })
  // The source scores arrive after the controls first draw.
  await sleep(1500)
  const shownText = await page.evaluate(() =>
    (document.querySelector('sh-editor-host') as HTMLElement | null)?.shadowRoot?.querySelector('.editor-mount')?.textContent ?? '')
  assert(shownText.includes('The sentence that matters most.'), `the quotes show on screen: ${shownText.slice(0, 300)}`)
  assert(shownText.includes('An older block with a bare id.'), 'both quotes show on screen')
  const before = await controls()
  assert(before.rows === 2, `controls on both quotes: ${JSON.stringify(before)}`)
  assert(before.activeFor.length === 0, `nothing rated yet: ${JSON.stringify(before)}`)

  const shots = process.env.IMPORTANCE_VIEW_SHOTS
  if (shots) await page.screenshot({ path: `${shots}/importance-view-before.png` })

  // The quote standing for "92498883": find it by its source line's link.
  const quoteId = await page.evaluate(() => {
    const root = (document.querySelector('sh-editor-host') as HTMLElement | null)?.shadowRoot
    const link = root?.querySelector('[targetblockid="92498883"], [data-target-block-id="92498883"]') as HTMLElement | null
    const source = link?.closest('[data-block-id]')?.getAttribute('data-block-id') ?? ''
    return source
  })
  assert(/^importance-\d+-source$/.test(quoteId), `found the quote for 92498883: "${quoteId}"`)
  await page.evaluate((id) => {
    const root = (document.querySelector('sh-editor-host') as HTMLElement | null)?.shadowRoot
    const button = root?.querySelector(`[data-block-controls-for="${id}"] [data-action="importance"]`) as HTMLButtonElement | null
    button?.click()
  }, quoteId)

  let userImportance: unknown = null
  for (let i = 0; i < 20; i++) {
    userImportance = userImportanceOf(
      await mcp.callTool('get_block_values', { graph_id: GRAPH_ID, document_id: SOURCE_DOC, block_id: '92498883' }),
    )
    if (userImportance === 3) break
    await sleep(250)
  }
  assert(userImportance === 3, `the SOURCE block got the rating: ${String(userImportance)}`)
  const viewValues = await mcp.callTool('get_block_values', { graph_id: GRAPH_ID, document_id: VIEW_DOC, block_id: quoteId })
  assert(userImportanceOf(viewValues) === null, `the view's own line got no rating: ${JSON.stringify(viewValues).slice(0, 200)}`)

  await page.waitForFunction((id) => {
    const root = (document.querySelector('sh-editor-host') as HTMLElement | null)?.shadowRoot
    return !!root?.querySelector(`[data-block-controls-for="${id}"] [data-action="importance"].block-controls-button--active`)
  }, quoteId, { timeout: 10_000 })
  // The rating makes gardend rebuild the view about 5 s later. The open view
  // must take the new content and keep its controls, still showing the rating.
  await sleep(9000)
  const afterRebuild = await controls()
  assert(afterRebuild.rows === 2, `controls survive the view's rebuild: ${JSON.stringify(afterRebuild)}`)
  assert(afterRebuild.activeFor.includes(quoteId), `the rating still shows after the rebuild: ${JSON.stringify(afterRebuild)}`)
  if (shots) await page.screenshot({ path: `${shots}/importance-view-after.png` })
  assert(pageErrors.length === 0, `no page errors: ${pageErrors.join(' | ')}`)
  console.log(`importance-view-browser: OK (${engineName}) — controls on 2 quotes; ${quoteId} rated its source 92498883 = 3`)
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
