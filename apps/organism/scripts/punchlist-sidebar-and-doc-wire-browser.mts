/**
 * punchlist-sidebar-and-doc-wire-browser.mts — REAL-CELL + REAL-CHROMIUM proof
 * of two things no unit test in this repo can see.
 *
 * Two punchlist items, neither of which I am allowed to "fix" from reading:
 *
 *   (A) SIDEBAR SCROLL. Reported as "might still be broken" and never
 *       reproduced. `.sections` already carries `flex:1 1 auto; min-height:0;
 *       overflow:auto`, and every ancestor in `index.html` already carries
 *       `min-height:0`, so the code READS correct. That is exactly the state
 *       in which a dead rule and a working one are indistinguishable — so
 *       this boots the REAL production page against a REAL cell holding
 *       enough documents to overflow, and measures scrollHeight, clientHeight
 *       and whether scrollTop actually MOVES.
 *
 *   (B) DOC-LEVEL WIRE FANOUT. Block-level bubbles work (shipped d5fce23).
 *       A wire with no `localBlockId` had nowhere to appear at all: seeded one
 *       of each, the running app rendered one gutter bubble and no trace of the
 *       second. The bubble now lives on the pane header's status dot — cloud-1's
 *       info-bar indicator, which was never retired. This seeds exactly one of
 *       each wire and measures both treatments side by side, so the doc-level
 *       one is always checked against a live block-level positive.
 *
 * BOTH failures were invisible to the test suite and stayed that way for
 * weeks, for the same reason: happy-dom applies no CSS and computes no layout,
 * so a unit test can prove a rule was written and be structurally blind to
 * whether anything matches it or whether a document-level rule beats it. The
 * sidebar's `overflow: auto` existed, was correct, and did nothing. That is
 * what this file is for — it measures the rendered box, not the source.
 *
 * It prints its measurements AND asserts them. The printing is not decoration:
 * when this fails, the numbers next to the failure are what say whether the
 * scroll container lost its bound or the rows simply stopped arriving.
 *
 *   pnpm -C apps/organism run test:punchlist-browser
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'
import { build, createServer, preview } from 'vite'
import { resolveGardendBin, spawnGardend, type GardendCell } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loopbackPath = resolve(appDir, '.gardend-loopback.json')
const port = Number(process.env.SHRUBBERY_PUNCHLIST_PROBE_PORT ?? 5247)
const headed = process.env.SHRUBBERY_HEADED === '1'
/**
 * SHRUBBERY_BROWSER_ENGINE=webkit runs this against WebKit instead of Chromium.
 *
 * Not decoration: the packaged Garden is Tauri, and Tauri on macOS is WKWebView
 * — WebKit, not Chromium. A layout that behaves in Chromium and not in the
 * shipped app is a layout that was never tested where it runs.
 */
const engineName = process.env.SHRUBBERY_BROWSER_ENGINE ?? 'chromium'
if (engineName !== 'chromium' && engineName !== 'webkit') {
  throw new Error('SHRUBBERY_BROWSER_ENGINE must be chromium or webkit')
}
const engine = engineName === 'webkit' ? webkit : chromium
/** Default matches a MacBook Pro's logical viewport, not a 1280x900 guess. */
const viewport = {
  width: Number(process.env.SHRUBBERY_VIEWPORT_W ?? 1512),
  height: Number(process.env.SHRUBBERY_VIEWPORT_H ?? 944),
}

const GRAPH_ID = 'punchlist-sidebar-doc-wire-probe'
const FILLER_COUNT = 60
const WIRE_DOC = 'probe-wire-source'
/**
 * SIX document-level wires, three out and three in.
 *
 * Three was not enough and one was actively misleading. `computeNodes` changes
 * shape at n > 4 (ellipse mode, a wider spread, a radius that grows with n), so
 * a three-wire fixture never exercises the geometry a real document reaches;
 * and the incoming direction matters because the rule that decides what is
 * document-level reads both lists. A fan is a thing you can only test with a
 * fan.
 */
/**
 * SHRUBBERY_DOC_WIRE_COUNT sizes the fan. Six is the floor that reaches ellipse
 * mode; it is NOT the worst case a real document reaches. `default_x1` has
 * documents carrying TWELVE document-level wires, and `computeNodes` grows its
 * vertical radius with n (`ry = 220 + n * 28`), so a twelve-wire fan sweeps an
 * arc far taller than the viewport from an anchor sitting ~70px below its top.
 * Everything above the fold clamps to `top: 8`. A fixture pinned at six can
 * never see that, which is why this is a knob and why the run below sweeps it.
 */
