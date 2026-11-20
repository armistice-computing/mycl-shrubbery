import { afterEach, describe, expect, it, vi } from 'vitest'
import '../mn-wire-atlas.js'
import type { MnWireAtlas } from '../mn-wire-atlas.js'

afterEach(() => { document.body.innerHTML = '' })
describe('atlas prototype', () => {
  it('never emits an Open from the old model during a graph switch', async () => {
    const element = document.createElement('mn-wire-atlas') as MnWireAtlas
    element.graphId = 'old'
    element.canOpenDocument = true
    element.snapshot = { graphId: 'old', documents: [{ id: 'shared', title: 'Old' }], wires: [] }
    document.body.append(element); await element.updateComplete
    // An unwired document is not on the map; Find document selects it.
    const find = element.shadowRoot!.querySelector<HTMLInputElement>('aside input[type="search"]')!
    find.value = 'Old'; find.dispatchEvent(new Event('input'))
    await element.updateComplete
    ;[...element.shadowRoot!.querySelectorAll('aside ul button')][0].dispatchEvent(new MouseEvent('click'))
    await element.updateComplete
    let opened = false
    element.addEventListener('atlas-document-open', () => { opened = true })
    const button = [...element.shadowRoot!.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Open document')!
    element.graphId = 'new'
    element.snapshot = { graphId: 'new', documents: [{ id: 'shared', title: 'New' }], wires: [] }
    button.click()
    expect(opened).toBe(false)
    expect(element.neighborhoodReady).toBe(false)
    await element.updateComplete
  })
  it('does not list unwired documents beside the map', async () => {
    const element = document.createElement('mn-wire-atlas') as MnWireAtlas
    element.snapshot = { graphId: '', documents: [{ id: 'a', title: 'Alone' }], wires: [] }
    document.body.append(element); await element.updateComplete
    expect(element.shadowRoot!.textContent).not.toContain('Not yet placed')
  })
  it('renders real SVG links and emits exact wire evidence rather than rewriting its endpoints', async () => {
    const element = document.createElement('mn-wire-atlas') as MnWireAtlas
    element.canOpenDocument = true
    const wire = { id: 'w', source: { documentId: 'a', blockId: 'p' }, target: { documentId: 'b' }, predicate: 'qualifies' }
    element.snapshot = { graphId: '', documents: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], wires: [wire] }
    document.body.append(element); await element.updateComplete
    expect(element.shadowRoot!.querySelector('line')?.namespaceURI).toBe('http://www.w3.org/2000/svg')
    element.shadowRoot!.querySelector<HTMLButtonElement>('.node')!.click(); await element.updateComplete
    let opened: unknown
    element.addEventListener('atlas-document-open', e => { opened = (e as CustomEvent).detail })
    const openButton = [...element.shadowRoot!.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Open document')!
    openButton.click()
    expect(opened).toEqual({ graphId: '', documentId: 'a' })
    let evidence: unknown
    element.addEventListener('atlas-wire-select', e => { evidence = (e as CustomEvent).detail.wire })
    element.shadowRoot!.querySelector<HTMLButtonElement>('.relation')!.click()
    expect(evidence).toEqual(wire)
    expect(element.shadowRoot!.querySelector('.relation')?.textContent).toContain('passage → document')
    const modal = document.createElement('dialog')
    modal.setAttribute('open', '')
    document.body.append(modal)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('.node[aria-pressed=true]')).not.toBeNull()
    modal.remove()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('.node[aria-pressed=true]')).toBeNull()
  })
  it('keeps counters below threshold and clears graph state on graph switching', async () => {
    const element = document.createElement('mn-wire-atlas') as MnWireAtlas
    element.graphId = 'one'
    element.snapshot = { graphId: 'one', documents: [], wires: [] }
    document.body.append(element); await element.updateComplete
    element.snapshot = { graphId: 'one', documents: Array.from({ length: 5 }, (_, i) => ({ id: String(i), title: 'Old graph document' })), wires: [] }
    await element.updateComplete
    expect(element.shadowRoot!.textContent).toContain('New arrangement ready')
    element.graphId = 'two'; await element.updateComplete
    expect(element.shadowRoot!.textContent).not.toContain('New arrangement ready')
    expect(element.shadowRoot!.textContent).not.toContain('Old graph document')
    element.snapshot = { graphId: 'two', documents: Array.from({ length: 5 }, (_, i) => ({ id: `new-${i}`, title: 'New graph document' })), wires: [] }
    await element.updateComplete
    // Unwired documents are not listed beside the map; Find document reaches them.
    const find = element.shadowRoot!.querySelector<HTMLInputElement>('aside input[type="search"]')!
    find.value = 'graph document'; find.dispatchEvent(new Event('input'))
    await element.updateComplete
    expect(element.shadowRoot!.textContent).toContain('New graph document')
    expect(element.shadowRoot!.textContent).not.toContain('Old graph document')
    expect(element.shadowRoot!.textContent).not.toContain('New arrangement ready')
  })
})

