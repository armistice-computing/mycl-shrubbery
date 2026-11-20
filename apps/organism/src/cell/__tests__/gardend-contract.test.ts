import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'lit'
import type { MnConfirmationDialog, MnInputDialog } from '@shrubbery/components'
import {
  createGardendContract,
  GARDEN_PRESENCE_COLORS,
  parseBlockScore,
  type GraphCatalogEnvelope,
} from '../gardend-contract.js'

const graphCatalog: GraphCatalogEnvelope = {
  graphs: [
    {
      graph_uri: 'urn:mnemosyne:local:graph:garden-a',
      graph_id: 'garden-a',
      title: 'Garden A',
      description: 'A local graph',
      status: 'active',
      created_at: '1000',
      updated_at: '2000',
      triple_count: null,
      last_query_at: null,
      last_update_at: null,
      role: 'owner',
      owner_user_id: 'default',
      granted_at: '1000',
    },
  ],
  count: 1,
}

function mcpFetchFor(payload: unknown): { fetch: typeof fetch; requests: unknown[] } {
  const requests: unknown[] = []
  const fetch: typeof globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

function contractFor(fetch: typeof globalThis.fetch) {
  return createGardendContract({
    transport: {
      mcpUrl: '/cell/mcp',
      healthUrl: '/cell/health',
      fetch,
      transport: 'fetch',
    },
  })
}

afterEach(() => {
  document.querySelectorAll('mn-confirmation-dialog').forEach(element => element.remove())
  document.querySelectorAll('mn-input-dialog').forEach(element => element.remove())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('gardend contract REST graph catalog', () => {
  it('calls the real list_graphs MCP tool and preserves its hosted-compatible catalog', async () => {
    const transport = mcpFetchFor(graphCatalog)
    const contract = contractFor(transport.fetch)

    await expect(contract.rest.graphs()).resolves.toEqual(graphCatalog)
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'list_graphs', arguments: {} },
    })
  })

  it('rejects malformed and internally inconsistent cell catalog envelopes', async () => {
    const missingCount = contractFor(mcpFetchFor({ graphs: [] }).fetch)
    await expect(missingCount.rest.graphs()).rejects.toThrow('malformed { graphs, count } catalog')

    const wrongCount = contractFor(mcpFetchFor({ graphs: graphCatalog.graphs, count: 2 }).fetch)
    await expect(wrongCount.rest.graphs()).rejects.toThrow('count 2 does not match 1 graph entries')
  })
})

