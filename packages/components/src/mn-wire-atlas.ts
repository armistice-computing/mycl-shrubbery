/** Read-only atlas prototype. Data, persistence, navigation and authority belong to the host. */
import { css, html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { SkinAware } from './skin-aware.js'
import { LitElement } from 'lit'
import { atlasConnections, atlasUnplaced, atlasNeighborhood, atlasSnapshotSignature, ATLAS_CARD_WIDTH, ATLAS_CARD_HEIGHT, updateAtlas,
  type AtlasSnapshot, type AtlasState, type AtlasWire } from './wire-atlas-model.js'
import { AtlasLayoutClient } from './wire-atlas-layout-client.js'
import { onwardWireCounts } from './wire-atlas-neighborhood.js'
import { atlasPredicateLabels } from './wire-atlas-labels.js'

/**
 * The "Not yet placed" list of unwired documents is hidden (Eschaton,
 * 2026-11-18: it was confusing, and choosing one faded the whole map). The
 * files sidebar's wire count toggle finds unwired documents instead. Set true
 * to bring the list back.
 */
const SHOW_UNPLACED_LIST = false

interface AtlasReturnView { zoom: number; left: number; top: number; selected: string | null }
export type AtlasNeighborhoodReason = 'user' | 'host' | 'inactive' | 'snapshot' | 'graph'

@customElement('mn-wire-atlas')
export class MnWireAtlas extends SkinAware(LitElement) {
  @property({ attribute: false }) snapshot: (AtlasSnapshot & { graphId: string }) | null = null
  @property() graphId = ''
  @property({ attribute: false }) savedLayout: { graphId: string; state: AtlasState; view?: { zoom: number; left: number; top: number; centerOnSelect?: boolean; showPredicates?: boolean } } | null = null
  @property({ type: Boolean }) active = true
  @property({ type: Boolean }) canOpenDocument = false
  @state() private model: AtlasState | null = null
  private modelGraphId: string | null = null
  @state() private selected: string | null = null
  @state() private arranging = false
  @state() private layoutError = ''
  @state() private zoom = 1
  @state() private search = ''
  @state() private centerOnSelect = true
  @state() private showPredicates = true
  private fitNext = true
  private openingSnapshot = false
  private renderedPadding = { x: 0, y: 0 }
  private restoreView: { zoom: number; left: number; top: number; centerOnSelect?: boolean; showPredicates?: boolean } | null = null
  private readonly layout = new AtlasLayoutClient()
  private generation = 0
  private needsInitialLayout = true
  @state() private neighborhoodCenter: string | null = null
  @state() private neighborhood: AtlasState | null = null
  @state() private neighborhoodBusy = false
  @state() private neighborhoodChanged = false
  @state() private neighborhoodError = ''
  private neighborhoodSource: AtlasState | null = null
  private readonly neighborhoodWorker = new AtlasLayoutClient()
  private neighborhoodGeneration = 0
  private clickTimer: ReturnType<typeof setTimeout> | undefined
  private homeView: AtlasReturnView | null = null
  private pointerHome: { id: string; view: AtlasReturnView } | null = null
  private lastReadiness = false
  private readonly hostEntries = new Map<string, Promise<void>>()
  private mapObserver: ResizeObserver | null = null
  private observedMap: HTMLElement | null = null
  private observeMap(): void {
    const map = this.active && this.isConnected ? this.shadowRoot?.querySelector<HTMLElement>('.map') ?? null : null
    if (map === this.observedMap) return
    this.mapObserver?.disconnect()
    this.mapObserver = null
    this.observedMap = map
    if (!map || typeof ResizeObserver === 'undefined') return
    let width = map.clientWidth, height = map.clientHeight
    this.mapObserver = new ResizeObserver(() => {
      if (this.observedMap !== map || !this.active || !this.isConnected) return
      if (width === map.clientWidth && height === map.clientHeight) return
      width = map.clientWidth; height = map.clientHeight
      if (!width || !height) return
      this.requestUpdate()
      const center = this.neighborhoodCenter, generation = this.neighborhoodGeneration
      if (center && this.neighborhood && !this.neighborhoodBusy) {
        void this.updateComplete.then(() => {
          if (this.observedMap === map && this.active && this.isConnected &&
              generation === this.neighborhoodGeneration && center === this.neighborhoodCenter) void this.centerCard(center)
        })
      }
    })
    this.mapObserver.observe(map)
  }
  /** Host can disable This document until the current graph's map is usable. */
  get neighborhoodReady(): boolean {
    return !!(this.isConnected && this.active && this.model && this.modelGraphId === this.graphId && this.snapshot?.graphId === this.graphId &&
      !this.arranging && !this.needsInitialLayout && !this.neighborhoodBusy)
  }
  /** Production host entry. No change to the saved atlas or its return camera. */
  enterDocumentNeighborhood(documentId: string): Promise<void> {
    const graph = this.graphId
    const key = JSON.stringify([graph, documentId])
    const existing = this.hostEntries.get(key)
    if (existing) return existing
    const promise = this.enterDocumentNeighborhoodOnce(documentId, graph, this.neighborhoodGeneration)
    this.hostEntries.set(key, promise)
    const release = () => { if (this.hostEntries.get(key) === promise) this.hostEntries.delete(key) }
    void promise.then(release, release)
    return promise
  }
  private async enterDocumentNeighborhoodOnce(documentId: string, graph: string, requestedGeneration: number): Promise<void> {
    await this.updateComplete
    if (requestedGeneration !== this.neighborhoodGeneration) throw new Error('Neighborhood request was superseded before entry')
    if (graph !== this.graphId) throw new Error('Atlas graph changed before neighborhood entry')
    if (!this.neighborhoodReady) throw new Error('Atlas is not ready to open a neighborhood')
    if (!this.model!.snapshot.documents.some(d => d.id === documentId)) throw new Error('Document is not in this atlas')
    if (this.neighborhoodCenter === documentId && this.neighborhood) return
    const generation = this.neighborhoodGeneration + 1
    await this.enterNeighborhood(documentId, undefined, 'host')
    if (generation !== this.neighborhoodGeneration || graph !== this.graphId || this.neighborhoodCenter !== documentId || !this.neighborhood) {
      throw new Error(this.neighborhoodError || 'Neighborhood request was cancelled or superseded')
    }
  }
  returnToAtlas(): void { this.exitNeighborhood('host') }
  private openSelectedDocument() {
    if (!this.canOpenDocument || !this.active || !this.isConnected || !this.selected || this.modelGraphId !== this.graphId ||
      this.snapshot?.graphId !== this.graphId || !this.snapshot.documents.some(d => d.id === this.selected)) return
    this.dispatchEvent(new CustomEvent('atlas-document-open', { detail: { graphId: this.graphId, documentId: this.selected }, bubbles: true, composed: true }))
  }
  private get displayed(): AtlasState | null { return this.neighborhoodCenter ? this.neighborhood : this.model }
  private readonly onEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !this.active) return
    // A modal owns the first Escape; clearing the atlas is the next gesture.
    if (this.ownerDocument.querySelector('dialog[open]')) return
    clearTimeout(this.clickTimer)
    this.clickTimer = undefined
    this.pointerHome = null
    if (!this.selected && !this.neighborhoodCenter) return
    if (this.neighborhoodCenter) this.exitNeighborhood('user')
    else this.selected = null
    event.preventDefault()
  }

  disconnectedCallback(): void {
    this.mapObserver?.disconnect()
    this.mapObserver = null
    this.observedMap = null
    clearTimeout(this.clickTimer)
    this.exitNeighborhood('inactive')
    this.ownerDocument.removeEventListener('keydown', this.onEscape)
    this.cancelLayout()
    this.lastReadiness = false
    this.dispatchEvent(new CustomEvent('atlas-readiness-change', { detail: { graphId: this.graphId, ready: false }, bubbles: true, composed: true }))
    super.disconnectedCallback()
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.ownerDocument.addEventListener('keydown', this.onEscape)
    this.requestUpdate('active', false)
  }

  private cancelLayout(): void {
    this.generation++
    this.layout.cancel()
    if (this.arranging && this.model) this.model = { ...this.model, pending: true }
    this.arranging = false
  }
  private discardNeighborhood(reason: AtlasNeighborhoodReason = 'graph', notify = true) {
    const hadCenter = this.neighborhoodCenter !== null
    this.hostEntries.clear()
    clearTimeout(this.clickTimer)
    this.pointerHome = null
    this.neighborhoodGeneration++
    this.neighborhoodWorker.cancel()
    this.neighborhoodCenter = null; this.neighborhood = null; this.neighborhoodBusy = false
    this.neighborhoodSource = null; this.homeView = null; this.neighborhoodError = ''; this.neighborhoodChanged = false
    if (hadCenter && notify) this.dispatchEvent(new CustomEvent('atlas-neighborhood-change', { detail: { graphId: this.modelGraphId ?? this.graphId, documentId: null, reason }, bubbles: true, composed: true }))
  }
  private exitNeighborhood(reason: AtlasNeighborhoodReason = 'user') {
    const home = this.homeView
    const hadCenter = this.neighborhoodCenter !== null
    const graphId = this.modelGraphId ?? this.graphId
    this.discardNeighborhood(reason, false)
    if (home) {
      this.selected = this.snapshot?.documents.some(d => d.id === home.selected) ? home.selected : null
      this.zoom = home.zoom
      this.restoreView = { zoom: home.zoom, left: home.left, top: home.top }
    }
    if (hadCenter) this.dispatchEvent(new CustomEvent('atlas-neighborhood-change', { detail: { graphId, documentId: null, reason }, bubbles: true, composed: true }))
  }
  private async enterNeighborhood(id: string, returnView?: AtlasReturnView, reason: AtlasNeighborhoodReason = 'user') {
    clearTimeout(this.clickTimer)
    this.pointerHome = null
    if (!this.model || this.arranging || !this.active || !this.isConnected) return
    const map = this.shadowRoot?.querySelector('.map') as HTMLElement | null
    const viewport = { width: map?.clientWidth ?? 800, height: map?.clientHeight ?? 600 }
    if (!this.homeView) {
      this.saveView()
      this.homeView = returnView ?? { zoom: this.zoom, left: map?.scrollLeft ?? 0, top: map?.scrollTop ?? 0, selected: this.selected }
    }
    this.neighborhoodGeneration++
    const generation = this.neighborhoodGeneration
    this.neighborhoodWorker.cancel()
    const changed = this.neighborhoodCenter !== id
    this.neighborhoodCenter = id; this.selected = id; this.neighborhood = null
    this.neighborhoodBusy = true; this.neighborhoodError = ''; this.neighborhoodChanged = false
    if (changed) this.dispatchEvent(new CustomEvent('atlas-neighborhood-change', { detail: { graphId: this.graphId, documentId: id, reason }, bubbles: true, composed: true }))
    // Synchronous host listeners may exit, detach, switch graphs, or start another walk.
    if (generation !== this.neighborhoodGeneration || !this.active || !this.isConnected ||
      this.modelGraphId !== this.graphId || this.snapshot?.graphId !== this.graphId || this.neighborhoodCenter !== id) return
    const source = this.model
    try {
      const result = await this.neighborhoodWorker.run(source, id)
      if (!result || generation !== this.neighborhoodGeneration) return
      this.neighborhood = result; this.neighborhoodSource = source
      this.neighborhoodBusy = false
      const points = Object.values(result.positions)
      const radiusX = Math.max(ATLAS_CARD_WIDTH / 2, ...points.map(p => Math.abs(p.x) + ATLAS_CARD_WIDTH / 2)) + 40
      const radiusY = Math.max(ATLAS_CARD_HEIGHT / 2, ...points.map(p => Math.abs(p.y) + ATLAS_CARD_HEIGHT / 2)) + 40
      this.zoom = Math.max(.04, Math.min(1, viewport.width / (2 * radiusX), viewport.height / (2 * radiusY)))
      await this.updateComplete
      if (generation === this.neighborhoodGeneration) await this.centerCard(id)
    } catch (error) {
      if (generation === this.neighborhoodGeneration) this.neighborhoodError = String(error)
    } finally {
      if (generation === this.neighborhoodGeneration) this.neighborhoodBusy = false
    }
  }
  private cardClick(event: MouseEvent, id: string) {
    clearTimeout(this.clickTimer)
    this.clickTimer = undefined
    if (this.neighborhoodCenter) { void this.enterNeighborhood(id); return }
    // Give a pointer double-click time to arrive before centering moves its target.
    if (event.detail === 0) { this.pointerHome = null; void this.selectDocument(id) }
    else if (event.detail === 1) {
      const map = this.shadowRoot?.querySelector('.map') as HTMLElement | null
      this.pointerHome = { id, view: { zoom: this.zoom, left: map?.scrollLeft ?? 0, top: map?.scrollTop ?? 0, selected: this.selected } }
      this.selected = id
      this.clickTimer = setTimeout(() => {
        this.clickTimer = undefined
        this.pointerHome = null
        if (this.selected === id && this.centerOnSelect && !this.neighborhoodCenter) void this.centerCard(id)
      }, 600)
    }
  }
  static styles = css`
    :host { display: flex; flex-direction:column; height: 100%; container-type:inline-size; color: var(--mn-color-text-primary, #242922);
      background: var(--mn-color-surface-base, #faf8f2); }
    header { display:flex; flex-wrap:wrap; gap:.7rem; align-items:center; padding:1rem; border-bottom:1px solid #8885; }
    h2 { margin:0; font-size:1.25rem; } button { font:inherit; color:inherit; cursor:pointer; }
    /* The details panel sits under the map at every width (Eschaton, 2026-11-18). */
    .body { display:grid; grid-template-columns:minmax(0, 1fr); grid-template-rows:minmax(0, 72%) minmax(0, 28%); flex:1; min-height:0; }
    .map { overflow:auto; background-image:radial-gradient(#8883 1px,transparent 1px); background-size:24px 24px; }
    .plane { position:relative; min-width:100%; min-height:100%; }
    .extent { position:relative; } .plane { transform-origin:0 0; }
    svg { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
    line { stroke:currentColor; opacity:.2; stroke-width:1; vector-effect:non-scaling-stroke; }
    line.incident { opacity:.95; stroke-width:2; }
    line.secondary { opacity:.45; stroke-width:1.2; }
    line.remote { opacity:.025; }
    .predicate-label { font-size:12px; fill:currentColor; stroke:var(--mn-color-surface-base, #faf8f2); stroke-width:3px; paint-order:stroke; stroke-linejoin:round; text-anchor:middle; opacity:.7; }
    .predicate-label.incident { opacity:1; }
    .predicate-label.secondary { opacity:.55; }
    .predicate-label.remote { opacity:.08; }
    .node { position:absolute; box-sizing:border-box; width:200px; height:96px; padding:10px; border:1px solid #8887;
      border-radius:5px; background:var(--mn-color-surface-base, #faf8f2); text-align:left; transform-origin:center; }
    .node span { display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; line-height:1.15; }
    .node.onward span { -webkit-line-clamp:3; }
    .onward-count { position:absolute; bottom:4px; right:8px; font-size:11px; opacity:1; }
    .neighborhood-note { font-size:.85rem; margin:0; }
    /* Scale text with its card, keeping the world-space anchor and line endpoints fixed.
       4% of the 200px width consumes the existing 8px gap, never its neighbour. */
    .node[data-depth="0"] { outline:2px solid currentColor; outline-offset:-2px; z-index:4; transform:scale(1.04); }
    .node[data-depth="1"] { opacity:1; z-index:3; border-color:currentColor; box-shadow:0 2px 8px #14231b30; transform:scale(1.04); }
    .node[data-depth="2"] { opacity:.55; z-index:2; transform:scale(1.02); }
    .node[data-depth="3"] { opacity:.12; z-index:1; }
    aside { overflow:auto; padding:1rem; border-top:1px solid #8885; }
    ul { list-style:none; padding:0; } li { margin-bottom:.8rem; }
    .relation { display:block; width:100%; text-align:left; padding:.6rem; background:transparent; border:1px solid #8885; }
    small { display:block; opacity:.75; margin-top:.3rem; } .margin { margin-top:2rem; }
  `
  protected willUpdate(changes: Map<PropertyKey, unknown>): void {
    if (changes.has('graphId')) {
      this.discardNeighborhood('graph')
      this.cancelLayout(); this.model = null; this.selected = null
      this.modelGraphId = null
      this.needsInitialLayout = true; this.layoutError = ''; this.fitNext = true; this.search = ''; this.restoreView = null
      this.showPredicates = true
    }
    if (!this.snapshot || this.snapshot.graphId !== this.graphId) {
      this.discardNeighborhood('snapshot')
      this.cancelLayout()
      this.model = null; this.selected = null
      this.modelGraphId = null
      this.needsInitialLayout = true
      return
    }
    if ((changes.has('snapshot') || changes.has('graphId')) &&
        (!this.model || atlasSnapshotSignature(this.model.snapshot) !== atlasSnapshotSignature(this.snapshot))) {
      clearTimeout(this.clickTimer)
      this.pointerHome = null
      this.cancelLayout()
      this.openingSnapshot = !this.model
      if (!this.model && this.savedLayout?.graphId === this.graphId) {
        this.model = this.savedLayout.state
        // A restored unfinished arrangement still owes its first completed layout.
        this.needsInitialLayout = this.savedLayout.state.pending
        this.restoreView = this.savedLayout.view ?? null
        if (this.restoreView) { this.zoom = this.restoreView.zoom; this.centerOnSelect = this.restoreView.centerOnSelect ?? true; this.showPredicates = this.restoreView.showPredicates ?? true; this.fitNext = false }
      }
      this.model = updateAtlas(this.model, this.snapshot)
      this.modelGraphId = this.graphId
      if (this.neighborhoodCenter) {
        if (!this.snapshot.documents.some(d => d.id === this.neighborhoodCenter)) this.exitNeighborhood('snapshot')
        else {
          this.neighborhoodChanged = true
          if (this.neighborhoodBusy) {
            this.neighborhoodGeneration++; this.neighborhoodWorker.cancel(); this.neighborhoodBusy = false
            this.neighborhoodError = 'Graph changed while arranging. Refresh this neighborhood.'
          }
        }
      }
    }
    if (!this.active) { this.cancelLayout(); this.exitNeighborhood('inactive') }
    if (this.selected && !this.snapshot.documents.some(d => d.id === this.selected)) this.selected = null
  }

  protected updated(changes: Map<PropertyKey, unknown>): void {
    this.observeMap()
    const pad = this.padding()
    const paddingReady = pad.x === this.renderedPadding.x && pad.y === this.renderedPadding.y
    if (this.model && this.shadowRoot?.querySelector('.map')) {
      if (!paddingReady) this.requestUpdate()
    }
    const opening = this.fitNext || this.openingSnapshot
    this.openingSnapshot = false
    if (this.restoreView && paddingReady) {
      const map = this.shadowRoot?.querySelector('.map') as HTMLElement | null
      if (map) { map.scrollTo(this.restoreView.left, this.restoreView.top); this.restoreView = null }
    }
    if (this.fitNext && this.model && !this.needsInitialLayout && !this.neighborhoodCenter) {
      this.fitNext = false
      this.fit()
    }
    if ((changes.has('model') || changes.has('arranging')) && this.model && this.snapshot?.graphId === this.graphId) {
      this.dispatchEvent(new CustomEvent('atlas-state-change', { detail: { graphId: this.graphId,
        state: { ...this.model, pending: this.model.pending || this.needsInitialLayout || this.arranging } }, bubbles: true, composed: true }))
    }
    if (changes.has('zoom') || changes.has('centerOnSelect')) this.saveView()
    if (changes.has('showPredicates')) this.saveView(true)
    if (this.active && this.isConnected && this.model && !this.arranging && !this.layoutError && !this.neighborhoodCenter &&
      (this.needsInitialLayout || ((opening || changes.has('active') || changes.has('graphId')) && this.model.pending))) void this.rearrange()
    const ready = this.neighborhoodReady
    if (ready !== this.lastReadiness || changes.has('graphId')) {
      this.lastReadiness = ready
      this.dispatchEvent(new CustomEvent('atlas-readiness-change', { detail: { graphId: this.graphId, ready }, bubbles: true, composed: true }))
    }
  }

  private async rearrange(): Promise<void> {
    if (!this.model || !this.active || !this.isConnected) return
    this.cancelLayout()
    const generation = this.generation
    this.arranging = true; this.layoutError = ''
    try {
      const result = await this.layout.run(this.model)
      if (generation !== this.generation || !result) return
      this.model = result
      this.needsInitialLayout = false
    } catch (error) {
      if (generation === this.generation) this.layoutError = error instanceof Error ? error.message : String(error)
    } finally {
      if (generation === this.generation) this.arranging = false
    }
  }
  private documentTitle(id: string): string { return this.snapshot?.documents.find(d => d.id === id)?.title ?? id }
  private saveView(allowNeighborhood: unknown = false) {
    const map = this.shadowRoot?.querySelector('.map') as HTMLElement | null
    if (!map || !this.model || this.restoreView || (this.neighborhoodCenter && allowNeighborhood !== true)) return
    const camera = this.neighborhoodCenter && this.homeView ? this.homeView : { zoom: this.zoom, left: map.scrollLeft, top: map.scrollTop }
    this.dispatchEvent(new CustomEvent('atlas-view-change', { detail: { graphId: this.graphId, view: { zoom: camera.zoom, left: camera.left, top: camera.top, centerOnSelect: this.centerOnSelect, showPredicates: this.showPredicates } }, bubbles: true, composed: true }))
  }
  private bounds() {
    const points = Object.values(this.displayed?.positions ?? {})
    const minX = Math.min(0, ...points.map(p => p.x)) - 120
    const minY = Math.min(0, ...points.map(p => p.y)) - 80
    return { minX, minY, width: Math.max(600, ...points.map(p => p.x - minX + 220)), height: Math.max(400, ...points.map(p => p.y - minY + 140)) }
  }
  private padding() {
    const map = this.shadowRoot?.querySelector('.map') as HTMLElement | null
    return { x: (map?.clientWidth ?? 600) / 2, y: (map?.clientHeight ?? 400) / 2 }
  }
  private fit() {
    const map = this.shadowRoot?.querySelector('.map') as HTMLElement | null
    if (!map) return
    const b = this.bounds()
    this.zoom = Math.max(.04, Math.min(1, map.clientWidth / b.width, map.clientHeight / b.height))
    void this.updateComplete.then(() => { const pad = this.padding(); map.scrollTo(pad.x, pad.y) })
  }
  private async zoomBy(factor: number) {
    const map = this.shadowRoot?.querySelector('.map') as HTMLElement | null
    if (!map) return
    const old = this.zoom
    this.zoom = Math.max(.04, Math.min(2, old * factor))
    const pad = this.padding()
    const x = (map.scrollLeft + map.clientWidth / 2 - pad.x) / old
    const y = (map.scrollTop + map.clientHeight / 2 - pad.y) / old
    await this.updateComplete
    map.scrollTo(x * this.zoom + pad.x - map.clientWidth / 2, y * this.zoom + pad.y - map.clientHeight / 2)
  }
  private async selectDocument(id: string, finding = false) {
    if (this.neighborhoodCenter) { await this.enterNeighborhood(id); return }
    this.selected = id
    const p = this.model?.positions[id]
    if (!p) return
    if (!this.centerOnSelect && !finding) return
    if (finding) this.zoom = 1
    await this.centerCard(id)
  }
  private async centerCard(id: string) {
    const generation = this.neighborhoodGeneration, graphId = this.graphId
    await this.updateComplete
    if (!this.active || !this.isConnected || graphId !== this.graphId || generation !== this.neighborhoodGeneration) return
    const p = this.displayed?.positions[id]
    const map = this.shadowRoot?.querySelector<HTMLElement>('.map')
    if (!p || !map) return
    const b = this.bounds()
    const pad = this.padding()
    map.scrollTo((p.x - b.minX + ATLAS_CARD_WIDTH / 2) * this.zoom + pad.x - map.clientWidth / 2, (p.y - b.minY + ATLAS_CARD_HEIGHT / 2) * this.zoom + pad.y - map.clientHeight / 2)
  }
  private inspect(wire: AtlasWire): void {
    if (!this.active || !this.isConnected || this.modelGraphId !== this.graphId || this.snapshot?.graphId !== this.graphId) return
    this.dispatchEvent(new CustomEvent('atlas-wire-select', { detail: { wire, anchorDocumentId: this.selected }, bubbles: true, composed: true }))
  }
  private connectionLines(minX: number, minY: number, depths: Map<string, number>): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg'
    const root = document.createElementNS(ns, 'svg')
    root.setAttribute('aria-hidden', 'true')
    if (!this.displayed) return root
    const labels: SVGTextElement[] = []
    for (const bundle of atlasConnections(this.displayed.snapshot)) {
      const w = bundle[0], a = this.displayed.positions[w.source.documentId], b = this.displayed.positions[w.target.documentId]
      if (!a || !b || w.source.documentId === w.target.documentId) continue
      const line = document.createElementNS(ns, 'line')
      for (const [name, value] of Object.entries({ x1: a.x - minX + ATLAS_CARD_WIDTH / 2, y1: a.y - minY + ATLAS_CARD_HEIGHT / 2, x2: b.x - minX + ATLAS_CARD_WIDTH / 2, y2: b.y - minY + ATLAS_CARD_HEIGHT / 2 })) line.setAttribute(name, String(value))
      if (depths.size > 0) {
        const closest = Math.min(depths.get(w.source.documentId) ?? 3, depths.get(w.target.documentId) ?? 3)
        line.setAttribute('class', closest === 0 ? 'incident' : closest === 1 ? 'secondary' : 'remote')
      }
      root.append(line)
      if (this.showPredicates) {
        let angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI
        const reversed = angle > 90 || angle < -90
        if (angle > 90) angle -= 180
        if (angle < -90) angle += 180
        const rows = atlasPredicateLabels(bundle, reversed ? w.target.documentId : w.source.documentId)
        const label = document.createElementNS(ns, 'text')
        const fontSize = this.neighborhoodCenter ? Math.max(12, 8 / this.zoom) : 12
        label.style.fontSize = `${fontSize}px`
        label.setAttribute('class', `predicate-label ${line.getAttribute('class') ?? ''}`)
        label.setAttribute('transform', `translate(${(a.x + b.x) / 2 - minX + ATLAS_CARD_WIDTH / 2},${(a.y + b.y) / 2 - minY + ATLAS_CARD_HEIGHT / 2}) rotate(${angle})`)
        for (const [index, row] of rows.entries()) {
          const span = document.createElementNS(ns, 'tspan')
          span.setAttribute('x', '0'); span.setAttribute('y', String(-5 + (index - (rows.length - 1) / 2) * (fontSize + 2)))
          span.textContent = row; label.append(span)
        }
        labels.push(label)
      }
    }
    // Paint context first, direct incident connections last.
    for (const line of [...root.querySelectorAll('.secondary'), ...root.querySelectorAll('.incident')]) root.append(line)
    for (const label of labels.sort((a, b) => Number(a.classList.contains('incident')) - Number(b.classList.contains('incident')))) root.append(label)
    return root
  }
  protected render() {
    if (!this.model || !this.snapshot || this.snapshot.graphId !== this.graphId) return html`<p role="status">Waiting for this graph's atlas…</p>`
    if (this.neighborhoodCenter && !this.neighborhood) return html`<header><h2>Neighborhood of ${this.documentTitle(this.neighborhoodCenter)}</h2><button @click=${() => this.exitNeighborhood('user')}>Return to atlas · Esc</button></header>
      <p role="status">${this.neighborhoodBusy ? 'Arranging the neighborhood…' : this.neighborhoodError}</p>
      ${!this.neighborhoodBusy ? html`<button @click=${() => this.enterNeighborhood(this.neighborhoodCenter!)}>Refresh neighborhood</button>` : nothing}`
    const displayed = this.displayed!
    const { minX, minY, width, height } = this.bounds()
    const pad = this.padding()
    this.renderedPadding = pad
    // A selected document that is not on the map (it has no wires) fades
    // nothing: there is no neighborhood to light.
    const focus = this.selected !== null && displayed.positions[this.selected] ? this.selected : null
    const depths = atlasNeighborhood(displayed.snapshot, focus)
    const onward = this.neighborhoodSource ? onwardWireCounts(this.neighborhoodSource, displayed) : new Map<string, number>()
    const selectedWires = displayed.snapshot.wires.filter(w => w.source.documentId === this.selected || w.target.documentId === this.selected)
    return html`
      <header><h2>${this.neighborhoodCenter ? `Neighborhood of ${this.documentTitle(this.neighborhoodCenter)}` : 'Wire Atlas'}</h2><span>${displayed.snapshot.documents.length} documents${this.neighborhoodCenter ? ' · two steps' : ''}</span>
        ${this.neighborhoodCenter ? html`<span class="neighborhood-note">${[...onward.values()].reduce((a, b) => a + b, 0)} wires continue beyond this view</span>` : nothing}
        <button @click=${() => this.zoomBy(1 / 1.5)} aria-label="Zoom out">−</button><span>${Math.round(this.zoom * 100)}%</span><button @click=${() => this.zoomBy(1.5)} aria-label="Zoom in">+</button><button @click=${this.fit}>Fit</button>
        <label><input type="checkbox" aria-label="Wire predicates" .checked=${this.showPredicates} @change=${(e: Event) => { this.showPredicates = (e.target as HTMLInputElement).checked }}> Wire predicates</label>
        ${this.neighborhoodCenter ? html`<button @click=${() => this.exitNeighborhood('user')}>Return to atlas · Esc</button>
          ${this.neighborhoodChanged ? html`<button @click=${() => this.enterNeighborhood(this.neighborhoodCenter!)}>Refresh neighborhood · graph updated</button>` : nothing}` : html`
        <button ?disabled=${this.arranging} @click=${this.rearrange}>${this.arranging ? 'Arranging…' : 'Rearrange'}</button>
        <label><input type="checkbox" aria-label="Center on selection" .checked=${this.centerOnSelect} @change=${(e: Event) => { this.centerOnSelect = (e.target as HTMLInputElement).checked }}> Center on selection</label>
        ${this.selected ? html`<button @click=${() => { this.selected = null }}>Clear selection</button><button ?disabled=${this.arranging} @click=${() => this.enterNeighborhood(this.selected!)}>Explore neighborhood</button>` : nothing}`}
        ${this.layoutError ? html`<small role="status">Layout unavailable; provisional positions retained. ${this.layoutError}</small>` : nothing}
        ${this.model.pending ? html`<small>New arrangement ready for next opening</small>` : nothing}</header>
      <div class="body"><div class="map" @scroll=${this.saveView}><div class="extent" style=${`width:${width * this.zoom + 2 * pad.x}px;height:${height * this.zoom + 2 * pad.y}px`}><div class="plane" style=${`position:absolute;left:${pad.x}px;top:${pad.y}px;width:${width}px;height:${height}px;transform:scale(${this.zoom})`}>
        ${this.connectionLines(minX, minY, depths)}
        ${displayed.snapshot.documents.map(d => {
          const p = displayed.positions[d.id]
          return p ? html`<button class=${`node${onward.has(d.id) ? ' onward' : ''}`} style=${`left:${p.x - minX}px;top:${p.y - minY}px`}
            title=${d.title} data-depth=${focus ? depths.get(d.id) ?? 3 : ''}
            @mousedown=${(event: MouseEvent) => { if (event.detail > 1) clearTimeout(this.clickTimer) }}
            aria-pressed=${this.selected === d.id} @click=${(event: MouseEvent) => this.cardClick(event, d.id)} @dblclick=${(event: MouseEvent) => { event.preventDefault(); const home = this.pointerHome?.id === d.id ? this.pointerHome.view : undefined; void this.enterNeighborhood(d.id, home) }}><span>${d.title}</span>
            ${onward.has(d.id) ? html`<small class="onward-count">↗ ${onward.get(d.id)} onward wires</small>` : nothing}</button>` : nothing
        })}
      </div></div></div><aside>
        <label>Find document <input type="search" .value=${this.search} @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value }}></label>
        ${this.search ? html`<ul>${this.snapshot.documents.filter(d => d.title.toLowerCase().includes(this.search.toLowerCase())).slice(0, 20).map(d => html`<li><button @click=${() => this.selectDocument(d.id, true)}>${d.title}</button></li>`)}</ul>` : nothing}
        <h3>${this.selected ? this.documentTitle(this.selected) : 'Select a document'}</h3>
        ${this.selected && this.canOpenDocument ? html`<button @click=${this.openSelectedDocument}>Open document</button>` : nothing}
        <p>Lines collect recorded wires, not agreement or similarity.</p>
        <ul>${selectedWires.map(w => html`<li><button class="relation" @click=${() => this.inspect(w)}>
          ${this.documentTitle(w.source.documentId)} ${w.bidirectional ? '↔' : '→'} ${this.documentTitle(w.target.documentId)}
          <small>${w.predicate.split(/[\/#]/).pop()} · ${w.source.blockId ? 'passage' : 'document'} → ${w.target.blockId ? 'passage' : 'document'}</small>
        </button></li>`)}</ul>
        ${this.neighborhoodCenter ? html`<p class="neighborhood-note">Click a document to follow its neighborhood. Onward counts lead beyond this view.</p>`
          : SHOW_UNPLACED_LIST ? html`<section class="margin"><h3>Not yet placed</h3><small>No connections to another present document. Not a judgment of importance.</small>
          <ul>${atlasUnplaced(this.snapshot).map(d => html`<li><button @click=${() => this.selectDocument(d.id)}>${d.title}</button></li>`)}</ul>
        </section>` : nothing}
      </aside></div>`
  }
}
