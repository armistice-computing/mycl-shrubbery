/**
 * Native Garden bootstrap for the Shrubbery organism.
 *
 * Shrubbery remains the UI authority. Garden's Tauri shell contributes only
 * the per-run loopback coordinates exposed by `get_loopback_manifest`; from
 * that point onward the existing gardend contract owns MCP, REST, and CRDT.
 */

import SEED_NT from '@shrubbery/nucleus/seed/garden-default.ux.nt?raw'
import { uxConfigGraphIri } from '@shrubbery/nucleus'
import {
  createGardendContract,
  type GardendContract,
  type GraphCatalogEntry,
} from './gardend-contract.js'
import type { LoopbackTransport } from './loopback-mcp.js'

export interface TauriLoopbackManifest {
  readonly apiUrl: string
  readonly mcpUrl: string
  readonly token: string
}

export interface TauriLocalBootstrap {
  readonly contract: GardendContract
  readonly graphId: string
  readonly seededUxConfig: boolean
}

type TauriInvoke = <T>(command: string) => Promise<T>

export function isTauriHost(root: object = globalThis): boolean {
  return '__TAURI_INTERNALS__' in root
}

export function transportFromTauriManifest(
  manifest: TauriLoopbackManifest,
): LoopbackTransport {
  const apiRoot = manifest.apiUrl.replace(/\/+$/, '')
  return {
    mcpUrl: manifest.mcpUrl,
    healthUrl: `${apiRoot}/health`,
    token: manifest.token,
    transport: 'fetch',
  }
}

/**
 * Pick the graph to open at launch. An explicit URL selection wins. Then the
 * active graph the person opened most recently (`opened`, the recency record
 * every open writes), then the last native selection, then the most recently
 * updated active graph.
 *
 * Opened time comes before the stored selection because the stored key could
 * read a stale graph while the recency record named the right one (Eschaton,
 * 2026-11-18: about one launch in four opened onboarding). Updated time comes
 * last because the node touches every graph at startup, so "most recently
 * updated" is a race between graphs, not a memory of the person.
 */
export function selectTauriGraphId(
  graphs: readonly GraphCatalogEntry[],
  requested: string | null | undefined,
  stored: string | null | undefined,
  opened: Readonly<Record<string, number>> = {},
): string | null {
  const active = graphs.filter(graph => graph.status === 'active')
  const has = (candidate: string | null | undefined): candidate is string =>
    Boolean(candidate && active.some(graph => graph.graph_id === candidate))
  if (has(requested)) return requested
  const lastOpened = active
    .filter(graph => Number.isFinite(opened[graph.graph_id]))
    .sort((a, b) => (opened[b.graph_id] ?? 0) - (opened[a.graph_id] ?? 0))[0]
  if (lastOpened) return lastOpened.graph_id
  if (has(stored)) return stored
  return [...active]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
    ?.graph_id ?? null
}

/**
 * Seed Shrubbery's default `:ux:config` into a graph that has none.
 *
 * Exported because boot is not the only moment a graph is entered for the
 * first time: switching workspaces reaches graphs gardend created outside
 * Shrubbery (an archive import, an MCP `create_graph`), and the live-config
 * read has NO fallback — an unseeded graph renders the error panel, not an
 * empty workspace. Returns whether it actually wrote a seed.
 */
export async function ensureUxConfig(
  contract: GardendContract,
  graphId: string,
): Promise<boolean> {
  const existing = await contract.restConcrete.dumpUxConfig(graphId)
  if ((existing.data ?? '').trim() !== '') return false
  await contract.mcp.toolsCall('rdf_load', {
    graphId,
    data: SEED_NT,
    format: 'application/n-triples',
    targetGraphIri: uxConfigGraphIri(graphId),
  })
  return true
}

async function resolveHealthyContract(
  invoke: TauriInvoke,
  userId: string,
): Promise<{ contract: GardendContract; manifest: TauriLoopbackManifest }> {
  let lastError: unknown = new Error('Mycl native loopback has not started')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const manifest = await invoke<TauriLoopbackManifest>('get_loopback_manifest')
      const contract = createGardendContract({
        transport: transportFromTauriManifest(manifest),
        userId,
        // The desktop app's cell is this process's neighbor: never mirror it.
        sourceMirror: 'passthrough',
      })
      if (await contract.mcp.health()) return { contract, manifest }
      lastError = new Error(`Mycl native loopback is not healthy at ${manifest.apiUrl}`)
    } catch (error) {
      lastError = error
    }
    const delayMs = Math.min(100 * (2 ** attempt), 1_000)
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  throw lastError
}

/**
 * Resolve Garden's native loopback and return the normal live-cell contract.
 * Returns null in an ordinary browser so the existing hosted/dev boot paths
 * remain unchanged.
 */
export async function bootstrapTauriLocalCell(options: {
  readonly requestedGraphId?: string | null
  readonly storedGraphId?: string | null
  /** When each graph was last opened, from the Home recency record. */
  readonly openedAt?: Readonly<Record<string, number>>
  readonly userId?: string
} = {}): Promise<TauriLocalBootstrap | null> {
  if (!isTauriHost()) return null

  const { invoke } = await import('@tauri-apps/api/core')
  // setup_core exposes the API only after replaying the durable CRDT prefix.
  // The WebView can reach its first module tick slightly earlier, and an old
  // profile may still contain the previous run's stale manifest. Require both
  // a fresh invocation and a live health response before selecting a graph.
  const { contract } = await resolveHealthyContract(
    invoke as TauriInvoke,
    options.userId ?? 'garden-native',
  )

  let catalog = await contract.restConcrete.graphs()
  let graphId = selectTauriGraphId(
    catalog.graphs,
    options.requestedGraphId,
    options.storedGraphId,
    options.openedAt,
  )
  if (!graphId) {
    graphId = 'garden'
    await contract.mcp.toolsCall('create_graph', {
      graph_id: graphId,
      title: 'Mycl',
    })
    catalog = await contract.restConcrete.graphs()
    if (!catalog.graphs.some(graph => graph.graph_id === graphId)) {
      throw new Error('Mycl native graph creation completed without cataloging the graph')
    }
  }

  const seededUxConfig = await ensureUxConfig(contract, graphId)
  return { contract, graphId, seededUxConfig }
}