describe('gardend contract UI services', () => {
  it('renders Garden Lucide icons as real inline SVG', () => {
    const contract = contractFor(mcpFetchFor({}).fetch)
    const host = document.createElement('div')
    render(contract.ui.icon('sprout'), host)

    const svg = host.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('class')).toContain('mn-icon')
    expect(svg?.querySelectorAll('path, circle, line, polyline').length).toBeGreaterThan(0)
  })

  it('presents the real Garden dialog and resolves true from its confirm action', async () => {
    const contract = contractFor(mcpFetchFor({}).fetch)
    const answer = contract.ui.confirm({
      title: 'Remove branch?',
      message: 'This cannot be undone.',
      confirmLabel: 'Remove',
      cancelLabel: 'Keep',
    })

    const dialog = document.querySelector('mn-confirmation-dialog') as MnConfirmationDialog
    expect(dialog).not.toBeNull()
    expect(dialog.open).toBe(true)
    expect(dialog.title).toBe('Remove branch?')
    expect(dialog.message).toBe('This cannot be undone.')
    expect(dialog.confirmText).toBe('Remove')
    expect(dialog.cancelText).toBe('Keep')
    await dialog.updateComplete

    ;(dialog.shadowRoot?.querySelector('.confirm-button') as HTMLButtonElement).click()
    await expect(answer).resolves.toBe(true)
    expect(dialog.isConnected).toBe(false)
  })

  it('resolves false from cancel and supports a host-owned confirmation presenter', async () => {
    const browserContract = contractFor(mcpFetchFor({}).fetch)
    const cancelled = browserContract.ui.confirm({ message: 'Stay here?' })
    const dialog = document.querySelector('mn-confirmation-dialog') as MnConfirmationDialog
    await dialog.updateComplete
    ;(dialog.shadowRoot?.querySelector('.cancel-button') as HTMLButtonElement).click()
    await expect(cancelled).resolves.toBe(false)

    const presenter = vi.fn(() => true)
    const hosted = createGardendContract({
      transport: {
        mcpUrl: '/cell/mcp',
        healthUrl: '/cell/health',
        fetch: mcpFetchFor({}).fetch,
        transport: 'fetch',
      },
      confirmPresenter: presenter,
    })
    const opts = { title: 'Host modal', message: 'Delegate this?' }
    await expect(hosted.ui.confirm(opts)).resolves.toBe(true)
    expect(presenter).toHaveBeenCalledWith(opts)
  })

  it('presents the real Garden input dialog and resolves the typed value from its confirm action', async () => {
    const contract = contractFor(mcpFetchFor({}).fetch)
    const answer = contract.ui.prompt?.({
      title: 'New graph ID',
      value: 'garden-a-copy',
      placeholder: 'graph-id',
      confirmLabel: 'Duplicate',
      cancelLabel: 'Never mind',
    })
    expect(answer).toBeDefined()

    const dialog = document.querySelector('mn-input-dialog') as MnInputDialog
    expect(dialog).not.toBeNull()
    expect(dialog.open).toBe(true)
    expect(dialog.title).toBe('New graph ID')
    expect(dialog.value).toBe('garden-a-copy')
    expect(dialog.placeholder).toBe('graph-id')
    expect(dialog.confirmText).toBe('Duplicate')
    expect(dialog.cancelText).toBe('Never mind')
    await dialog.updateComplete

    ;(dialog.shadowRoot?.querySelector('.confirm-button') as HTMLButtonElement).click()
    await expect(answer).resolves.toBe('garden-a-copy')
    expect(dialog.isConnected).toBe(false)
  })

  it('resolves null from cancel and supports a host-owned prompt presenter', async () => {
    const browserContract = contractFor(mcpFetchFor({}).fetch)
    const cancelled = browserContract.ui.prompt?.({ title: 'Rename', value: 'old-name' })
    const dialog = document.querySelector('mn-input-dialog') as MnInputDialog
    await dialog.updateComplete
    ;(dialog.shadowRoot?.querySelector('.cancel-button') as HTMLButtonElement).click()
    await expect(cancelled).resolves.toBe(null)

    const presenter = vi.fn(() => 'delegated-value')
    const hosted = createGardendContract({
      transport: {
        mcpUrl: '/cell/mcp',
        healthUrl: '/cell/health',
        fetch: mcpFetchFor({}).fetch,
        transport: 'fetch',
      },
      promptPresenter: presenter,
    })
    const opts = { title: 'Host modal', value: 'seed' }
    await expect(hosted.ui.prompt?.(opts)).resolves.toBe('delegated-value')
    expect(presenter).toHaveBeenCalledWith(opts)
  })

  it('exposes Garden awareness swatches in canonical order as immutable data', () => {
    const contract = contractFor(mcpFetchFor({}).fetch)
    expect(contract.ui.presenceColors).toBe(GARDEN_PRESENCE_COLORS)
    expect(contract.ui.presenceColors).toEqual([
      '#2f6b55',
      '#3f7c49',
      '#5a8f3d',
      '#738f2f',
      '#8a5a2b',
      '#ad6a3b',
      '#b24d65',
      '#6d5a9c',
      '#4e789f',
      '#3d8078',
    ])
    expect(Object.isFrozen(contract.ui.presenceColors)).toBe(true)
  })
})