const DOC_WIRE_COUNT = Number(process.env.SHRUBBERY_DOC_WIRE_COUNT ?? 6)
if (!Number.isInteger(DOC_WIRE_COUNT) || DOC_WIRE_COUNT < 2) {
  throw new Error('SHRUBBERY_DOC_WIRE_COUNT must be an integer >= 2')
}
const OUTGOING_COUNT = Math.ceil(DOC_WIRE_COUNT / 2)
const label = (index: number): string => String(index + 1).padStart(2, '0')
const WIRE_TARGETS = Array.from({ length: DOC_WIRE_COUNT }, (_unused, index) =>
  index < OUTGOING_COUNT
    ? `probe-wire-target-${label(index)}`
    : `probe-wire-source-${label(index)}`)
const OUTGOING_TARGETS = WIRE_TARGETS.slice(0, OUTGOING_COUNT)
const INCOMING_SOURCES = WIRE_TARGETS.slice(OUTGOING_COUNT)
const WIRE_TARGET = WIRE_TARGETS[0]

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`punchlist-sidebar-and-doc-wire-browser assertion failed: ${message}`)
}

let cell: GardendCell | null = null
let server: Awaited<ReturnType<typeof createServer>> | null = null
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

try {
  const bin = resolveGardendBin()
  if (!existsSync(bin)) throw new Error(`no gardend binary at ${bin}`)
  cell = await spawnGardend({ bin, readyTimeoutMs: 30_000 })
  console.log(`[probe] cell ready at ${cell.apiUrl}`)

  const mcp = new LoopbackMcpClient({
    mcpUrl: cell.mcpUrl,
    healthUrl: `${cell.apiUrl}/health`,
    token: cell.token,
    origin: 'http://127.0.0.1',
  })
  const call = (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    mcp.callTool(name, args) as Promise<Record<string, unknown>>

  await call('create_graph', { graph_id: GRAPH_ID, title: 'punchlist probe' })

  // (A)'s fixture: far more rows than a 900px viewport can hold.
  for (let index = 0; index < FILLER_COUNT; index += 1) {
    await call('create_document', {
      graphId: GRAPH_ID,
      documentId: `probe-filler-${String(index).padStart(2, '0')}`,
      title: `Filler document ${String(index).padStart(2, '0')}`,
    })
  }
  console.log(`[probe] ${FILLER_COUNT} filler documents created`)

  // (B)'s fixture: one block-level wire and one document-level wire, so the
  // two treatments can be compared side by side in one document.
  await call('create_document', { graphId: GRAPH_ID, documentId: WIRE_DOC, title: 'Wire source — probe' })
  /**
   * A document LONG ENOUGH TO SCROLL, with the wired block far down it.
   *
   * The first version of this fixture was four paragraphs. It never scrolled,
   * the wired block was always near the top of the viewport, and the fan
   * therefore always opened from an anchor a few dozen pixels below the pane
   * header — the one position where a mistake in the overlay's coordinate space
   * is invisible, because the anchor and the viewport origin nearly coincide.
   * Every real document in `default_x1` is long and read scrolled. The reported
   * symptom is a block fan opening "in the top left corner instead of by the
   * block", which is exactly what a coordinate-space error looks like once the
   * anchor moves away from the origin. So: a body that scrolls, and the wire on
   * a block deep inside it.
   */
  const BODY_PARAGRAPHS = 60
  const WIRED_PARAGRAPH_INDEX = 42
  await call('write_document', {
    graphId: GRAPH_ID,
    documentId: WIRE_DOC,
    content: [
      '<h1>Wire source</h1>',
      ...Array.from({ length: BODY_PARAGRAPHS }, (_unused, index) =>
        index === WIRED_PARAGRAPH_INDEX
          ? `<p>PARAGRAPH ${index} carries the BLOCK-level wires. It should wear a bubble, and its fan should open BESIDE IT.</p>`
          : `<p>Paragraph ${index} is body text, here to push the wired block far below the fold.</p>`),
    ].join(''),
  })
  // The far ends. The first version of this harness seeded a SINGLE
  // document-level wire and asserted nodeCount === 1 — which would have passed
  // just as happily against a fan that renders only its first node.
  for (const [index, target] of WIRE_TARGETS.entries()) {
    // `target.slice(-1)` was fine for six and silently collapses every title
    // past the ninth to its last digit — which would make a pile of distinct
    // cards look like duplicates in the output and send the search the wrong way.
    const name = `Wire end ${label(index)}`
    await call('create_document', { graphId: GRAPH_ID, documentId: target, title: `${name} — probe` })
    await call('write_document', {
      graphId: GRAPH_ID,
      documentId: target,
      content: `<h1>${name}</h1><p>The far end.</p>`,
    })
  }

  const payload = await call('query_blocks', { graphId: GRAPH_ID, documentId: WIRE_DOC })
  const results = (payload.results ?? []) as Record<string, unknown>[]
  const blocks = ((results[0]?.blocks ?? []) as Record<string, unknown>[])
    .map(block => String(block.block_id ?? block.blockId ?? ''))
    .filter(Boolean)
  // blocks[0] is the <h1>; body paragraphs follow it in order.
  const sourceBlockId = blocks[WIRED_PARAGRAPH_INDEX + 1] ?? blocks[1] ?? blocks[0]

  await call('create_wires', {
    graphId: GRAPH_ID,
    wires: [
      // SEVERAL block-level wires on the one block, not a single one. A
      // one-wire block fan cannot show cards stacking on each other, which is
      // half the report.
      ...OUTGOING_TARGETS.map(target => ({
        sourceDocumentId: WIRE_DOC,
        targetDocumentId: target,
        sourceBlockId,
        predicate: 'supports',
      })),
      ...OUTGOING_TARGETS.map(target => ({
        sourceDocumentId: WIRE_DOC,
        targetDocumentId: target,
        predicate: 'relatedTo',
      })),
      ...INCOMING_SOURCES.map(source => ({
        sourceDocumentId: source,
        targetDocumentId: WIRE_DOC,
        predicate: 'supports',
      })),
    ],
  })
  console.log(`[probe] wires seeded — block-level on ${sourceBlockId}, document-level beside it`)

  writeFileSync(loopbackPath, JSON.stringify({
    apiUrl: cell.apiUrl,
    mcpUrl: cell.mcpUrl,
    token: cell.token,
    port: cell.manifest.port,
    graphId: GRAPH_ID,
  }, null, 2))

  /**
   * SHRUBBERY_SERVE_BUILT=1 runs the PRODUCTION BUNDLE instead of the dev
   * server.
   *
   * The packaged Garden embeds a built bundle in its Rust binary; it never runs
   * Vite. Dev and build are not the same page: Vite dev injects each component's
   * styles as a separate <style> in module-evaluation order, and the build
   * concatenates them in Rollup's order, so two rules of EQUAL specificity can
   * resolve opposite ways between the two. This repo has already shipped one
   * bug of exactly that shape. Every browser harness here drove the dev server,
   * which made that whole class invisible to all of them at once.
   */
  const serveBuilt = process.env.SHRUBBERY_SERVE_BUILT === '1'
  if (serveBuilt) {
    console.log('[probe] building the production bundle…')
    await build({ root: appDir, configFile: resolve(appDir, 'vite.config.ts'), logLevel: 'warn' })
    server = await preview({
      root: appDir,
      configFile: resolve(appDir, 'vite.config.ts'),
      preview: { host: '127.0.0.1', port, strictPort: true },
      logLevel: 'warn',
    }) as unknown as Awaited<ReturnType<typeof createServer>>
    console.log('[probe] serving apps/organism/dist (production bundle)')
  } else {
    server = await createServer({
      root: appDir,
      configFile: resolve(appDir, 'vite.config.ts'),
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
      logLevel: 'warn',
    })
    await server.listen()
  }

  browser = await engine.launch({ headless: !headed })
  const page = await browser.newPage({ viewport })
  console.log(`[probe] ${engineName} at ${viewport.width}x${viewport.height}`)
  page.on('pageerror', error => console.error(`[pageerror] ${error.message}`))

  await page.goto(`http://127.0.0.1:${port}/g/${GRAPH_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.organismMode === 'local-cell', undefined, { timeout: 60_000 })
  await page.waitForFunction(
    () => !!document.querySelector('mn-sidebar-panel')?.shadowRoot?.querySelector('[data-file-pane-body]'),
    undefined,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(1500)

  // ── (A) SIDEBAR SCROLL ────────────────────────────────────────────────
  const sidebarBefore = await page.evaluate(() => {
    const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
    if (!panel) return { error: 'no mn-sidebar-panel' }
    const body = panel.shadowRoot?.querySelector('[data-file-pane-body]') as HTMLElement | null
    if (!body) return { error: 'no [data-file-pane-body]' }
    const rows = panel.shadowRoot?.querySelectorAll('[data-node-id]') ?? []
    const chain: Record<string, unknown>[] = []
    let node: HTMLElement | null = body
    while (node) {
      const style = getComputedStyle(node)
      chain.push({
        what: `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ').join('.')}` : ''}`,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        display: style.display,
        overflowY: style.overflowY,
        minHeight: style.minHeight,
        flex: style.flex,
        height: style.height,
      })
      const parent: HTMLElement | null = node.parentElement
      node = parent ?? ((node.getRootNode() as ShadowRoot).host as HTMLElement | null) ?? null
      if (chain.length > 12) break
    }
    return {
      presentation: body.getAttribute('data-file-pane-body'),
      rowCount: rows.length,
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      overflows: body.scrollHeight > body.clientHeight,
      chain,
    }
  })
  console.log('\n=== (A) SIDEBAR, BEFORE SCROLLING ===')
  console.log(JSON.stringify(sidebarBefore, null, 2))

  assert(!('error' in sidebarBefore), `the sidebar rendered: ${JSON.stringify(sidebarBefore)}`)
  const sidebar = sidebarBefore as Extract<typeof sidebarBefore, { rowCount: number }>
  assert(sidebar.rowCount > 40, `the fixture actually overflows the viewport: ${sidebar.rowCount} rows`)
  // THE REGRESSION, named precisely. index.html used to set display:block on
  // this element, and a document rule beats a component's own :host — so the
  // panel stopped being the flex column it declares itself to be, every child's
  // flex:1 1 auto went inert, and .sections grew to its full content height
  // inside an 830px host. Measured before the fix: clientHeight 2225,
  // scrollHeight 2225 — no overflow, therefore no scrollbar, therefore every
  // row past the fold clipped and unreachable.
  const panelBox = sidebar.chain.find((entry) => String(entry.what).startsWith('mn-sidebar-panel'))
  assert(panelBox, 'the ancestor walk reached mn-sidebar-panel')
  assert(
    panelBox!.display === 'flex',
    `mn-sidebar-panel is still the flex column it declares: display=${String(panelBox!.display)}`,
  )
  assert(
    sidebar.overflows,
    `the scroll container is BOUNDED and its content overflows it: ${sidebar.bodyClientHeight} < ${sidebar.bodyScrollHeight}`,
  )

  const scrolled = await page.evaluate(() => {
    const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
    const body = panel?.shadowRoot?.querySelector('[data-file-pane-body]') as HTMLElement | null
    if (!body) return { error: 'no body' }
    const start = body.scrollTop
    body.scrollTop = 400
    const afterProgrammatic = body.scrollTop
    return { start, afterProgrammatic, moved: afterProgrammatic !== start }
  })
  console.log('programmatic scrollTop:', JSON.stringify(scrolled))
  assert(!('error' in scrolled) && scrolled.moved, `scrollTop actually moves: ${JSON.stringify(scrolled)}`)

  // A real wheel over the real element — the affordance a human actually uses.
  const wheelResult = await (async () => {
    const box = await page.evaluate(() => {
      const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
      const body = panel?.shadowRoot?.querySelector('[data-file-pane-body]') as HTMLElement | null
      if (!body) return null
      body.scrollTop = 0
      const rect = body.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    if (!box) return { error: 'no box' }
    await page.mouse.move(box.x, box.y)
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(300)
    return page.evaluate(() => {
      const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
      const body = panel?.shadowRoot?.querySelector('[data-file-pane-body]') as HTMLElement | null
      return { scrollTopAfterWheel: body?.scrollTop ?? null }
    })
  })()
  console.log('real wheel:', JSON.stringify(wheelResult))
  // The affordance a human actually uses, not just the property a script can
  // set. A container can accept scrollTop and still swallow the wheel.
  assert(
    !('error' in wheelResult) && (wheelResult.scrollTopAfterWheel ?? 0) > 0,
    `a real wheel over the real sidebar scrolls it: ${JSON.stringify(wheelResult)}`,
  )

  // ── (B) DOC-LEVEL WIRE FANOUT ─────────────────────────────────────────
  await page.evaluate((documentId) => {
    const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
    const row = panel?.shadowRoot?.querySelector(`[data-node-id="${documentId}"]`) as HTMLElement | null
    row?.click()
  }, WIRE_DOC)
  await page.waitForTimeout(3000)

  const wireState = await page.evaluate(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    const root = host?.shadowRoot ?? null
    const mount = root?.querySelector('.editor-mount') as HTMLElement | null
    const wired = Array.from(mount?.querySelectorAll('[data-block-wired]') ?? []).map(element => ({
      tag: element.tagName.toLowerCase(),
      count: element.getAttribute('data-wire-count'),
      text: (element.textContent ?? '').slice(0, 48),
    }))
    return {
      editorHostFound: !!host,
      mountFound: !!mount,
      blocksWearingBubbles: wired,
      radialOverlayPresent: !!root?.querySelector('mn-wire-radial-overlay'),
    }
  })
  console.log('\n=== (B) WIRE SURFACES IN THE OPEN DOCUMENT ===')
  console.log(JSON.stringify(wireState, null, 2))

  // Hover the block bubble — the treatment that is supposed to work — so the
  // absence of a doc-level equivalent is measured against a live positive.
  const hoverResult = await (async () => {
    // SCROLL THE WIRED BLOCK INTO VIEW FIRST. It is paragraph 42 of 60; without
    // this it is far below the fold and `getBoundingClientRect` hands back a
    // viewport point the pointer can never occupy.
    const box = await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const element = host?.shadowRoot?.querySelector('.editor-mount [data-block-wired]') as HTMLElement | null
      if (!element) return null
      element.scrollIntoView({ block: 'center' })
      const rect = element.getBoundingClientRect()
      // `_gutterHitForEvent` measures clickX from the block's OWN left edge
      // and accepts [0, 28). Hovering `rect.left - 10` (the first draft of
      // this probe) is clickX = -10: rejected, and the absence it reported
      // was the instrument's, not the app's.
      return { x: rect.left + 8, y: rect.top + rect.height / 2, blockTop: rect.top, blockLeft: rect.left }
    })
    if (!box) return { error: 'no wired block to hover' }
    await page.mouse.move(box.x, box.y)
    await page.waitForTimeout(Number(process.env.SHRUBBERY_FAN_SETTLE_MS ?? 900))
    return page.evaluate((anchor) => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const overlay = host?.shadowRoot?.querySelector('mn-wire-radial-overlay') as HTMLElement | null
      const nodes = overlay?.shadowRoot?.querySelectorAll('[data-wire-radial-node]') ?? []
      return {
        radialOpenedOnBlockHover: !!overlay,
        // WHERE the block fan opened, which nothing measured before. Asserting
        // only that it OPENS is why "the popup shows in the top left corner
        // instead of by the block" could be true against a green harness.
        hoveredAt: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
        nodeCount: nodes.length,
        nodes: Array.from(nodes).map(node => {
          const rect = node.getBoundingClientRect()
          return {
            title: (node.querySelector('.title')?.textContent ?? '').trim().slice(0, 24),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            // Distance from the block the fan belongs to. A fan that opened in
            // the corner of the window reads as a large number here regardless
            // of how the layout got there.
            dyFromBlock: Math.round(rect.y - anchor.blockTop),
          }
        }),
      }
    }, box)
  })()
  console.log('block bubble hover:', JSON.stringify(hoverResult, null, 2))

  // The POSITIVE CONTROL. If the block-level bubble ever stops rendering or
  // stops fanning out, the doc-level assertions below would be measuring
  // against a broken baseline and their success would mean nothing.
  assert(
    wireState.blocksWearingBubbles.length === 1,
    `exactly the one wired block wears a bubble: ${JSON.stringify(wireState.blocksWearingBubbles)}`,
  )
  assert(
    wireState.blocksWearingBubbles[0]?.count === String(OUTGOING_TARGETS.length),
    `and it counts all of its block-level wires: ${JSON.stringify(wireState.blocksWearingBubbles)}`,
  )
  assert(
    'radialOpenedOnBlockHover' in hoverResult ? hoverResult.radialOpenedOnBlockHover : false,
    `hovering a block bubble opens the fan: ${JSON.stringify(hoverResult)}`,
  )

  // Close whatever the block hover opened, so the doc-level measurement below
  // cannot inherit it and report someone else's fan as its own.
  await page.mouse.move(640, 20)
  await page.waitForTimeout(800)

  const docBubble = await page.evaluate(() => {
    // PRODUCTION renders the pane header from render-workspace.ts into the
    // light DOM under #host — it does NOT mount <sh-center-panes>, which is the
    // compatibility specimen (render-path-parity.test.ts says so, and an
    // earlier draft of this harness looked only in the specimen's shadow root
    // and reported the bubble absent when it was rendering fine three inches
    // away). Look in the document first; fall back to the specimen so this
    // harness keeps working against either path.
    const specimen = document.querySelector('sh-center-panes') as HTMLElement | null
    const button = (document.querySelector('[data-pane-wire-bubble]')
      ?? specimen?.shadowRoot?.querySelector('[data-pane-wire-bubble]')) as HTMLElement | null
    const dot = button?.querySelector('.pane-position') as HTMLElement | null
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    const hitBox = button?.getBoundingClientRect()
    const dotBox = dot?.getBoundingClientRect()
    return {
      bubbleFound: !!button,
      count: button?.getAttribute('data-doc-wire-count') ?? null,
      ariaLabel: button?.getAttribute('aria-label') ?? null,
      dotWired: dot?.getAttribute('data-doc-wired') ?? null,
      // The dot stays 6px; the hit area is the button around it. Both are
      // layout facts, which is exactly what happy-dom cannot see.
      dotWidth: dotBox ? Math.round(dotBox.width) : null,
      hitWidth: hitBox ? Math.round(hitBox.width) : null,
      hitHeight: hitBox ? Math.round(hitBox.height) : null,
      ringPainted: dot ? getComputedStyle(dot).boxShadow !== 'none' : false,
      overlayOpenBeforeHover: !!host?.shadowRoot?.querySelector('mn-wire-radial-overlay'),
    }
  })
  console.log('\n=== (B2) DOC-LEVEL BUBBLE (pane header status dot) ===')
  console.log(JSON.stringify(docBubble, null, 2))

  // THE GAP THIS HARNESS EXISTS FOR. Before the fix this document rendered one
  // gutter bubble for its block wire and NOTHING for its document wire.
  assert(docBubble.bubbleFound, 'the pane header status dot became a wire bubble')
  assert(
    docBubble.count === String(DOC_WIRE_COUNT),
    `it counts every document-level wire: ${docBubble.count} of ${DOC_WIRE_COUNT}`,
  )
  assert(
    (docBubble.ariaLabel ?? '').includes(`${DOC_WIRE_COUNT} document wires`),
    `and says so: ${docBubble.ariaLabel}`,
  )
  assert(docBubble.dotWired === 'true', 'the dot itself carries the wired mark')
  // happy-dom computes no layout, so these three are the ones the unit tests
  // structurally cannot assert.
  assert(docBubble.dotWidth === 6, `the dot is still 6px, not inflated by its hit area: ${docBubble.dotWidth}`)
  assert(
    (docBubble.hitWidth ?? 0) >= 16,
    `the hit area is a real target, not a 6px one: ${docBubble.hitWidth}x${docBubble.hitHeight}`,
  )
  assert(docBubble.ringPainted, 'the wired ring is actually painted, not merely selected for')
  assert(!docBubble.overlayOpenBeforeHover, 'no fan is open yet, so the next one is ours')

  const docFan = await (async () => {
    const box = await page.evaluate(() => {
      const specimen = document.querySelector('sh-center-panes') as HTMLElement | null
      const button = (document.querySelector('[data-pane-wire-bubble]')
        ?? specimen?.shadowRoot?.querySelector('[data-pane-wire-bubble]')) as HTMLElement | null
      if (!button) return null
      const rect = button.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    if (!box) return { error: 'no doc-wire bubble to hover' }
    await page.mouse.move(box.x, box.y)
    // The cards animate in on a stagger, so a measurement taken too early
    // reports a half-scaled, half-transparent card and cannot tell "never
    // appears" from "has not appeared yet". SHRUBBERY_FAN_SETTLE_MS exists to
    // make that difference measurable rather than arguable.
    await page.waitForTimeout(Number(process.env.SHRUBBERY_FAN_SETTLE_MS ?? 500))
    return page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const overlay = host?.shadowRoot?.querySelector('mn-wire-radial-overlay') as HTMLElement | null
      const nodes = overlay?.shadowRoot?.querySelectorAll('[data-wire-radial-node]') ?? []
      const box2 = overlay?.getBoundingClientRect()
      const lines = overlay?.shadowRoot?.querySelectorAll('svg.lines line') ?? []
      return {
        fanOpened: !!overlay,
        nodeCount: nodes.length,
        lineCount: lines.length,
        // Counting nodes is not enough: they can all exist and sit on top of
        // each other, or be laid out fine and be invisible. Measure the boxes.
        nodes: Array.from(nodes).map(node => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return {
            title: (node.querySelector('.title')?.textContent ?? '').trim().slice(0, 28),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            opacity: style.opacity,
            visible: rect.width > 0 && rect.height > 0 && Number(style.opacity) > 0.05,
          }
        }),
        lines: Array.from(lines).map(line => ({
          x1: Math.round(Number(line.getAttribute('x1'))),
          y1: Math.round(Number(line.getAttribute('y1'))),
          x2: Math.round(Number(line.getAttribute('x2'))),
          y2: Math.round(Number(line.getAttribute('y2'))),
          opacity: getComputedStyle(line).opacity,
        })),
        onScreen: box2 ? box2.top >= 0 : false,
        // WHY THIS IS MEASURED. The fan is `position: fixed`, which normally
        // escapes every ancestor's `overflow: hidden`. It stops escaping the
        // moment ANY ancestor has a transform, filter, perspective, contain or
        // will-change: that ancestor becomes the containing block, and the
        // fixed layer is then clipped to it. The fan opens leftward over the
        // sidebar, so a containing ancestor at the pane would cut off every
        // card except the one or two nearest the anchor — which is exactly what
        // "it shows just the first wire and none of the others" looks like.
        // Reported whether or not it is happening here, because absence is the
        // finding that sends the search elsewhere.
        containingAncestors: (() => {
          const found: Array<Record<string, string>> = []
          let node: Element | null = overlay
          while (node) {
            const style = getComputedStyle(node)
            const reasons: string[] = []
            if (style.transform !== 'none') reasons.push(`transform:${style.transform}`)
            if (style.filter !== 'none') reasons.push(`filter:${style.filter}`)
            if (style.perspective !== 'none') reasons.push(`perspective:${style.perspective}`)
            if (style.contain !== 'none' && style.contain !== '') reasons.push(`contain:${style.contain}`)
            if (style.willChange !== 'auto' && style.willChange !== '') reasons.push(`will-change:${style.willChange}`)
            if (reasons.length > 0) {
              found.push({
                what: `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ')[0]}` : ''}`,
                why: reasons.join(' '),
                overflow: style.overflow,
              })
            }
            const parent: Element | null = node.parentElement
            node = parent ?? ((node.getRootNode() as ShadowRoot).host ?? null)
          }
          return found
        })(),
      }
    })
  })()
  console.log('doc bubble hover:', JSON.stringify(docFan))

  assert('fanOpened' in docFan ? docFan.fanOpened : false, `hovering the doc bubble opens a fan: ${JSON.stringify(docFan)}`)
  const fan = docFan as Extract<typeof docFan, { nodeCount: number }>
  // SIX nodes, not seven: the document-level fan holds the document-level
  // wires and not the block-level one beside it. A fan showing everything
  // would make the two treatments indistinguishable.
  assert(
    fan.nodeCount === DOC_WIRE_COUNT,
    `the fan holds every document-level wire and not the block-level one beside it: ${fan.nodeCount} of ${DOC_WIRE_COUNT}`,
  )
  // ...and every one of them is actually on screen with real size. Counting
  // DOM nodes proves nothing about whether a person can see them.
  const invisible = fan.nodes.filter(node => !node.visible)
  assert(invisible.length === 0, `every node is visible: ${JSON.stringify(invisible)}`)
  // No two stacked on top of each other — a fan whose nodes share a position
  // reads as a single card.
  const positions = new Set(fan.nodes.map(node => `${node.x},${node.y}`))
  assert(
    positions.size === fan.nodes.length,
    `no two nodes share a position: ${JSON.stringify(fan.nodes.map(n => [n.x, n.y]))}`,
  )
  // AND FAR ENOUGH APART TO READ AS SEPARATE CARDS. The check above compares
  // coordinates exactly, so two cards a single pixel apart — 247 of their 248
  // columns painted one on top of the other — pass it while reading to a person
  // as one card.
  //
  // This does NOT forbid overlap. Overlap is the design: cloud-1's own source
  // says "Overlaps are acceptable — they reward exploration", and a densely
  // wired document is meant to produce a longer, tighter, more crowded fan. The
  // failure is cards CONVERGING — landing on the same point because each was
  // clamped into the frame separately, which turns a fan into a pile. So the
  // measure is separation, not area.
  const MIN_SEPARATION = 24
  const converged: Array<Record<string, unknown>> = []
  for (let i = 0; i < fan.nodes.length; i += 1) {
    for (let j = i + 1; j < fan.nodes.length; j += 1) {
      const a = fan.nodes[i]!
      const b = fan.nodes[j]!
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (distance < MIN_SEPARATION) {
        converged.push({ a: a.title, b: b.title, at: [a.x, a.y], and: [b.x, b.y], distance: Math.round(distance) })
      }
    }
  }
  const separations = fan.nodes.flatMap((node, index) =>
    fan.nodes.slice(index + 1).map(other => Math.round(Math.hypot(node.x - other.x, node.y - other.y))))
  console.log('closest separation:', separations.length > 0 ? Math.min(...separations) : 'n/a')
  assert(
    converged.length === 0,
    `no two cards converge on the same point (min ${MIN_SEPARATION}px apart): ${JSON.stringify(converged)}`,
  )
  // The fan may run past the frame horizontally — it opens sideways, and
  // holding it to one side is what lets the pointer dismiss it by moving to the
  // other. Vertically it may not: a card above or below the fold cannot be read
  // or clicked.
  const offFrame = fan.nodes.filter(node => node.y < 0 || node.y + node.h > viewport.height)
  assert(
    offFrame.length === 0,
    `every card sits within the frame vertically: ${JSON.stringify(offFrame)}`,
  )
  assert(fan.lineCount === DOC_WIRE_COUNT, `one connector line per node: ${fan.lineCount}`)

  // ── (C) THE FAN INSIDE A CAPTURED FIXED LAYER ─────────────────────────
  //
  // Everything above measures a page where `position: fixed` means the window,
  // because nothing in this fixture captures the fixed layer. That is the ONE
  // condition under which the old layout was correct, and it is the condition
  // every harness in this repo happened to run in -- so the failure below could
  // not be seen from here no matter how many engines or bundles it was run
  // against.
  //
  // A single `transform` on any ancestor makes that ancestor the containing
  // block for a fixed descendant. `.root` then covers the PANE instead of the
  // window, while the layout was reading `globalThis.innerWidth/innerHeight`:
  // cards were placed for a frame far larger than the one holding them, so
  // everything past the real edge clamped onto the same corner and stacked,
  // and the connector lines -- drawn from a viewport anchor into the pane's
  // coordinate space -- pointed off at where the cards should have been. That
  // is the reported symptom, exactly: one card in the corner, lines fanning out
  // past it.
  //
  // This does not claim the shipped app has such an ancestor. It makes the
  // component correct whether or not it does, and proves it here rather than
  // arguing about it.
  await page.mouse.move(640, 20)
  await page.waitForTimeout(700)
  const capturedFrame = await (async () => {
    const applied = await page.evaluate(() => {
      // The editor host's own parent, whatever it is called. An earlier draft
      // named `#mn-main-editor` (mount.ts's canonical center anchor) and found
      // nothing -- production does not render through that anchor, which is
      // also why this page exposes no `role="main"` landmark at all. Walking up
      // from the host is the version that cannot go stale.
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const pane = host?.parentElement as HTMLElement | null
      if (!pane) return null
      pane.style.transform = 'translateZ(0)'
      const rect = pane.getBoundingClientRect()
      return {
        capturedBy: `${pane.tagName.toLowerCase()}${pane.id ? `#${pane.id}` : ''}${pane.className ? `.${String(pane.className).split(' ')[0]}` : ''}`,
        paneBox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      }
    })
    if (!applied) return { error: 'no parent of sh-editor-host to capture the fixed layer with' }
    const box = await page.evaluate(() => {
      const button = (document.querySelector('[data-pane-wire-bubble]')
        ?? (document.querySelector('sh-center-panes') as HTMLElement | null)
          ?.shadowRoot?.querySelector('[data-pane-wire-bubble]')) as HTMLElement | null
      if (!button) return null
      const rect = button.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    if (!box) return { error: 'no doc-wire bubble after capturing the fixed layer' }
    await page.mouse.move(box.x, box.y)
    await page.waitForTimeout(Number(process.env.SHRUBBERY_FAN_SETTLE_MS ?? 900))
    const measured = await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      const overlay = host?.shadowRoot?.querySelector('mn-wire-radial-overlay') as HTMLElement | null
      const root = overlay?.shadowRoot?.querySelector('.root') as HTMLElement | null
      const rootBox = root?.getBoundingClientRect()
      const nodes = overlay?.shadowRoot?.querySelectorAll('[data-wire-radial-node]') ?? []
      return {
        fanOpened: !!overlay,
        // The proof that the fixed layer really was captured: if `.root` still
        // measures the whole window, this section tested nothing.
        rootBox: rootBox
          ? { x: Math.round(rootBox.x), y: Math.round(rootBox.y), w: Math.round(rootBox.width), h: Math.round(rootBox.height) }
          : null,
        nodes: Array.from(nodes).map(node => {
          const rect = node.getBoundingClientRect()
          return { title: (node.querySelector('.title')?.textContent ?? '').trim().slice(0, 20), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
        }),
      }
    })
    return { ...applied, ...measured }
  })()
  console.log('\n=== (C) FAN INSIDE A CAPTURED FIXED LAYER ===')
  console.log(JSON.stringify(capturedFrame, null, 2))

  assert(!('error' in capturedFrame), `the capture fixture applied: ${JSON.stringify(capturedFrame)}`)
  const captured = capturedFrame as Extract<typeof capturedFrame, { nodes: unknown[] }>
  assert(captured.fanOpened, 'the fan still opens inside a captured fixed layer')
  assert(
    !!captured.rootBox && captured.rootBox.h < captured.viewport.h,
    `the fixture really did capture the fixed layer -- .root is the pane, not the window: ${JSON.stringify(captured.rootBox)}`,
  )
  assert(
    captured.nodes.length === DOC_WIRE_COUNT,
    `every wire still has a card: ${captured.nodes.length} of ${DOC_WIRE_COUNT}`,
  )
  // THE ASSERTION. Cards must lie inside the box that actually holds them --
  // not inside the window, which is what the old layout aimed at.
  const escaped = captured.nodes.filter(node =>
    node.x < captured.rootBox!.x - 1
    || node.y < captured.rootBox!.y - 1
    || node.x + node.w > captured.rootBox!.x + captured.rootBox!.w + 1
    || node.y + node.h > captured.rootBox!.y + captured.rootBox!.h + 1)
  assert(
    escaped.length === 0,
    `no card is laid out beyond the frame that contains it: ${JSON.stringify(escaped)}`,
  )
  const capturedConverged: Array<Record<string, unknown>> = []
  for (let i = 0; i < captured.nodes.length; i += 1) {
    for (let j = i + 1; j < captured.nodes.length; j += 1) {
      const a = captured.nodes[i]!
      const b = captured.nodes[j]!
      if (Math.hypot(a.x - b.x, a.y - b.y) < MIN_SEPARATION) {
        capturedConverged.push({ a: a.title, b: b.title, at: [a.x, a.y], and: [b.x, b.y] })
      }
    }
  }
  assert(
    capturedConverged.length === 0,
    `and no two cards converge inside a captured frame either: ${JSON.stringify(capturedConverged)}`,
  )

  // A picture of the fan while it is open, for the one question measurement
  // cannot settle: whether it LOOKS right where it opens. SHRUBBERY_SHOT=<path>
  // only; the assertions above are what this harness is for.
  const shot = process.env.SHRUBBERY_SHOT
  if (shot) {
    await page.screenshot({ path: shot })
    console.log(`screenshot: ${shot}`)
  }

  if (headed) await page.waitForTimeout(600_000)
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
