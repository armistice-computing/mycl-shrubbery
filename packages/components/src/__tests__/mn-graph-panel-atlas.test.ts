/** The panel's atlas renderer: the Atlas|3D choice and "This document" kept in step with the atlas. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import '../mn-graph-panel.js'
import type {
  MnGraphPanel,
  MnGraphPanelAtlasActivateDetail,
  MnGraphPanelRendererChangeDetail,
  MnGraphPanelViewModeChangeDetail,
} from '../mn-graph-panel.js'
import type { MnWireAtlas } from '../mn-wire-atlas.js'

const snapshot = {
  graphId: 'g',
  documents: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
  wires: [{ id: 'w', source: { documentId: 'a' }, target: { documentId: 'b' }, predicate: 'supports', bidirectional: false }],
}

async function mount(setup?: (el: MnGraphPanel) => void): Promise<MnGraphPanel> {
  const el = document.createElement('mn-graph-panel') as MnGraphPanel
  el.status = 'ready'
  el.renderer = 'atlas'
  el.atlasGraphId = 'g'
  el.atlasSnapshot = snapshot
  el.atlasStatus = 'ready'
  setup?.(el)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

/** Replace the atlas's host API with spies, then let it report readiness. */
async function stubAtlas(el: MnGraphPanel) {
  const atlas = el.shadowRoot!.querySelector('mn-wire-atlas') as MnWireAtlas
  const enter = vi.fn(async (_documentId: string) => {})
  const leave = vi.fn(() => {})
  Object.assign(atlas, { enterDocumentNeighborhood: enter, returnToAtlas: leave })
  const ready = async (value: boolean) => {
    atlas.dispatchEvent(new CustomEvent('atlas-readiness-change', { detail: { graphId: 'g', ready: value }, bubbles: true, composed: true }))
    await el.updateComplete
    await Promise.resolve()
  }
  const neighborhood = async (documentId: string | null, reason: string) => {
    atlas.dispatchEvent(new CustomEvent('atlas-neighborhood-change', { detail: { graphId: 'g', documentId, reason }, bubbles: true, composed: true }))
    await el.updateComplete
  }
  return { atlas, enter, leave, ready, neighborhood }
}

function collect<T>(el: HTMLElement, type: string): T[] {
  const seen: T[] = []
  el.addEventListener(type, (event) => seen.push((event as CustomEvent<T>).detail))
  return seen
}

afterEach(() => { document.body.innerHTML = '' })