describe('parseBlockScore', () => {
  it('reads camelCase fields on the real, camelCase-only scored path', () => {
    const score = parseBlockScore({
      blockId: 'block-1',
      documentId: 'doc-1',
      cumulativeImportance: 1.5,
      cumulativeValence: -2,
      rawImportanceSum: 3,
      rawValenceSum: -4,
      importanceCount: 2,
      valenceCount: 1,
      compositeScore: 0.42,
      blockWireCount: 1,
      docWireCount: 5,
      lastValuatedAt: '2026-01-01T00:00:00Z',
      userImportance: 5,
      userValence: -4,
    })
    expect(score.userImportance).toBe(5)
    expect(score.userValence).toBe(-4)
    expect(score.compositeScore).toBe(0.42)
  })

  it('falls back to snake_case when the camelCase key is entirely absent', () => {
    const score = parseBlockScore({
      block_id: 'block-1',
      document_id: 'doc-1',
      user_importance: 3,
      user_valence: null,
    })
    expect(score.blockId).toBe('block-1')
    expect(score.userImportance).toBe(3)
    expect(score.userValence).toBeNull()
  })

  it('prefers an explicit camelCase null over a differing snake_case value on a dual-keyed payload', () => {
    // A payload that carries BOTH keys with DIFFERENT values — the collision
    // a `??` fallback would get wrong by treating the camel `null` as
    // "missing" and silently preferring the stale snake_case number instead.
    const score = parseBlockScore({
      userImportance: null,
      user_importance: 5,
      userValence: null,
      user_valence: -4,
    })
    expect(score.userImportance).toBeNull()
    expect(score.userValence).toBeNull()
  })

  it('defaults numeric fields to 0 and unset nullable fields to null when both keys are absent', () => {
    const score = parseBlockScore({})
    expect(score.cumulativeImportance).toBe(0)
    expect(score.compositeScore).toBe(0)
    expect(score.userImportance).toBeNull()
    expect(score.userValence).toBeNull()
    expect(score.lastValuatedAt).toBeNull()
  })
})

describe('source mirror enrollment', () => {
  // A local cell is this machine's neighbor. `passthrough` must mean exactly
  // that: no mirror store is ever opened, no pull is ever made, and the MCP
  // client the shell mutates through is the raw one — the same path the
  // agents' MCP tools take, and the one without a client-minted document
  // incarnation (the 2026-09-17 authority-wait race).
  function fakeIndexedDb(): { factory: IDBFactory; opens: number } {
    const state = { opens: 0 }
    const factory = {
      open: () => {
        state.opens += 1
        throw new Error('IndexedDB must not be opened by a passthrough contract')
      },
    } as unknown as IDBFactory
    return { factory, get opens() { return state.opens } }
  }

  it('passthrough hands the shell the raw MCP client and the live REST client', () => {
    const { fetch } = mcpFetchFor(graphCatalog)
    const contract = createGardendContract({
      transport: { mcpUrl: '/cell/mcp', healthUrl: '/cell/health', fetch, transport: 'fetch' },
      sourceMirror: 'passthrough',
    })
    expect(contract.sourceMirrorMode).toBe('passthrough')
    expect(contract.mcp).toBe(contract.rawMcp)
    expect(contract.rest).toBe(contract.restConcrete)
    expect(contract.sourceMirror.enrollment).toBe('passthrough')
  })

  it('enrolled (the default) keeps the mirror-routing wrap and the mirror REST face', () => {
    const { fetch } = mcpFetchFor(graphCatalog)
    const contract = createGardendContract({
      transport: { mcpUrl: '/cell/mcp', healthUrl: '/cell/health', fetch, transport: 'fetch' },
    })
    expect(contract.sourceMirrorMode).toBe('enrolled')
    expect(contract.mcp).not.toBe(contract.rawMcp)
    expect(contract.rest).not.toBe(contract.restConcrete)
    expect(contract.sourceMirror.enrollment).toBe('enrolled')
  })

  it('passthrough never opens IndexedDB and never pulls, even with a mirror database present', async () => {
    const idb = fakeIndexedDb()
    const previous = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    ;(globalThis as { indexedDB?: IDBFactory }).indexedDB = idb.factory
    try {
      const { fetch, requests } = mcpFetchFor(graphCatalog)
      const contract = createGardendContract({
        transport: { mcpUrl: '/cell/mcp', healthUrl: '/cell/health', fetch, transport: 'fetch' },
        sourceMirror: 'passthrough',
      })
      const before = requests.length
      await contract.sourceMirror.open('garden-a')
      contract.sourceMirror.backgroundSync('garden-a')
      const manager = await contract.sourceMirror.sync('garden-a')
      expect(idb.opens).toBe(0)
      expect(requests.length).toBe(before) // no source_pull, no source_push
      expect(manager.get().complete).toBe(false) // never enrolled → every gate stays live
      expect(contract.sourceMirror.bundleFor('garden-a')).toBeUndefined()
    } finally {
      ;(globalThis as { indexedDB?: IDBFactory }).indexedDB = previous
    }
  })

  it('passthrough sends a sidebar create straight to the cell with no client-minted incarnation', async () => {
    const { fetch, requests } = mcpFetchFor({ documentId: 'doc-1', title: 'T' })
    const contract = createGardendContract({
      transport: { mcpUrl: '/cell/mcp', healthUrl: '/cell/health', fetch, transport: 'fetch' },
      sourceMirror: 'passthrough',
    })
    await contract.mcp.toolsCall('create_document', { graph_id: 'garden-a', title: 'T' })
    const call = requests.at(-1) as { method: string; params: { name: string; arguments: Record<string, unknown> } }
    expect(call.method).toBe('tools/call')
    expect(call.params.name).toBe('create_document')
    expect(call.params.arguments).not.toHaveProperty('documentIncarnation')
    expect(call.params.arguments).not.toHaveProperty('document_incarnation')
  })
})

