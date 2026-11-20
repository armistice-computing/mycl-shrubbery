/**
 * Native workspace catalog — gardend's own graphs, projected for the picker.
 *
 * The hosted lane carries roles, tenancy, cell lifecycle states, and an
 * offline mirror whose graph create/delete intents must survive a round trip
 * through a gateway that may be unreachable. gardend has none of that: one
 * local owner, one profile directory, graphs that are simply there or
 * tombstoned. So this module is the entire difference between the two lanes —
 * a projection, not a second workspace registry.
 *
 * The picker component is shared, so the projection speaks the hosted shape;
 * `owner`/`running` are the honest constants for a single-owner local node,
 * not placeholders standing in for a role system that hasn't shipped.
 */
import type { GraphCatalogEntry } from './gardend-contract.js'
import type { GatewayGraphInfo } from './gateway-transport.js'

/** gardend's tombstone marker; every other status is a live graph. */
const ACTIVE_STATUS = 'active'

/**
 * Project gardend's `list_graphs` catalog into picker rows.
 *
 * The status filter is a SECOND line, not the first: `list_graphs_service`
 * already reads profile records with `include_deleted: false`, so a live cell
 * never sends a tombstone here. It stays because the same reader takes
 * `include_deleted: true` one argument away, and a tombstone that reached the
 * picker would be worse than invisible — boot's own selection
 * (`selectTauriGraphId`) filters on `active`, so the row would offer a graph
 * that a reload would refuse to restore.
 */
export function nativeWorkspaceGraphs(
  entries: readonly GraphCatalogEntry[],
): readonly GatewayGraphInfo[] {
  return entries
    .filter(entry => entry.status === ACTIVE_STATUS)
    .map(entry => ({
      graphId: entry.graph_id,
      title: entry.title.trim() || entry.graph_id,
      role: 'owner' as const,
      cellState: 'running' as const,
    }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.graphId.localeCompare(b.graphId))
}
