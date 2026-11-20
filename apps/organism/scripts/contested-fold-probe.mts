/**
 * contested-fold-probe.mts — CAN a single-owner offline cell ever produce a
 * contested object?
 *
 * The question behind it is the lost-race dialog (`resolution-flow.ts`'s
 * `showLostRaceDialog`). Its whole chain — bottom-bar contested badge →
 * contested centre route → resolve → rejected `stale_sync_conflict` → dialog —
 * hangs off ONE number: `bundle.conflicts.length` in `source_pull`'s response
 * (`source-mirror.ts:2050`). If gardend's fold never produces a conflict on a
 * one-owner node, the whole route is dormant and the dialog is unreachable.
 *
 * Reading the fold gets you this far (garden 85461b2, source_sync.rs):
 *   - `fold_current_objects` walks candidates by `base_version`; a conflict
 *     needs TWO candidates sharing one base (`siblings.len() > 1`, :1039).
 *   - `deterministic_candidate` (:897) auto-resolves ONLY `causalLww` (with a
 *     complete clock) and `evidenceWeighted` (with no tie). Every other
 *     strategy returns `(0, false)` — never auto-resolved.
 *   - and every class in every shipped vocab pack is one of those others:
 *     147 codeBacked, 4 producerDirected, 1 contested. Zero causalLww.
 *
 * So the fold has no auto-resolution path at all, and the only gate left is
 * whether two candidates can share a base_version. The CLIENT computes it
 * (`offline-tool-mutations.ts:530`, `currentBaseVersion(context.bundle, …)`),
 * so two mirrors holding the same bundle would compute the same base.
 *
 * That is a claim about a code path, and code paths lie. This pushes the two
 * candidates directly and asks the cell.
 *
 * Run:  pnpm -C apps/organism exec tsx scripts/contested-fold-probe.mts
 */

import { spawnGardend } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

const GRAPH_ID = `contested-fold-${Date.now()}`

// The cell is acquired INSIDE the try/finally, not before it. `spawnGardend`
// hands back a live process holding a rocksdb lock on a mkdtemp profile
// (spawn-gardend.ts:117-131), and `new LoopbackMcpClient` can throw on its own
// (loopback-mcp.ts:122, no fetch available). Constructing either outside the
// safety net means a throw between them orphans a gardend with nothing left
// holding a handle to kill it — and an orphaned cell is silent, so the next
// probe fails for a reason that has nothing to do with what it is measuring.
// (Cost of learning this the other way: a stale gardend found at pid 36960.)
let cell: Awaited<ReturnType<typeof spawnGardend>> | null = null
let contested = 0

let mcp: LoopbackMcpClient

const call = (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  mcp.callTool(name, args) as Promise<Record<string, unknown>>

function summarize(label: string, bundle: Record<string, unknown>): unknown[] {
  const conflicts = (bundle.conflicts ?? []) as unknown[]
  const current = (bundle.currentState ?? []) as unknown[]
  console.log(
    `${label.padEnd(38)} conflicts=${String(conflicts.length).padEnd(3)}` +
      ` currentState=${current.length}`,
  )
  return conflicts
}

try {
  cell = await spawnGardend()
  mcp = new LoopbackMcpClient({
    mcpUrl: cell.mcpUrl,
    healthUrl: `${cell.apiUrl}/health`,
    token: cell.token,
    origin: 'http://127.0.0.1',
  })

  await call('create_graph', { graph_id: GRAPH_ID, title: 'Contested fold probe' })

  const first = await call('source_pull', { graphId: GRAPH_ID })
  const incarnation = String(first.graphIncarnation ?? '')
  summarize('baseline (empty graph)', first)

  // Which vocabularies does this cell actually serve, and how does it class
  // them? Printed rather than assumed — the registry is the authority on what
  // a valid (vocab, class) pair is, not the golden files on disk.
  const registry = (first.sourceRegistry ?? []) as Record<string, unknown>[]
  const currentStateClasses = registry.filter(entry => entry.sourceKind === 'current-state')
  console.log(`\nsourceRegistry: ${registry.length} entries, ${currentStateClasses.length} current-state`)
  for (const entry of currentStateClasses.slice(0, 8)) {
    console.log(`  ${String(entry.vocab)} / ${String(entry.class)}  -> ${String(entry.sourceKind)}`)
  }

  const target = currentStateClasses[0]
  if (!target) {
    console.log('\nNO current-state classes served — the fold has nothing to fold.')
  } else {
    const vocab = String(target.vocab)
    const className = String(target.class)
    const objectId = 'probe-object-1'
    console.log(`\npushing TWO candidates for ${vocab}/${className}#${objectId}, both baseVersion="root"\n`)

    const candidate = (n: number) => ({
      kind: 'currentState',
      operationId: `probe-op-${n}`,
      vocab,
      class: className,
      objectId,
      baseVersion: 'root',
      record: { kind: className, localId: objectId, title: `Candidate ${n}`, url: `https://example.invalid/candidate-${n}` },
      causalOrder: 1_700_000_000_000 + n,
      clientId: `probe-client-${n}`,
    })

    const push = await call('source_push', {
      graphId: GRAPH_ID,
      graphIncarnation: incarnation,
      operations: [candidate(1), candidate(2)],
    })
    console.log('push receipts:', JSON.stringify(push.receipts ?? push).slice(0, 400), '\n')

    const after = await call('source_pull', { graphId: GRAPH_ID })
    const conflicts = summarize('after two same-base candidates', after)
    contested = conflicts.length
    if (contested > 0) {
      console.log('\nCONFLICT SHAPE:\n', JSON.stringify(conflicts[0], null, 2).slice(0, 900))
    }
  }
} finally {
  await cell?.kill()
  console.log('\ncell down')
}

// THIS PROBE CAN FAIL, and that is the point. A version that only printed the
// number would report `conflicts=0` and exit clean if gardend's fold ever
// started auto-resolving these — the exact regression this script exists to
// notice, reported as a quiet success. A measurement you cannot fail is a
// sentence you like.
if (contested === 0) {
  console.error(
    '\nFAILED: two candidates on one base produced NO conflict.\n'
      + 'Either the fold changed (check deterministic_candidate, source_sync.rs:897,\n'
      + 'and the reconciliation_strategy on the class this probe picked), or the push\n'
      + 'was rejected upstream. Read the receipts above before believing the fold.',
  )
  process.exitCode = 1
}