describe('mn-graph-panel - the atlas renderer', () => {
  it('draws the atlas, asks for a snapshot when shown, and offers Atlas|3D', async () => {
    const activations: MnGraphPanelAtlasActivateDetail[] = []
    const el = await mount((node) => {
      node.addEventListener('mn-graph-panel-atlas-activate', (e) => activations.push((e as CustomEvent).detail))
    })
    const root = el.shadowRoot!
    expect(root.querySelector('mn-wire-atlas')).not.toBeNull()
    expect(root.querySelector('mn-graph-three')).toBeNull()
    expect(activations).toEqual([{ force: false }])

    const changes = collect<MnGraphPanelRendererChangeDetail>(el, 'mn-graph-panel-renderer-change')
    const segments = Array.from(root.querySelectorAll<HTMLButtonElement>('.segment'))
    expect(segments.map((b) => [b.textContent?.trim(), b.getAttribute('aria-pressed')])).toEqual([['Atlas', 'true'], ['3D', 'false']])
    segments[1]!.click()
    expect(changes).toEqual([{ renderer: '3d' }])

    // Parked, then shown again: a new request, never one while hidden.
    el.active = false
    await el.updateComplete
    expect(activations).toHaveLength(1)
    el.active = true
    await el.updateComplete
    expect(activations).toEqual([{ force: false }, { force: false }])

    root.querySelector<HTMLButtonElement>('[aria-label="Refresh graph"]')!.click()
    expect(activations.at(-1)).toEqual({ force: true })
  })

  it('stays 3D, without the choice, for a host that supplies no atlas', async () => {
    const el = await mount((node) => { node.atlasGraphId = '' })
    const root = el.shadowRoot!
    expect(root.querySelector('mn-wire-atlas')).toBeNull()
    expect(root.querySelector('.renderer-toggle')).toBeNull()
  })

  it('enters the open document\'s neighborhood once the atlas is ready, and returns with the scope', async () => {
    const el = await mount((node) => { node.viewMode = 'document'; node.documentId = 'a' })
    const { enter, leave, ready } = await stubAtlas(el)
    expect(enter).not.toHaveBeenCalled()
    await ready(true)
    expect(enter).toHaveBeenCalledWith('a')
    await ready(true)
    expect(enter).toHaveBeenCalledTimes(1)

    // The editor moves to another document: follow it.
    el.documentId = 'b'
    await el.updateComplete
    await Promise.resolve()
    expect(enter).toHaveBeenLastCalledWith('b')

    el.viewMode = 'workspace'
    await el.updateComplete
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('re-enters after being parked, because the atlas leaves its neighborhood when inactive', async () => {
    const el = await mount((node) => { node.viewMode = 'document'; node.documentId = 'a' })
    const { enter, ready, neighborhood } = await stubAtlas(el)
    await ready(true)
    expect(enter).toHaveBeenCalledTimes(1)
    el.active = false
    await el.updateComplete
    await neighborhood(null, 'inactive')
    el.active = true
    await el.updateComplete
    await ready(true)
    expect(enter).toHaveBeenCalledTimes(2)
    expect(el.viewMode).toBe('document')
  })

  it('turns the scope back to the workspace when the person leaves the neighborhood in the atlas', async () => {
    const el = await mount((node) => { node.viewMode = 'document'; node.documentId = 'a' })
    const modes = collect<MnGraphPanelViewModeChangeDetail>(el, 'mn-graph-panel-view-mode-change')
    const { enter, ready, neighborhood } = await stubAtlas(el)
    await ready(true)
    await neighborhood('a', 'host')
    // Walking on to another card's neighborhood stays in the document scope,
    // and later renders do not pull the person back to the editor's document.
    await neighborhood('b', 'user')
    await ready(true)
    el.requestUpdate()
    await el.updateComplete
    expect(enter).toHaveBeenCalledTimes(1)
    expect(modes).toEqual([])
    await neighborhood(null, 'user')
    expect(modes).toEqual([{ mode: 'workspace' }])
    // Even before the host applies the new scope, the atlas is not re-entered.
    await ready(true)
    expect(enter).toHaveBeenCalledTimes(1)
  })

  it('says so, and asks for a fresh snapshot once, when the document is not in the atlas yet', async () => {
    const el = await mount((node) => { node.viewMode = 'document'; node.documentId = 'new' })
    const activations = collect<MnGraphPanelAtlasActivateDetail>(el, 'mn-graph-panel-atlas-activate')
    const { enter, ready } = await stubAtlas(el)
    enter.mockRejectedValue(new Error('Document is not in this atlas'))
    await ready(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await el.updateComplete
    expect(el.shadowRoot!.querySelector('.subtitle')?.textContent).toContain('not in the atlas yet')
    expect(activations).toEqual([{ force: true }])
    // Not retried against the same snapshot.
    await ready(true)
    expect(enter).toHaveBeenCalledTimes(1)
    el.atlasSnapshot = { ...snapshot, documents: [...snapshot.documents, { id: 'new', title: 'New' }] }
    await el.updateComplete
    await ready(true)
    expect(enter).toHaveBeenCalledTimes(2)
  })

  it('asks for the new graph\'s map when the graph changes while the atlas is in view', async () => {
    const el = await mount()
    const activations = collect<MnGraphPanelAtlasActivateDetail>(el, 'mn-graph-panel-atlas-activate')
    el.atlasGraphId = 'h'
    el.atlasSnapshot = null
    await el.updateComplete
    expect(activations).toEqual([{ force: false }])
  })

  it('spends one automatic refresh per missing document, however many fresh snapshots arrive', async () => {
    const el = await mount((node) => { node.viewMode = 'document'; node.documentId = 'gone' })
    const activations = collect<MnGraphPanelAtlasActivateDetail>(el, 'mn-graph-panel-atlas-activate')
    const { enter, ready } = await stubAtlas(el)
    enter.mockRejectedValue(new Error('Document is not in this atlas'))
    for (let i = 0; i < 4; i++) {
      // Every real read is a new object, even when nothing changed.
      el.atlasSnapshot = structuredClone(snapshot)
      await el.updateComplete
      await ready(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(activations.filter((a) => a.force)).toHaveLength(1)
    // Refresh stays the person's to press.
    el.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Refresh graph"]')!.click()
    expect(activations.filter((a) => a.force)).toHaveLength(2)
  })

  it('honors Escape while its own entry is still arranging, and ignores that entry\'s late answer', async () => {
    const el = await mount((node) => { node.viewMode = 'document'; node.documentId = 'a' })
    const modes = collect<MnGraphPanelViewModeChangeDetail>(el, 'mn-graph-panel-view-mode-change')
    const { enter, leave, ready, neighborhood } = await stubAtlas(el)
    let finish!: () => void
    enter.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    await ready(true)
    expect(enter).toHaveBeenCalledTimes(1)
    await neighborhood('a', 'host')
    await neighborhood(null, 'user')
    expect(modes).toEqual([{ mode: 'workspace' }])
    finish()
    await Promise.resolve()
    await Promise.resolve()
    // The late answer did not make 'a' the entered document: leaving the
    // scope has nothing to return from.
    el.viewMode = 'workspace'
    await el.updateComplete
    expect(leave).not.toHaveBeenCalled()
  })

  it('asks again every minute while in view, and stops when parked', async () => {
    vi.useFakeTimers()
    try {
      const el = await mount()
      const activations = collect<MnGraphPanelAtlasActivateDetail>(el, 'mn-graph-panel-atlas-activate')
      vi.advanceTimersByTime(60_000)
      expect(activations).toEqual([{ force: false }])
      el.active = false
      await el.updateComplete
      vi.advanceTimersByTime(180_000)
      expect(activations).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
