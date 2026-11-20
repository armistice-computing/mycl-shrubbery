/** sh-graph-host passes the atlas renderer's data down and its events up. */
import { describe, expect, it, afterEach, vi } from 'vitest'
import '../graph-host.js'
import type { ShGraphHost } from '../graph-host.js'
import type { GraphPanelOptions } from '../render-workspace.js'

afterEach(() => { document.body.innerHTML = '' })

describe('sh-graph-host - atlas', () => {
  it('passes renderer and atlas data to the panel and forwards every atlas event', async () => {
    const atlas = {
      graphId: 'g',
      snapshot: { graphId: 'g', documents: [], wires: [] },
      savedLayout: null,
      status: 'ready' as const,
      documentId: 'doc-a',
      onActivate: vi.fn(),
      onStateChange: vi.fn(),
      onViewChange: vi.fn(),
      onWireSelect: vi.fn(),
      onDocumentOpen: vi.fn(),
    }
    const onRendererChange = vi.fn()
    const options: GraphPanelOptions = { status: 'ready', renderer: 'atlas', atlas, onRendererChange }
    const host = document.createElement('sh-graph-host') as ShGraphHost
    host.options = options
    document.body.appendChild(host)
    await host.updateComplete
    const panel = host.shadowRoot!.querySelector('mn-graph-panel') as HTMLElement & Record<string, unknown>
    expect(panel.renderer).toBe('atlas')
    expect(panel.atlasGraphId).toBe('g')
    expect(panel.atlasSnapshot).toBe(atlas.snapshot)
    expect(panel.documentId).toBe('doc-a')

    const fire = (type: string, detail: unknown) =>
      panel.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }))
    fire('mn-graph-panel-renderer-change', { renderer: '3d' })
    fire('mn-graph-panel-atlas-activate', { force: true })
    fire('atlas-state-change', { graphId: 'g', state: { pending: false } })
    fire('atlas-view-change', { graphId: 'g', view: { zoom: 1, left: 0, top: 0 } })
    const wire = { id: 'w', source: { documentId: 'a' }, target: { documentId: 'b', blockId: 'x' }, predicate: 'supports' }
    fire('atlas-wire-select', { wire })
    fire('atlas-document-open', { graphId: 'g', documentId: 'b' })

    expect(onRendererChange).toHaveBeenCalledWith({ renderer: '3d' })
    expect(atlas.onActivate).toHaveBeenCalledWith({ force: true })
    expect(atlas.onStateChange).toHaveBeenCalledWith({ graphId: 'g', state: { pending: false } })
    expect(atlas.onViewChange).toHaveBeenCalledWith({ graphId: 'g', view: { zoom: 1, left: 0, top: 0 } })
    expect(atlas.onWireSelect).toHaveBeenCalledWith({ wire })
    expect(atlas.onDocumentOpen).toHaveBeenCalledWith({ graphId: 'g', documentId: 'b' })
  })

  it('defaults to 3D for options that never mention a renderer', async () => {
    const host = document.createElement('sh-graph-host') as ShGraphHost
    host.options = { status: 'ready' }
    document.body.appendChild(host)
    await host.updateComplete
    const panel = host.shadowRoot!.querySelector('mn-graph-panel') as HTMLElement & Record<string, unknown>
    expect(panel.renderer).toBe('3d')
    expect(panel.atlasGraphId).toBe('')
  })
})
