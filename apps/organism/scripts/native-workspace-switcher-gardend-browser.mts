/**
 * Real Chromium + real gardend proof for the NATIVE workspace switcher.
 *
 * This exists because the switcher's whole failure mode is silence. The host
 * bound the picker's props behind `deploymentConfig.mode === 'hosted'`, so on
 * a local node the top bar simply never received them: no error, no warning,
 * every unit test green, and the only way to find out was to look at Garden
 * and notice the graph name was not a menu. Component tests cannot see this —
 * they mount `mn-workspace-selector` with a fixture and it works perfectly.
 *
 * So the assertions here are deliberately about the SEAM, not the component:
 *
 *   1. booting a local cell binds the picker at all (the original bug);
 *   2. every local graph is listed, including ones Shrubbery never opened;
 *   3. selecting one really re-points the session AND the address bar, so a
 *      reload does not silently return to the graph the user left;
 *   4. a graph with no `:ux:config` — an archive import, a bare MCP
 *      `create_graph` — is seeded on the way in, because the live config read
 *      has NO fallback and would otherwise land on the error panel;
 *   5. deleting the ACTIVE graph retires it and lands somewhere real.
 *
 * Run: pnpm test:native-workspace-switcher-browser   (SHRUBBERY_HEADED=1 to watch)
 */

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import {
  createGraphAndSeedUxConfig,
  resolveGardendBin,
  spawnGardend,
  type GardendCell,
} from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'
import { uxConfigGraphIri } from '@shrubbery/nucleus'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loopbackPath = join(appDir, '.gardend-loopback.json')
const port = Number(process.env.SHRUBBERY_NATIVE_WORKSPACE_SWITCHER_PORT ?? 5231)
const headed = process.env.SHRUBBERY_HEADED === '1'
const require_ = createRequire(import.meta.url)
const nucleusEntry = require_.resolve('@shrubbery/nucleus')
const seedPath = resolve(dirname(nucleusEntry), 'workspace/__generated__/garden-default.ux.nt')

const ALPHA = { graphId: 'native-switcher-alpha', title: 'Alpha Garden' }
const BETA = { graphId: 'native-switcher-beta', title: 'Beta Garden' }
/** Created WITHOUT a `:ux:config`, standing in for a graph gardend acquired
 *  outside Shrubbery — the archive imports that produced the real ghosts. */
const GHOST = { graphId: 'native-switcher-ghost', title: 'Ghost Garden' }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`native-workspace-switcher assertion failed: ${message}`)
}

/**
 * The picker lives two shadow roots deep — `mn-top-bar` renders
 * `mn-workspace-selector` inside its own shadow root, and the selector's
 * controls are inside that element's. `document.querySelector` crosses
 * neither, so every page-side read here walks the boundaries explicitly
 * rather than pretending the DOM is flat.
 */
const SELECTOR_ROOT = `document.querySelector('mn-top-bar')?.shadowRoot
  ?.querySelector('mn-workspace-selector')?.shadowRoot ?? null`

