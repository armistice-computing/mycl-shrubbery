/**
 * imported-graph-new-document-browser.mts — reproduce the cutover failure.
 *
 * THE REPORT, first full switch-over test, against the real cloud-1 export of
 * `default` (1136 documents, 1.27M triples): making a new document shows
 * "Offline cache cannot be safely fenced" at the top of the document, then a
 * "Default workspace" notice, then the workspace goes blank.
 *
 * FOUR THEORIES DIED BEFORE THIS FILE EXISTED, each from reading code:
 *
 *   - the cell is not minting document incarnations → it mints them fine, with
 *     and without a UX config (incarnation-header-probe.mts)
 *   - a proxy strips the incarnation headers → both reach the page intact
 *     (incarnation-header-browser.mts)
 *   - the importer never writes an incarnation sidecar → `ensure_document_
 *     incarnation_id` mints one lazily on the blob route
 *   - an imported graph has no graph incarnation → `ensure_graph_incarnation`
 *     mints that lazily too
 *
 * What none of those probes had was HER GRAPH. Every fixture in this repo tops
 * out at sixty documents created by `create_document`; hers is a thousand-plus
 * arriving through the archive importer. So this one imports the real archive
 * through the real `POST /graphs/import`, waits for the job, boots the real
 * page, and creates a document the way a person does.
 *
 *   SHRUBBERY_ARCHIVE=/path/to/graph-export.tar.gz \
 *     pnpm -C apps/organism run test:imported-graph
 *
 * It reports rather than asserts. The failure is not yet understood, and a
 * script that stops at the first surprise would hide the rest of them.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReadStream, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { resolveGardendBin, spawnGardend, type GardendCell } from '../src/cell/spawn-gardend.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loopbackPath = resolve(appDir, '.gardend-loopback.json')
const port = Number(process.env.SHRUBBERY_IMPORTED_PORT ?? 5255)
const headed = process.env.SHRUBBERY_HEADED === '1'
const archivePath = process.env.SHRUBBERY_ARCHIVE
if (!archivePath) throw new Error('Set SHRUBBERY_ARCHIVE to a graph export (.tar.gz).')
const GRAPH_ID = process.env.SHRUBBERY_IMPORTED_GRAPH ?? 'imported-default'
/**
 * A PERSISTENT profile directory, not the usual fresh mkdtemp.
 *
 * Importing this archive takes 27 minutes (measured: 1611s for 1136 documents
 * and 1.27M triples). A throwaway profile would charge that to every iteration,
 * which in practice means the investigation gets one attempt per half hour and
 * every instrument bug costs a full cycle. `spawnGardend` never deletes a
 * caller-supplied profileDir, so the import survives to the next run and
 * SHRUBBERY_REIMPORT=1 is the way to start clean.
 */
const profileDir = process.env.SHRUBBERY_PROFILE
  ?? resolve(appDir, '.gardend-imported-profile')
const forceReimport = process.env.SHRUBBERY_REIMPORT === '1'

let cell: GardendCell | null = null
let server: Awaited<ReturnType<typeof createServer>> | null = null
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

