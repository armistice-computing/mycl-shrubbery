/**
 * The native workspace projection — the whole difference between gardend's
 * graph catalog and the picker the hosted lane already had.
 *
 * These are the rules a reader cannot infer from the shared component: what a
 * tombstone does, what an empty title falls back to, and why every local row
 * is an owner of a running cell.
 */
import { describe, expect, it } from 'vitest'
import { nativeWorkspaceGraphs } from '../native-workspaces.js'
import type { GraphCatalogEntry } from '../gardend-contract.js'

function entry(overrides: Partial<GraphCatalogEntry> & { graph_id: string }): GraphCatalogEntry {
  return {
    graph_uri: `urn:mnemosyne:local:graph:${overrides.graph_id}`,
    title: overrides.graph_id,
    description: null,
    status: 'active',
    created_at: '1',
    updated_at: '1',
    triple_count: null,
    last_query_at: null,
    last_update_at: null,
    role: 'owner',
    owner_user_id: 'garden-native',
    ...overrides,
  }
}

describe('nativeWorkspaceGraphs', () => {
  it('drops tombstoned graphs rather than showing them disabled', () => {
    // gardend's own boot selection filters on status === 'active'; a row the
    // picker offers but boot would never restore is a trap, not a courtesy.
    const rows = nativeWorkspaceGraphs([
      entry({ graph_id: 'live', title: 'Live' }),
      entry({ graph_id: 'ghost', title: 'Ghost', status: 'deleted' }),
    ])
    expect(rows.map(row => row.graphId)).toEqual(['live'])
  })

  it('falls back to the graph id when a graph carries no usable title', () => {
    const rows = nativeWorkspaceGraphs([entry({ graph_id: 'default_8_25_26_3', title: '   ' })])
    expect(rows[0]?.title).toBe('default_8_25_26_3')
  })

  it('reports every local graph as an owned, running workspace', () => {
    // One local owner. The catalog carries a role column for hosted shape
    // compatibility, but there is nobody here to be a viewer — so the picker
    // must never render a local row as disabled.
    const rows = nativeWorkspaceGraphs([entry({ graph_id: 'garden', role: 'viewer' })])
    expect(rows[0]).toMatchObject({ role: 'owner', cellState: 'running' })
    expect(rows[0]).not.toHaveProperty('disabled')
  })

  it('orders by title, then by id, so the list does not shuffle between reads', () => {
    const rows = nativeWorkspaceGraphs([
      entry({ graph_id: 'c', title: 'Zulu' }),
      entry({ graph_id: 'b', title: 'Alpha' }),
      entry({ graph_id: 'a', title: 'Alpha' }),
    ])
    expect(rows.map(row => row.graphId)).toEqual(['a', 'b', 'c'])
  })
})