describe('atlas host polish', () => {
  it('includes the selected endpoint for incoming wire navigation', async () => {
    const element = document.createElement('mn-wire-atlas') as MnWireAtlas
    const wire = { id: 'w', source: { documentId: 'a' }, target: { documentId: 'b' }, predicate: 'supports' }
    element.snapshot = { graphId: '', documents: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], wires: [wire] }
    document.body.append(element); await element.updateComplete
    const nodes = element.shadowRoot!.querySelectorAll<HTMLButtonElement>('.node')
    nodes[1].click(); await element.updateComplete
    let detail: unknown
    element.addEventListener('atlas-wire-select', e => { detail = (e as CustomEvent).detail })
    element.shadowRoot!.querySelector<HTMLButtonElement>('.relation')!.click()
    expect(detail).toEqual({ wire, anchorDocumentId: 'b' })
    detail = undefined
    element.graphId = 'new'
    element.shadowRoot!.querySelector<HTMLButtonElement>('.relation')!.click()
    expect(detail).toBeUndefined()
  })
})

it('recenters resized neighborhoods without changing their return camera, and disconnects when parked', async () => {
  let callback: () => void = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { callback = cb }
    observe() {}
    disconnect = disconnect
  })
  try {
    const element = document.createElement('mn-wire-atlas') as MnWireAtlas
    element.snapshot = { graphId: '', documents: [], wires: [] }
    document.body.append(element); await element.updateComplete
    const map = element.shadowRoot!.querySelector<HTMLElement>('.map')!
    const internals = element as unknown as {
      neighborhoodCenter: string | null; neighborhood: unknown; neighborhoodBusy: boolean;
      homeView: unknown; centerCard: (id: string) => Promise<void>;
    }
    const home = { zoom: .5, left: 12, top: 34, selected: null }
    internals.homeView = home
    internals.neighborhoodCenter = 'a'
    internals.neighborhood = { snapshot: { documents: [], wires: [] }, positions: {} }
    const center = vi.spyOn(internals, 'centerCard').mockResolvedValue()
    Object.defineProperty(map, 'clientWidth', { configurable: true, value: 990 })
    Object.defineProperty(map, 'clientHeight', { configurable: true, value: 600 })
    callback(); await element.updateComplete; await Promise.resolve()
    expect(center).toHaveBeenCalledWith('a')
    expect(internals.homeView).toBe(home)
    center.mockClear()
    callback(); await element.updateComplete
    expect(center).not.toHaveBeenCalled()
    Object.defineProperty(map, 'clientWidth', { configurable: true, value: 280 })
    callback()
    element.active = false
    await element.updateComplete; await Promise.resolve()
    expect(center).not.toHaveBeenCalled()
    expect(disconnect).toHaveBeenCalled()
    element.remove()
    callback(); await Promise.resolve()
    expect(center).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})