describe('candidate-filtered loopback salience', () => {
  it('filters before the result limit so a baseline beyond the top 1000 is returned', async () => {
    const stored = Array.from({ length: 1001 }, (_, i) => ({
      documentId: 'doc / one', blockId: `b${i}`, compositeScore: i === 1000 ? 0.1 : 0.8,
    }))
    const requests: URL[] = []
    const contract = contractFor(async (input) => {
      const url = new URL(String(input), 'http://localhost')
      requests.push(url)
      const ids = url.searchParams.get('block_ids')?.split(',')
      const blocks = stored.filter((block) => !ids || ids.includes(block.blockId))
        .slice(0, Number(url.searchParams.get('limit')))
      return new Response(JSON.stringify({ blocks }), { headers: { 'Content-Type': 'application/json' } })
    })
    expect(await contract.salience.getScores('g', 'doc / one')).toHaveLength(1000)
    await expect(contract.salience.getScores('g', 'doc / one', ['b1000', 'b1000'])).resolves.toEqual([
      expect.objectContaining({ blockId: 'b1000', compositeScore: 0.1 }),
    ])
    expect(requests[1]!.searchParams.get('document_id')).toBe('doc / one')
    expect(requests[1]!.searchParams.get('block_ids')).toBe('b1000')
    expect(requests[1]!.searchParams.get('limit')).toBe('1')
    await expect(contract.salience.getScores('g', 'doc / one', [])).resolves.toEqual([])
    expect(requests).toHaveLength(2)
  })
})

describe('paginated loopback salience', () => {
  it('loads a second-page baseline into the gutter score bundle', async () => {
    const { makeSalienceBundleService, signalLevel } = await import('@shrubbery/runtime')
    const first = Array.from({ length: 1000 }, (_, i) => ({ documentId: 'd', blockId: `b${i}`, compositeScore: 0.8 }))
    const baseline = { documentId: 'd', blockId: 'never-valued', compositeScore: 0.31 }
    const offsets: Array<string | null> = []
    const contract = contractFor(async (input) => {
      const url = new URL(String(input), 'http://localhost')
      offsets.push(url.searchParams.get('offset'))
      expect(url.searchParams.get('limit')).toBe('1000')
      const payload = offsets.length === 1
        ? { blocks: first, page: { nextOffset: 1000 } }
        : { blocks: [baseline], page: { nextOffset: null } }
      return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
    })
    const bundle = await makeSalienceBundleService(contract.salience).loadBundle('g', 'd')
    expect(offsets).toEqual([null, '1000'])
    expect(bundle.scores.size).toBe(1001)
    expect(signalLevel(bundle.scores.get('never-valued'))).toBe(1)
    expect(bundle.scores.get('never-valued')?.userImportance).toBeNull()
  })
})
