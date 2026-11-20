/**
 * imported-graph-readiness-probe.mts — how long is a large imported graph
 * unavailable, and what does the cell say while it is?
 *
 * Driving the real app against the real imported archive reproduced the blank
 * workspace: zero sidebar rows, no workspace surface, and twenty-six 503s on
 * `/cell/mcp` — `sparql_query`, `rdf_dump`, `list_graphs`, `source_pull`. Every
 * read the shell needs to draw a workspace, refused.
 *
 * Gardend has two router-level 503s and they mean very different things
 * (loopback_router.rs):
 *
 *   lease_terminal  the cell lost its write lease — a dead cell, retry is futile
 *   cell_draining   the cell is shutting down or not yet admitting — retry works
 *
 * The response body names which. That distinction decides whether this is "wait
 * longer" or "something is broken", so this probe reads the body rather than
 * the status, and measures how long the refusal lasts on a real boot against
 * the real imported profile.
 *
 * Requires the profile left behind by `test:imported-graph`.
 *
 *   pnpm -C apps/organism run test:imported-readiness
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolveGardendBin, spawnGardend, type GardendCell } from '../src/cell/spawn-gardend.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profileDir = process.env.SHRUBBERY_PROFILE ?? resolve(appDir, '.gardend-imported-profile')
const GRAPH_ID = process.env.SHRUBBERY_IMPORTED_GRAPH ?? 'imported-default'
const BUDGET_MS = Number(process.env.SHRUBBERY_READINESS_BUDGET_MS ?? 300_000)

let cell: GardendCell | null = null

try {
  if (!existsSync(profileDir)) {
    throw new Error(`no imported profile at ${profileDir} — run test:imported-graph first`)
  }
  const bin = resolveGardendBin()
  if (!existsSync(bin)) throw new Error(`no gardend binary at ${bin}`)

  const spawnStarted = Date.now()
  cell = await spawnGardend({ bin, readyTimeoutMs: 120_000, profileDir })
  const readyMs = Date.now() - spawnStarted
  console.log(`[readiness] /health answered after ${(readyMs / 1000).toFixed(1)}s`)
  console.log('[readiness] now asking the cell to do the work the shell asks it to do…\n')

  const auth = {
    Authorization: `Bearer ${cell.token}`,
    Origin: 'http://127.0.0.1',
    'Content-Type': 'application/json',
  }
  // The exact call the sidebar makes first: list this graph's documents.
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'sparql_query',
      arguments: {
        graphId: GRAPH_ID,
        query: 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }',
      },
    },
  })

  const started = Date.now()
  let lastReported = ''
  let readyAt: number | null = null
  while (Date.now() - started < BUDGET_MS) {
    const response = await fetch(`${cell.apiUrl}/mcp`, { method: 'POST', headers: auth, body })
    const text = await response.text()
    const elapsed = ((Date.now() - started) / 1000).toFixed(0)
    if (response.ok) {
      readyAt = Date.now() - started
      console.log(`[readiness] ${elapsed}s  200 — the cell answered a real query`)
      console.log(`[readiness] first 200 bytes: ${text.slice(0, 200)}`)
      break
    }
    // The body is the point: lease_terminal and cell_draining are different
    // diagnoses wearing the same status code.
    const reason = /"error"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? text.slice(0, 120)
    const line = `${response.status} ${reason}`
    if (line !== lastReported) {
      console.log(`[readiness] ${elapsed}s  ${line}`)
      lastReported = line
    }
    await new Promise(resolve_ => setTimeout(resolve_, 2000))
  }

  console.log('')
  if (readyAt === null) {
    console.log(`The cell NEVER became ready within ${(BUDGET_MS / 1000).toFixed(0)}s.`)
    console.log('If the reason above is "cell_draining", the shell is racing a cell that is')
    console.log('still coming up and drawing an empty workspace instead of saying so.')
  } else {
    console.log(`The cell became ready ${(readyAt / 1000).toFixed(1)}s after /health said it was up.`)
    console.log('Anything the shell asks for inside that window gets a 503 — and the workspace')
    console.log('read has no retry, so it renders empty and stays empty.')
  }
} finally {
  await cell?.kill()
}
