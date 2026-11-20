/**
 * incarnation-header-probe.mts — does a document snapshot carry an incarnation?
 *
 * "Offline cache cannot be safely fenced" is `quarantine('unfenced')` in
 * document-activation.ts, and it fires on exactly one condition: the snapshot
 * for this document came back with NO incarnation. The incarnation is an HTTP
 * response header, `x-document-incarnation`, minted by the cell.
 *
 * So before touching any frontend code, the question is whether the cell is
 * sending that header at all — and whether it depends on how the graph came
 * into being. This asks three graphs the same question:
 *
 *   1. a graph created by `create_graph` alone (no UX config seeded)
 *   2. a graph created AND seeded the way `gardend:dev` seeds it
 *   3. a document created in each, fresh, through the same tool the app uses
 *
 * A difference between 1 and 2 would mean the fence depends on the UX config,
 * which would be a surprise worth knowing before blaming the importer. No
 * difference, and the finding moves to how the imported graph was built.
 *
 *   pnpm -C apps/organism exec tsx scripts/incarnation-header-probe.mts
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveGardendBin, spawnGardend, createGraphAndSeedUxConfig, type GardendCell } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

let cell: GardendCell | null = null

try {
  const bin = resolveGardendBin()
  if (!existsSync(bin)) throw new Error(`no gardend binary at ${bin}`)
  cell = await spawnGardend({ bin, readyTimeoutMs: 30_000 })
  console.log(`[probe] cell at ${cell.apiUrl}`)

  const mcp = new LoopbackMcpClient({
    mcpUrl: cell.mcpUrl,
    healthUrl: `${cell.apiUrl}/health`,
    token: cell.token,
    origin: 'http://127.0.0.1',
  })

  async function report(label: string, graphId: string, documentId: string): Promise<void> {
    let snapshot: { update: Uint8Array; incarnation: string | null } | null = null
    let error: string | null = null
    try {
      snapshot = await mcp.documentSnapshot(graphId, documentId)
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    console.log(
      `  ${label.padEnd(34)} incarnation=${snapshot ? JSON.stringify(snapshot.incarnation) : '—'}`
      + ` bytes=${snapshot ? snapshot.update.byteLength : '—'}`
      + (error ? `  ERROR: ${error}` : ''),
    )
  }

  // ── (1) bare create_graph, no UX config ───────────────────────────────
  const bare = 'probe-bare-graph'
  await mcp.toolsCall('create_graph', { graph_id: bare, title: 'bare' })
  await mcp.toolsCall('create_document', { graphId: bare, documentId: 'bare-doc', title: 'Bare doc' })
  console.log('\n(1) create_graph only — no UX config:')
  await report('fresh document', bare, 'bare-doc')

  // A document that has been WRITTEN to, not merely created: the app's own
  // "new document" flow puts content in almost immediately.
  await mcp.toolsCall('write_document', {
    graphId: bare,
    documentId: 'bare-doc-written',
    content: '<h1>Written</h1><p>Body.</p>',
  }).catch(() => undefined)
  await mcp.toolsCall('create_document', { graphId: bare, documentId: 'bare-doc-written', title: 'Written doc' })
    .catch(() => undefined)
  await mcp.toolsCall('write_document', {
    graphId: bare,
    documentId: 'bare-doc-written',
    content: '<h1>Written</h1><p>Body.</p>',
  })
  await report('document with content', bare, 'bare-doc-written')

  // ── (2) the seeded shape gardend:dev produces ─────────────────────────
  const seeded = 'probe-seeded-graph'
  const require_ = createRequire(import.meta.url)
  const seedPath = resolve(dirname(require_.resolve('@shrubbery/nucleus')), 'workspace/__generated__/garden-default.ux.nt')
  await createGraphAndSeedUxConfig(cell, seeded, readFileSync(seedPath, 'utf8'), 'seeded')
  await mcp.toolsCall('create_document', { graphId: seeded, documentId: 'seeded-doc', title: 'Seeded doc' })
  console.log('\n(2) create_graph + seeded :ux:config:')
  await report('fresh document', seeded, 'seeded-doc')

  // ── (3) a document that does not exist, for the negative control ──────
  console.log('\n(3) negative control — a document that was never created:')
  await report('missing document', seeded, 'no-such-document')

  console.log(`
Read it this way:
  incarnation=null on a real document  ->  the cell is not minting the fence,
                                           and the app is right to quarantine
  incarnation="<uuid>"                 ->  the fence works here, and whatever
                                           broke is specific to how the
                                           imported graph was built
`)
} finally {
  await cell?.kill()
}
