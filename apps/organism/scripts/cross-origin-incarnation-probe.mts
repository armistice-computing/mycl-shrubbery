/**
 * cross-origin-incarnation-probe.mts — can a CROSS-ORIGIN caller read the fence?
 *
 * THE BUG THIS EXISTS FOR, and the reason it hid for three days.
 *
 * `quarantine('unfenced')` — "Offline cache cannot be safely fenced" — fires
 * when a document snapshot reports no incarnation. The cell always SENDS
 * `x-document-incarnation`. But a browser hides every non-safelisted response
 * header from script unless the server names it in
 * `Access-Control-Expose-Headers`, and `CorsLayer::very_permissive()` names
 * none. The packaged desktop app fetches the loopback CROSS-ORIGIN
 * (tauri://localhost → 127.0.0.1), so the header was sent on every response and
 * never visible to the page.
 *
 * EVERY EXISTING TEST MISSED IT, INCLUDING THE ONE WRITTEN FOR IT.
 * `incarnation-header-browser.mts` was built to catch exactly this class — its
 * own comment names Access-Control-Expose-Headers as the signature to look for
 * — and it asks the question through the Vite dev proxy, which serves /cell/*
 * from the page's OWN origin, where the expose rule does not apply. The right
 * check in the wrong context passes forever.
 *
 * So this one asks from off-origin, where the answer differs. It needs no
 * browser: `access-control-expose-headers` is on the wire, and a plain fetch
 * carrying an `Origin` reproduces exactly what the webview is told.
 *
 *   pnpm -C apps/organism run test:cross-origin-headers
 */
import { existsSync } from 'node:fs'
import { resolveGardendBin, spawnGardend, type GardendCell } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

/** What the packaged app's webview actually sends. */
const DESKTOP_ORIGIN = 'tauri://localhost'
/** Every response header the desktop frontend reads off a response. */
const REQUIRED = ['x-document-incarnation', 'x-graph-incarnation', 'x-next-since']

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`cross-origin-incarnation-probe assertion failed: ${message}`)
}

let cell: GardendCell | null = null

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
  await mcp.toolsCall('create_graph', { graph_id: 'cors-probe', title: 'cors probe' })
  await mcp.toolsCall('create_document', { graphId: 'cors-probe', documentId: 'cors-doc', title: 'Doc' })

  const response = await fetch(`${cell.apiUrl}/documents/cors-probe/cors-doc/blob`, {
    headers: { Authorization: `Bearer ${cell.token}`, Origin: DESKTOP_ORIGIN },
  })
  assert(response.ok, `the blob is readable: HTTP ${response.status}`)

  const allowOrigin = response.headers.get('access-control-allow-origin')
  const exposed = (response.headers.get('access-control-expose-headers') ?? '')
    .split(',').map(name => name.trim().toLowerCase()).filter(Boolean)
  const incarnation = response.headers.get('x-document-incarnation')

  console.log(`origin sent            : ${DESKTOP_ORIGIN}`)
  console.log(`access-control-allow-origin  : ${allowOrigin}`)
  console.log(`access-control-expose-headers: ${exposed.join(', ') || '(NONE — script sees no custom header)'}`)
  console.log(`x-document-incarnation       : ${incarnation}`)

  assert(allowOrigin, 'the cell answers a cross-origin request at all')
  assert(incarnation, 'the incarnation is ON THE WIRE (it always was — that was never the bug)')

  // The assertion that matters. Without these names, script reads null, every
  // snapshot looks unfenceable, and the third document click quarantines.
  const missing = REQUIRED.filter(name => !exposed.includes(name))
  assert(
    missing.length === 0,
    `every header the frontend reads is exposed to cross-origin script; missing: ${missing.join(', ')}`,
  )

  console.log('\nA cross-origin caller can read the fence. The desktop webview will see it.')
} finally {
  await cell?.kill()
}