try {
  const sizeMb = existsSync(archivePath) ? (statSync(archivePath).size / 1_048_576).toFixed(1) : '—'
  const bin = resolveGardendBin()
  if (!existsSync(bin)) throw new Error(`no gardend binary at ${bin}`)
  cell = await spawnGardend({ bin, readyTimeoutMs: 30_000, profileDir })
  console.log(`[repro] cell at ${cell.apiUrl} · profile ${profileDir}`)

  const auth = { Authorization: `Bearer ${cell.token}`, Origin: 'http://127.0.0.1' }

  /**
   * `GET /graphs` is itself an ASYNC job: it answers 202 with a job envelope
   * and a `result_url`, not a list. The first two drafts of this script looked
   * for the graph id in that envelope and concluded the import had failed —
   * twice, against an import that had in fact succeeded. Follow the result.
   */
  async function graphIds(): Promise<string[]> {
    const response = await fetch(`${cell!.apiUrl}/graphs`, { headers: auth })
    if (!response.ok) return []
    const body = await response.text()
    let envelope: Record<string, unknown> = {}
    try { envelope = JSON.parse(body) as Record<string, unknown> } catch { return [] }
    const resultUrl = typeof envelope.result_url === 'string' ? envelope.result_url : null
    const payload = resultUrl
      ? await (await fetch(`${cell!.apiUrl}${resultUrl}`, { headers: auth })).text()
      : body
    const ids: string[] = []
    for (const match of payload.matchAll(/"graph_id"\s*:\s*"([^"]+)"/g)) ids.push(match[1])
    for (const match of payload.matchAll(/"graphId"\s*:\s*"([^"]+)"/g)) ids.push(match[1])
    for (const match of payload.matchAll(/"id"\s*:\s*"([^"]+)"/g)) ids.push(match[1])
    return [...new Set(ids)]
  }

  const alreadyThere = await graphIds()
  console.log(`[repro] graphs already in this profile: ${JSON.stringify(alreadyThere)}`)
  const needsImport = forceReimport || !alreadyThere.includes(GRAPH_ID)
  if (!needsImport) console.log(`[repro] "${GRAPH_ID}" already imported — reusing it (SHRUBBERY_REIMPORT=1 to redo)`)

  if (needsImport) {
    // ── import the real archive through the real route ────────────────────
    const form = new FormData()
    const bytes = await new Response(createReadStream(archivePath) as unknown as ReadableStream).arrayBuffer()
    form.set('file', new Blob([bytes], { type: 'application/gzip' }), 'graph-export.tar.gz')
    form.set('newGraphId', GRAPH_ID)
    form.set('newTitle', 'imported default')

    const started = Date.now()
    const accepted = await fetch(`${cell.apiUrl}/graphs/import`, { method: 'POST', headers: auth, body: form })
    const acceptedBody = await accepted.text()
    console.log(`[repro] POST /graphs/import -> ${accepted.status} ${acceptedBody.slice(0, 300)}`)
    if (!accepted.ok) throw new Error(`import refused: ${accepted.status} ${acceptedBody}`)

    // ── wait for the job, reporting as it goes ────────────────────────────
    const jobId = (() => {
      try {
        const parsed = JSON.parse(acceptedBody) as Record<string, unknown>
        const record = (parsed.job ?? parsed.record ?? parsed) as Record<string, unknown>
        return String(record.id ?? record.job_id ?? record.jobId ?? '')
      } catch { return '' }
    })()
    console.log(`[repro] job id: ${jobId || '(none in body — polling the graph list instead)'}`)

    // Poll the JOB, not the graph list. The first draft of this script watched
    // /graphs for the new id and gave up after eight minutes — which cannot tell
    // "still working" from "failed and will never appear", and the failure mode
    // being investigated is precisely one where something does not finish. The
    // job endpoint is the authoritative signal and carries the error text.
    let jobState = 'unknown'
    let lastPrinted = ''
    for (let attempt = 0; attempt < 900; attempt += 1) {
      await new Promise(resolve_ => setTimeout(resolve_, 2000))
      const status = await fetch(`${cell.apiUrl}/graphs/jobs/${jobId}`, { headers: auth })
      if (!status.ok) {
        console.log(`[repro] job status -> HTTP ${status.status}`)
        continue
      }
      const body = await status.text()
      let record: Record<string, unknown> = {}
      try { record = JSON.parse(body) as Record<string, unknown> } catch { /* print raw below */ }
      jobState = String(record.status ?? 'unknown')
      const line = `${jobState} ${String(record.message ?? record.detail_message ?? '')}`.trim()
      if (line !== lastPrinted) {
        console.log(`[repro] ${((Date.now() - started) / 1000).toFixed(0)}s  job: ${line}`)
        lastPrinted = line
      }
      if (jobState === 'succeeded' || jobState === 'complete' || jobState === 'completed') break
      if (jobState === 'failed' || jobState === 'error') {
        console.log(`\n[repro] IMPORT JOB FAILED — this is the finding, not a step on the way to it:`)
        console.log(body.slice(0, 4000))
        break
      }
    }
    console.log(`[repro] job finished in state "${jobState}" after ${((Date.now() - started) / 1000).toFixed(0)}s`)

    const listed = await graphIds()
    console.log(`[repro] graphs after import: ${JSON.stringify(listed)}`)
    if (!listed.includes(GRAPH_ID)) {
      throw new Error(`the imported graph is not listed — nothing to open in the browser`)
    }
  }

  // Let the projection settle: the import lands CRDT blobs and RDF, and the
  // workspace projection is materialized behind it.
  await new Promise(resolve_ => setTimeout(resolve_, 15_000))

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

  browser = await chromium.launch({ headless: !headed })
  const page = await browser.newPage({ viewport: { width: 1512, height: 944 } })
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const badResponses: string[] = []
  const badResponseBodies: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error => pageErrors.push(error.message))
  // `/cell/mcp` is one URL for every tool call, so a bare status+url line
  // cannot say WHICH call failed. Capture the request body's method/tool name
  // alongside it — five anonymous 503s tell you nothing; five 503s on
  // `create_document` tell you everything.
  // Passthrough diagnostics (Gamma, gamma/local-never-enrolls): every
  // document-blob / websocket-adjacent exchange, regardless of status. The
  // activation permit lives or dies on the blob GET, and the line that actually
  // PROVES the fix is the websocket opening with the same incarnation the blob
  // returned — client and cell agreeing on one id, which is the race closed.
  const blobTrace: string[] = []
  page.on('response', response => {
    const url = response.url()
    if (/\/cell\/documents\/|\/hocuspocus\//.test(url)) {
      const ct = response.headers()['content-type'] ?? ''
      const inc = response.headers()['x-document-incarnation'] ?? response.headers()['x-graph-incarnation'] ?? ''
      blobTrace.push(`${new Date().toISOString().slice(11, 23)} ${response.status()} ${url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')} ct=${ct.slice(0, 30)} inc=${inc.slice(0, 8)}`)
    }
  })
  page.on('websocket', ws => {
    blobTrace.push(`${new Date().toISOString().slice(11, 23)} WS ${ws.url().replace(/^ws:\/\/127\.0\.0\.1:\d+/, '').slice(0, 120)}`)
    ws.on('close', () => blobTrace.push(`${new Date().toISOString().slice(11, 23)} WS closed ${ws.url().slice(-60)}`))
  })
  page.on('response', response => {
    if (response.status() < 400) return
    let what = ''
    try {
      const body = response.request().postData() ?? ''
      const tool = /"name"\s*:\s*"([^"]+)"/.exec(body)?.[1]
      const method = /"method"\s*:\s*"([^"]+)"/.exec(body)?.[1]
      what = tool ? ` tool=${tool}` : method ? ` method=${method}` : ''
    } catch { /* a body we cannot read is still worth the status line */ }
    badResponses.push(`${response.status()} ${response.url()}${what}`)
    // The BODY distinguishes a cell that refused from a PROXY that could not
    // find one. `scripts/vite-cell-proxy.ts` answers 503 with
    // loopback_manifest_missing / loopback_manifest_invalid when it cannot
    // resolve .gardend-loopback.json — which would make these 503s an artifact
    // of this harness rather than anything the app does wrong. Status alone
    // cannot tell those apart, and reporting the wrong one wastes her day.
    void response.text().then(text => {
      const reason = /"(?:error|reason)"\s*:\s*"([^"]+)"/.exec(text)?.[1]
      badResponseBodies.push(`${response.status()}${what} -> ${reason ?? text.slice(0, 160)}`)
    }).catch(() => undefined)
  })

  await page.goto(`http://127.0.0.1:${port}/g/${GRAPH_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.organismMode === 'local-cell', undefined, { timeout: 120_000 })
  await page.waitForTimeout(8000)

  const afterLoad = await page.evaluate(() => {
    const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
    const rows = panel?.shadowRoot?.querySelectorAll('[data-node-id]') ?? []
    return {
      sidebarRows: rows.length,
      host: document.querySelector('#host')?.childElementCount ?? 0,
      hasWorkspaceSurface: !!document.querySelector('sh-workspace-surface'),
      editorHosts: document.querySelectorAll('sh-editor-host').length,
    }
  })
  console.log('\n=== AFTER LOAD ===')
  console.log(JSON.stringify(afterLoad, null, 2))

  // ── the act that fails: make a new document ───────────────────────────
  const created = await page.evaluate(() => {
    const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
    // The real affordance: the sidebar header's "+" (mn-sidebar-panel.ts, the
    // createDocument capability), identified by its aria-label because it has
    // no data hook of its own.
    const button = panel?.shadowRoot?.querySelector('[aria-label="New document"]') as HTMLElement | null
    if (button) { button.click(); return 'sidebar "New document" button' }
    return 'no create affordance found'
  })
  console.log(`\n[repro] create document via: ${created}`)
  await page.waitForTimeout(1500)

  // The "+" only OPENS a naming dialog — the first run of this script stopped
  // there and reported "nothing happened", which was the script not finishing
  // the job a person finishes. Type a name and confirm.
  const dialogResult = await page.evaluate(async () => {
    const dialog = document.querySelector('mn-input-dialog') as (HTMLElement & { updateComplete?: Promise<unknown> }) | null
    if (!dialog) return 'no mn-input-dialog on the page'
    await dialog.updateComplete
    const input = dialog.shadowRoot?.querySelector('input') as HTMLInputElement | null
    if (!input) return 'dialog present but no input — it may not be open'
    input.focus()
    input.value = `Cutover probe ${new Date().toISOString().slice(11, 19)}`
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    await dialog.updateComplete
    const confirm = dialog.shadowRoot?.querySelector('.confirm-button') as HTMLButtonElement | null
    if (!confirm) return 'no confirm button'
    if (confirm.disabled) return 'confirm button is disabled'
    confirm.click()
    return `confirmed with "${input.value}"`
  })
  console.log(`[repro] dialog: ${dialogResult}`)
  // Badge timeline: does the permit settle, and when?
  const badgeTimeline: string[] = []
  for (let elapsed = 0; elapsed <= 45_000; elapsed += 3_000) {
    const badge = await page.evaluate(() => {
      const editor = document.querySelector('sh-editor-host') as HTMLElement | null
      const toolbar = editor?.shadowRoot?.querySelector('mn-editor-toolbar') as HTMLElement | null
      const badge = toolbar?.shadowRoot?.querySelector('[data-read-only-badge]') as HTMLElement | null
      return badge?.textContent?.trim() ?? null
    })
    badgeTimeline.push(`${elapsed / 1000}s: ${badge}`)
    if (badge === null && elapsed >= 6_000) break
    await page.waitForTimeout(3_000)
  }
  console.log('\n=== BADGE TIMELINE ===')
  for (const line of badgeTimeline) console.log(`  ${line}`)
  console.log('\n=== BLOB / WS TRACE ===')
  for (const line of blobTrace.slice(-30)) console.log(`  ${line}`)

  const afterCreate = await page.evaluate(() => {
    const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
    const rows = panel?.shadowRoot?.querySelectorAll('[data-node-id]') ?? []
    const editor = document.querySelector('sh-editor-host') as HTMLElement | null
    const toolbar = editor?.shadowRoot?.querySelector('mn-editor-toolbar') as HTMLElement | null
    const badge = toolbar?.shadowRoot?.querySelector('[data-read-only-badge]') as HTMLElement | null
    const toast = document.querySelector('mn-toast[data-default-workspace-notice]') as HTMLElement | null
    return {
      sidebarRows: rows.length,
      hasWorkspaceSurface: !!document.querySelector('sh-workspace-surface'),
      editorHosts: document.querySelectorAll('sh-editor-host').length,
      readOnlyBadge: badge?.textContent?.trim() ?? null,
      // The exact string in the report: "Offline cache cannot be safely fenced".
      activationConflict: toolbar?.getAttribute('data-activation-conflict') ?? null,
      documentTitle: (document.querySelector('.surface-pane-header .pane-title') as HTMLElement | null)
        ?.textContent?.trim() ?? null,
      defaultWorkspaceNotice: !!toast,
      hostChildren: document.querySelector('#host')?.childElementCount ?? 0,
    }
  })
  console.log('\n=== AFTER CREATE ===')
  console.log(JSON.stringify(afterCreate, null, 2))

  console.log('\n=== NOISE ===')
  console.log(`pageerrors (${pageErrors.length}):`)
  for (const error of pageErrors.slice(0, 12)) console.log(`  ${error}`)
  console.log(`console errors (${consoleErrors.length}):`)
  for (const error of consoleErrors.slice(0, 20)) console.log(`  ${error}`)
  console.log(`>=400 responses (${badResponses.length}):`)
  for (const response of badResponses.slice(0, 20)) console.log(`  ${response}`)
  console.log(`>=400 reasons (${badResponseBodies.length}):`)
  for (const reason of [...new Set(badResponseBodies)].slice(0, 12)) console.log(`  ${reason}`)

  const shot = process.env.SHRUBBERY_SHOT
  if (shot) {
    await page.screenshot({ path: shot, fullPage: false })
    console.log(`\nscreenshot: ${shot}`)
  }
  if (headed) await page.waitForTimeout(600_000)
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