function inSelector<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(() => { const root = ${SELECTOR_ROOT}; ${body} })()`) as Promise<T>
}

/** The picker's trigger label — what the top bar shows where the graph
 *  breadcrumb used to be. `''` when the picker was never bound at all. */
async function triggerLabel(page: Page): Promise<string> {
  return inSelector<string>(page, `
    return root?.querySelector('.trigger-label')?.textContent?.trim() ?? ''
  `)
}

async function waitForTriggerLabel(page: Page, expected: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let latest = ''
  while (Date.now() < deadline) {
    latest = await triggerLabel(page)
    if (latest === expected) return
    await page.waitForTimeout(100)
  }
  throw new Error(`workspace trigger label never became "${expected}"; last="${latest}"`)
}

async function openMenu(page: Page): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await inSelector<boolean>(page, `return Boolean(root?.querySelector('.menu'))`)) return
    await inSelector<void>(page, `root?.querySelector('.trigger')?.click()`)
    await page.waitForTimeout(100)
  }
  throw new Error('the workspace menu never opened')
}

async function listedGraphIds(page: Page): Promise<readonly string[]> {
  return inSelector<readonly string[]>(page, `
    return Array.from(root?.querySelectorAll('.row') ?? []).map(row => row.dataset.graphId ?? '')
  `)
}

/** Click a control on one row. The selector re-renders on every state change,
 *  so resolve and click in a single evaluated tick to avoid a stale handle. */
async function clickRowControl(
  page: Page,
  graphId: string,
  control: '.select' | '.more' | '[data-action="delete"]',
): Promise<void> {
  const scope = control === '[data-action="delete"]' ? '.action-menu' : '.row'
  const clicked = await inSelector<boolean>(page, `
    const scope = Array.from(root?.querySelectorAll(${JSON.stringify(scope)}) ?? [])
      .find(node => node.dataset.graphId === ${JSON.stringify(graphId)})
    const button = scope?.querySelector(${JSON.stringify(control)})
    if (!button || button.disabled) return false
    button.click()
    return true
  `)
  assert(clicked, `clicked ${control} for ${graphId}`)
}

async function confirmDialog(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const dialog = document.querySelector('mn-confirmation-dialog')
    return Boolean(dialog?.shadowRoot?.querySelector('.confirm-button'))
  }, undefined, { timeout: 10_000 })
  await page.evaluate(() => {
    const dialog = document.querySelector('mn-confirmation-dialog')
    dialog?.shadowRoot?.querySelector<HTMLButtonElement>('.confirm-button')?.click()
  })
}

/**
 * The size of a graph's own `:ux:config`, read the same way the shell reads it.
 *
 * Deliberately `rdf_dump` and not a SPARQL `GRAPH <…>` count: gardend's
 * external SPARQL route does not expose the ux-config named graph, so that
 * query returns 0 for a graph that is definitely seeded — a false negative
 * that would make this whole assertion meaningless.
 */
async function uxConfigSize(mcp: LoopbackMcpClient, graphId: string): Promise<number> {
  const result = await mcp.toolsCall('rdf_dump', {
    graphId,
    format: 'application/n-triples',
    sourceGraphIri: uxConfigGraphIri(graphId),
  }) as { content?: ReadonlyArray<{ text?: string }> }
  const envelope = JSON.parse(result.content?.[0]?.text ?? '{}') as { data?: string }
  return (envelope.data ?? '').trim().length
}

function urlGraph(page: Page): string {
  return new URL(page.url()).searchParams.get('graph') ?? ''
}

async function main(): Promise<void> {
  const gardenBin = resolveGardendBin()
  if (!existsSync(gardenBin)) {
    throw new Error(`gardend binary not found at ${gardenBin}; set GARDEN_BIN to override.`)
  }

  let cell: GardendCell | undefined
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  const pageErrors: string[] = []

  try {
    cell = await spawnGardend()
    const seed = readFileSync(seedPath, 'utf8')
    await createGraphAndSeedUxConfig(cell, ALPHA.graphId, seed, ALPHA.title)
    await createGraphAndSeedUxConfig(cell, BETA.graphId, seed, BETA.title)

    // Deliberately NOT seeded: this is the graph whose :ux:config the switch
    // itself has to provide.
    const mcp = new LoopbackMcpClient({
      mcpUrl: cell.mcpUrl,
      healthUrl: `${cell.apiUrl}/health`,
      token: cell.token,
      origin: 'http://127.0.0.1',
    })
    await mcp.toolsCall('create_graph', { graph_id: GHOST.graphId, title: GHOST.title })

    writeFileSync(loopbackPath, JSON.stringify({
      apiUrl: cell.apiUrl,
      mcpUrl: cell.mcpUrl,
      token: cell.token,
      port: cell.manifest.port,
      graphId: ALPHA.graphId,
    }, null, 2))

    server = await createServer({
      root: appDir,
      configFile: resolve(appDir, 'vite.config.ts'),
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
      logLevel: 'warn',
    })
    await server.listen()

    browser = await chromium.launch({ headless: !headed })
    context = await browser.newContext({ viewport: { width: 1440, height: 920 } })
    const page = await context.newPage()
    await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }))
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message))

    await page.goto(
      `http://127.0.0.1:${port}/?source=cell&graph=${encodeURIComponent(ALPHA.graphId)}`,
      { waitUntil: 'domcontentloaded' },
    )

    // 1 + 2. The picker is bound on a local node, and lists every local graph.
    await waitForTriggerLabel(page, ALPHA.title)
    await openMenu(page)
    const listed = await listedGraphIds(page)
    for (const graph of [ALPHA, BETA, GHOST]) {
      assert(listed.includes(graph.graphId), `picker lists ${graph.graphId}; got ${JSON.stringify(listed)}`)
    }

    // 3 + 4. Switching into an UNSEEDED graph renders a real workspace rather
    // than the no-fallback config error, and the address bar follows.
    await clickRowControl(page, GHOST.graphId, '.select')
    await waitForTriggerLabel(page, GHOST.title)
    await page.locator('mn-sidebar-panel').waitFor({ state: 'attached', timeout: 30_000 })
    assert(
      urlGraph(page) === GHOST.graphId,
      `address bar follows the switch; got "${urlGraph(page)}"`,
    )
    // The decisive check. A stale workspace survives a failed config read
    // (renderCellState refuses to clobber a live one), so "the sidebar is
    // still there" proves nothing — read the graph's OWN :ux:config instead.
    // Control first: if a graph we seeded ourselves reads as empty, the probe
    // is broken and the real assertion below would be worthless.
    assert(
      await uxConfigSize(mcp, ALPHA.graphId) > 0,
      'the ux-config probe sees a graph that was seeded up front',
    )
    const ghostUxSize = await uxConfigSize(mcp, GHOST.graphId)
    assert(
      ghostUxSize > 0,
      `switching into an unseeded graph seeds its :ux:config; got ${ghostUxSize} bytes`,
    )

    // 5. Deleting the ACTIVE graph retires it and lands somewhere real.
    await openMenu(page)
    await clickRowControl(page, GHOST.graphId, '.more')
    await clickRowControl(page, GHOST.graphId, '[data-action="delete"]')
    await confirmDialog(page)

    const deadline = Date.now() + 30_000
    let remaining: readonly string[] = []
    let landedOn = ''
    while (Date.now() < deadline) {
      landedOn = await triggerLabel(page)
      if (landedOn === ALPHA.title || landedOn === BETA.title) break
      await page.waitForTimeout(150)
    }
    assert(
      landedOn === ALPHA.title || landedOn === BETA.title,
      `deleting the active graph lands on a remaining workspace; got "${landedOn}"`,
    )
    await openMenu(page)
    remaining = await listedGraphIds(page)
    assert(
      !remaining.includes(GHOST.graphId),
      `the retired graph leaves the picker; got ${JSON.stringify(remaining)}`,
    )

    assert(pageErrors.length === 0, `no page errors: ${pageErrors.join('\n')}`)
    // eslint-disable-next-line no-console
    console.log(`native workspace switcher OK — listed ${listed.length}, landed on "${landedOn}"`)
  } finally {
    await context?.close()
    await browser?.close()
    await server?.close()
    if (cell) await cell.kill()
    if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
  }
}

await main()
