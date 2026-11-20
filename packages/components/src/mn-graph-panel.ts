/**
 * mn-graph-panel - controlled Garden workspace/document graph surface.
 *
 * The scene preserves Garden's paper-craft 3-D behavior while the boundary is
 * Shrubbery-native: callers project both view models, own selection/navigation,
 * and persist the active mode. The panel owns only header chrome and delegates
 * ephemeral GPU interaction to mn-graph-three. No stores or backend calls.
 *
 * Two renderers draw the same scope. `renderer` picks the 3-D scene or the
 * wire atlas (mn-wire-atlas); `viewMode` is the scope, shared by both. In the
 * atlas, "This document" is the open document's two-hop wire neighborhood,
 * which the panel enters once the atlas reports it is ready, and re-enters
 * after the atlas was parked (the atlas leaves its neighborhood when inactive).
 */

import { LitElement, css, html, nothing, unsafeCSS, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { SkinAware } from './skin-aware.js'
import { icon, iconStyles } from './icons.js'
import type {
  MnGraphThreeEdge,
  MnGraphThreeNode,
  MnGraphThreeNodeKind,
  MnGraphThreeViewMode,
} from './mn-graph-three.js'
import type { MnWireAtlas } from './mn-wire-atlas.js'
import './mn-empty-state.js'
import './mn-graph-three.js'
import './mn-loading.js'
import './mn-wire-atlas.js'

export type MnGraphPanelStatus = 'idle' | 'loading' | 'ready' | 'error'
export type MnGraphPanelRenderer = 'atlas' | '3d'

/** How often a visible atlas asks its host for news (the host's freshness guard decides). */
export const ATLAS_REFRESH_CADENCE_MS = 60_000

export interface MnGraphPanelRendererChangeDetail {
  readonly renderer: MnGraphPanelRenderer
}

/** Asks the host for a snapshot: on showing the atlas, or on Refresh (force). */
export interface MnGraphPanelAtlasActivateDetail {
  readonly force: boolean
}

interface AtlasNeighborhoodChangeDetail {
  readonly graphId: string
  readonly documentId: string | null
  readonly reason: 'user' | 'host' | 'inactive' | 'snapshot' | 'graph'
}
export type MnGraphPanelNodeKind = MnGraphThreeNodeKind

export interface MnGraphPanelNode extends MnGraphThreeNode {
  readonly kind?: MnGraphPanelNodeKind
  readonly graphId?: string | null
  readonly documentId?: string | null
  readonly artifactId?: string | null
  readonly folderId?: string | null
  readonly tagName?: string | null
  readonly section?: 'documents' | 'artifacts' | 'tags' | string | null
  readonly parentId?: string | null
  readonly mimeType?: string | null
  readonly fileType?: string | null
  readonly status?: string | null
  readonly ingestedDocumentId?: string | null
}

export interface MnGraphPanelEdge extends MnGraphThreeEdge {
  readonly note?: string
}

export interface MnGraphPanelRefreshDetail {
  readonly reason: 'manual'
}

export interface MnGraphPanelNodeOpenDetail {
  readonly id: string
  readonly node: MnGraphPanelNode
}

export interface MnGraphPanelNodeSelectDetail {
  readonly id: string
  readonly node: MnGraphPanelNode
}

export interface MnGraphPanelEdgeSelectDetail {
  readonly edge: MnGraphPanelEdge
}

export interface MnGraphPanelViewModeChangeDetail {
  readonly mode: MnGraphThreeViewMode
}

@customElement('mn-graph-panel')
export class MnGraphPanel extends SkinAware(LitElement) {
  static styles = css`
    ${unsafeCSS(iconStyles)}

    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      background: var(--mn-color-surface-base, #fff);
      color: var(--mn-color-text-primary, #111827);
      font-family: var(--mn-font-chrome, system-ui, sans-serif);
      font-size: var(--mn-text-sm, 13px);
      box-sizing: border-box;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--mn-space-3, 12px);
      min-height: 48px;
      padding: var(--mn-space-2, 8px) var(--mn-space-3, 12px);
      border-bottom: 1px solid var(--mn-color-border-subtle, #e5e7eb);
      background: var(--mn-color-panel-bg, rgba(255, 255, 255, 0.92));
      box-sizing: border-box;
      flex: 0 0 auto;
    }

    .title-wrap {
      min-width: 0;
    }

    .title {
      display: flex;
      align-items: center;
      gap: var(--mn-space-2, 8px);
      margin: 0;
      color: var(--mn-color-text-secondary, #374151);
      font-size: var(--mn-text-sm, 13px);
      font-weight: 700;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .subtitle {
      display: block;
      margin-top: 2px;
      overflow: hidden;
      color: var(--mn-color-text-tertiary, #6b7280);
      font-size: var(--mn-text-xs, 12px);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .actions {
      display: inline-flex;
      align-items: center;
      gap: var(--mn-space-1, 4px);
      flex: 0 0 auto;
    }

    .count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 20px;
      padding: 0 7px;
      border-radius: 999px;
      background: var(--mn-color-surface-accent, #eef2ff);
      color: var(--mn-color-text-accent, #1d4ed8);
      font-size: var(--mn-text-xs, 12px);
      font-weight: 700;
      box-sizing: border-box;
    }

    .icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-control, 6px);
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-secondary, #374151);
      cursor: pointer;
      box-sizing: border-box;
    }

    .text-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 30px;
      padding: 0 var(--mn-space-2, 8px);
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-control, 6px);
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-secondary, #374151);
      font: 700 var(--mn-text-xs, 12px)/1 var(--mn-font-chrome, system-ui, sans-serif);
      cursor: pointer;
      box-sizing: border-box;
    }

    .icon-button:hover,
    .text-button:hover {
      background: var(--mn-color-surface-hover, #f3f4f6);
      color: var(--mn-color-text-primary, #111827);
    }

    .body {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      box-sizing: border-box;
      background: #2a3328;
    }

    .state {
      min-height: 180px;
      display: grid;
      align-content: center;
    }

    .body.atlas {
      background: var(--mn-color-surface-base, #faf8f2);
    }

    mn-wire-atlas {
      display: flex;
      width: 100%;
      height: 100%;
      min-height: 0;
    }

    .renderer-toggle {
      display: inline-flex;
      margin-bottom: 4px;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-control, 6px);
      overflow: hidden;
    }

    .segment {
      min-height: 24px;
      padding: 0 var(--mn-space-2, 8px);
      border: 0;
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-tertiary, #6b7280);
      font: 700 var(--mn-text-xs, 12px)/1 var(--mn-font-chrome, system-ui, sans-serif);
      cursor: pointer;
    }

    .segment + .segment {
      border-left: 1px solid var(--mn-color-border-subtle, #d1d5db);
    }

    .segment[aria-pressed='true'] {
      background: var(--mn-color-surface-accent, #eef2ff);
      color: var(--mn-color-text-accent, #1d4ed8);
    }

    mn-graph-three {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 0;
    }

    @media (max-width: 460px) {
      .header {
        align-items: flex-start;
      }

      .count,
      .center-label {
        display: none;
      }
    }
  `

  @property({ type: String }) title = 'Graph'
  @property({ type: String }) subtitle = ''
  @property({ type: String }) status: MnGraphPanelStatus = 'idle'
  @property({ type: String }) error = ''
  @property({ attribute: false }) nodes: readonly MnGraphPanelNode[] = []
  @property({ attribute: false }) edges: readonly MnGraphPanelEdge[] = []
  @property({ attribute: false }) documentNodes: readonly MnGraphPanelNode[] = []
  @property({ attribute: false }) documentEdges: readonly MnGraphPanelEdge[] = []
  @property({ type: String, attribute: 'view-mode', reflect: true }) viewMode: MnGraphThreeViewMode = 'workspace'
  @property({ type: Boolean, attribute: 'lock-workspace-mode' }) lockWorkspaceMode = false
  @property({ type: String, attribute: 'selected-node-id' }) selectedNodeId = ''
  @property({ type: Boolean, attribute: 'can-navigate-back' }) canNavigateBack = false
  @property({ type: Boolean, attribute: 'can-navigate-forward' }) canNavigateForward = false
  /** False while the panel is parked out of sight; the graph stops drawing. */
  @property({ type: Boolean }) active = true
  @property({ type: String, reflect: true }) renderer: MnGraphPanelRenderer = '3d'
  @property({ type: String, attribute: 'atlas-graph-id' }) atlasGraphId = ''
  /** AtlasSnapshot & { graphId }, owned by the host. */
  @property({ attribute: false }) atlasSnapshot: unknown = null
  @property({ attribute: false }) atlasSavedLayout: unknown = null
  @property({ type: String, attribute: 'atlas-status' }) atlasStatus: MnGraphPanelStatus = 'idle'
  @property({ type: String, attribute: 'atlas-error' }) atlasError = ''
  /** The editor's open document: the center of "This document" in the atlas. */
  @property({ type: String, attribute: 'document-id' }) documentId = ''

  @state() private _atlasNotice = ''
  private _atlasReady = false
  /**
   * The editor document this panel last entered the atlas for. Not where the
   * atlas is now: the person may walk on from it to other neighborhoods, and
   * the panel must not pull them back while the editor stays put.
   */
  private _enteredFor: string | null = null
  /** The person left this document's neighborhood; do not re-enter it until the scope or the document changes. */
  private _declined: string | null = null
  /** The entry in flight. Its generation fences a late answer from an older request. */
  private _entering: { documentId: string; generation: number } | null = null
  private _entryGeneration = 0
  /** A failed entry is not retried against the same snapshot. */
  private _failedEntry: { documentId: string; snapshot: unknown } | null = null
  /** Graph/document pairs that already spent their one automatic refresh. */
  private readonly _autoRefreshed = new Set<string>()
  private _atlasShowing = false
  private _atlasShownGraph = ''
  private _refreshTimer: ReturnType<typeof setInterval> | undefined

  /** The atlas draws only when the host supplied one; otherwise 3D. */
  private get _usesAtlas(): boolean {
    return this.renderer === 'atlas' && !!this.atlasGraphId
  }

  disconnectedCallback(): void {
    this._stopRefreshCadence()
    this._atlasShowing = false
    super.disconnectedCallback()
  }

  protected willUpdate(changes: Map<PropertyKey, unknown>): void {
    if (changes.has('viewMode') || changes.has('documentId')) this._declined = null
    if (changes.has('atlasGraphId')) this._forgetEntry()
  }

  protected updated(changes: Map<PropertyKey, unknown>): void {
    super.updated(changes)
    const showing = this._usesAtlas && this.active
    // Shown, or shown for another graph: ask the host for that graph's map.
    if (showing && (!this._atlasShowing || this._atlasShownGraph !== this.atlasGraphId)) {
      this._emit<MnGraphPanelAtlasActivateDetail>('mn-graph-panel-atlas-activate', { force: false })
    }
    if (showing) this._startRefreshCadence()
    else {
      this._stopRefreshCadence()
      // Parked or unmounted: the atlas has left its neighborhood, and a
      // detached atlas cannot tell us it is no longer ready.
      this._atlasReady = false
      this._enteredFor = null
      this._cancelEntry()
    }
    this._atlasShowing = showing
    this._atlasShownGraph = showing ? this.atlasGraphId : ''
    this._syncAtlasScope()
  }

  /**
   * While the atlas is in view, ask again now and then; the host's freshness
   * guard decides whether that is a read. Edits made while it stays open
   * reach it without a Refresh.
   */
  private _startRefreshCadence(): void {
    if (this._refreshTimer !== undefined) return
    this._refreshTimer = setInterval(() => {
      this._emit<MnGraphPanelAtlasActivateDetail>('mn-graph-panel-atlas-activate', { force: false })
    }, ATLAS_REFRESH_CADENCE_MS)
  }

  private _stopRefreshCadence(): void {
    if (this._refreshTimer === undefined) return
    clearInterval(this._refreshTimer)
    this._refreshTimer = undefined
  }

  private _cancelEntry(): void {
    this._entering = null
    this._entryGeneration++
  }

  private _forgetEntry(): void {
    this._enteredFor = null
    this._declined = null
    this._failedEntry = null
    this._autoRefreshed.clear()
    this._atlasNotice = ''
    this._cancelEntry()
  }

  private _atlas(): MnWireAtlas | null {
    return this.shadowRoot?.querySelector('mn-wire-atlas') ?? null
  }

  /** Make the atlas show what the scope says. */
  private _syncAtlasScope(): void {
    if (!this._usesAtlas || !this.active) return
    const atlas = this._atlas()
    if (!atlas) return
    const want = this.viewMode === 'document' && this.documentId ? this.documentId : null
    if (want === null) {
      const inside = this._enteredFor !== null || this._entering !== null
      this._enteredFor = null
      this._cancelEntry()
      if (inside) atlas.returnToAtlas()
      if (this._atlasNotice) this._atlasNotice = ''
      return
    }
    if (want === this._enteredFor || want === this._entering?.documentId || want === this._declined || !this._atlasReady) return
    if (this._failedEntry?.documentId === want && this._failedEntry.snapshot === this.atlasSnapshot) return
    const generation = ++this._entryGeneration
    const graphId = this.atlasGraphId
    const snapshot = this.atlasSnapshot
    this._entering = { documentId: want, generation }
    const current = () => this._entering?.generation === generation
    atlas.enterDocumentNeighborhood(want).then(
      () => {
        if (!current()) return
        this._entering = null
        this._enteredFor = want
        this._failedEntry = null
        if (this._atlasNotice) this._atlasNotice = ''
      },
      (error: unknown) => {
        if (!current()) return
        this._entering = null
        this._failedEntry = { documentId: want, snapshot }
        const message = error instanceof Error ? error.message : String(error)
        if (/not in this atlas/i.test(message)) {
          this._atlasNotice = 'This document is not in the atlas yet.'
          // A document made since the snapshot: one automatic fresh read per
          // graph and document. Refresh stays available after that.
          const key = `${graphId}\u0000${want}`
          if (!this._autoRefreshed.has(key)) {
            this._autoRefreshed.add(key)
            this._emit<MnGraphPanelAtlasActivateDetail>('mn-graph-panel-atlas-activate', { force: true })
          }
        } else if (!/cancelled|superseded|not ready/i.test(message)) {
          this._atlasNotice = message
        }
      },
    )
  }

  private _onAtlasReadiness(event: CustomEvent<{ graphId: string; ready: boolean }>): void {
    this._atlasReady = event.detail.ready && event.detail.graphId === this.atlasGraphId
    this._syncAtlasScope()
  }

  private _onAtlasNeighborhood(event: CustomEvent<AtlasNeighborhoodChangeDetail>): void {
    // Only the person's own exit changes the scope, including an exit while
    // the panel's entry is still arranging. Walking on to another card's
    // neighborhood stays in it; parking, a graph switch or a snapshot that
    // drops the center leave the intended scope alone.
    const { documentId, reason } = event.detail
    if (reason !== 'user' || documentId !== null) return
    const left = this._enteredFor ?? this._entering?.documentId ?? null
    if (left === null) return
    this._declined = left
    this._enteredFor = null
    this._cancelEntry()
    if (this.viewMode === 'document') this._setViewMode('workspace')
  }

  private _setRenderer(renderer: MnGraphPanelRenderer): void {
    if (renderer === this.renderer) return
    this._emit<MnGraphPanelRendererChangeDetail>('mn-graph-panel-renderer-change', { renderer })
  }

  private _emit<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail, bubbles: true, composed: true }))
  }

  private _refresh(): void {
    this._emit<MnGraphPanelRefreshDetail>('mn-graph-panel-refresh', { reason: 'manual' })
    if (this._usesAtlas) {
      this._failedEntry = null
      this._autoRefreshed.clear()
      this._emit<MnGraphPanelAtlasActivateDetail>('mn-graph-panel-atlas-activate', { force: true })
    }
  }

  private _selectNode(node: MnGraphPanelNode): void {
    this._emit<MnGraphPanelNodeSelectDetail>('mn-graph-panel-node-select', { id: node.id, node })
  }

  private _openNode(node: MnGraphPanelNode): void {
    this._emit<MnGraphPanelNodeOpenDetail>('mn-graph-panel-node-open', { id: node.id, node })
  }

  private _selectEdge(edge: MnGraphPanelEdge): void {
    this._emit<MnGraphPanelEdgeSelectDetail>('mn-graph-panel-edge-select', { edge })
  }

  private _setViewMode(mode: MnGraphThreeViewMode): void {
    if (this.lockWorkspaceMode || mode === this.viewMode) return
    this._emit<MnGraphPanelViewModeChangeDetail>('mn-graph-panel-view-mode-change', { mode })
  }

  private _navigateBack(): void {
    if (!this.canNavigateBack) return
    this.dispatchEvent(new CustomEvent('mn-graph-panel-navigate-back', { bubbles: true, composed: true }))
  }

  private _navigateForward(): void {
    if (!this.canNavigateForward) return
    this.dispatchEvent(new CustomEvent('mn-graph-panel-navigate-forward', { bubbles: true, composed: true }))
  }

  private _center(): void {
    this.shadowRoot?.querySelector<HTMLElement & { recenter?: () => void }>('mn-graph-three')?.recenter?.()
  }

  private _activeNodes(): readonly MnGraphPanelNode[] {
    return this.viewMode === 'document' ? this.documentNodes : this.nodes
  }

  private _activeEdges(): readonly MnGraphPanelEdge[] {
    return this.viewMode === 'document' ? this.documentEdges : this.edges
  }

  private _renderAtlas(): TemplateResult {
    if (!this.atlasSnapshot && this.atlasStatus === 'error') {
      return html`
        <div class="state">
          <mn-empty-state
            icon="alert-circle"
            title="Could not load the atlas"
            description=${this.atlasError || 'The wire read failed.'}
            mood="danger"
          ></mn-empty-state>
        </div>
      `
    }
    if (!this.atlasSnapshot) {
      return html`<div class="state"><mn-loading size="sm" text="Reading documents and wires"></mn-loading></div>`
    }
    return html`<mn-wire-atlas
      .snapshot=${this.atlasSnapshot}
      .graphId=${this.atlasGraphId}
      .savedLayout=${this.atlasSavedLayout}
      .active=${this.active}
      canOpenDocument
      @atlas-readiness-change=${this._onAtlasReadiness}
      @atlas-neighborhood-change=${this._onAtlasNeighborhood}
    ></mn-wire-atlas>`
  }

  private _renderRendererToggle(): TemplateResult | typeof nothing {
    // Only a host that supplies an atlas offers the choice.
    if (!this.atlasGraphId) return nothing
    return html`<span class="renderer-toggle" role="group" aria-label="Graph view">
      <button
        type="button"
        class="segment"
        aria-pressed=${this._usesAtlas ? 'true' : 'false'}
        title="Wire atlas: documents and the wires between them"
        @click=${() => this._setRenderer('atlas')}
      >Atlas</button>
      <button
        type="button"
        class="segment"
        aria-pressed=${this._usesAtlas ? 'false' : 'true'}
        title="3D: the whole graph and the open document's blocks"
        @click=${() => this._setRenderer('3d')}
      >3D</button>
    </span>`
  }

  private _renderAtlasHeader(): TemplateResult {
    const documentMode = this.viewMode === 'document'
    const notice = this._atlasNotice || (this.atlasSnapshot && this.atlasError ? `Showing the last complete map. ${this.atlasError}` : '')
    return html`
      <header class="header">
        <span class="title-wrap">
          ${this._renderRendererToggle()}
          ${notice ? html`<span class="subtitle" role="status" title=${notice}>${notice}</span>` : nothing}
        </span>
        <span class="actions">
          ${!this.lockWorkspaceMode && (this.documentId || documentMode)
            ? html`<button
                type="button"
                class="text-button"
                title=${documentMode ? 'Show the whole atlas' : "Show this document's wire neighborhood"}
                aria-label=${documentMode ? 'Show the whole graph' : 'Show this document'}
                @click=${() => this._setViewMode(documentMode ? 'workspace' : 'document')}
              >${documentMode ? 'Whole Graph' : 'This Document'}</button>`
            : nothing}
          <button
            type="button"
            class="icon-button"
            title="Refresh graph"
            aria-label="Refresh graph"
            @click=${this._refresh}
          >
            ${icon('refresh', { size: 15 })}
          </button>
        </span>
      </header>
      <div class="body atlas">${this._renderAtlas()}</div>
    `
  }

  private _renderBody(): TemplateResult | typeof nothing {
    if (this.status === 'idle' || this.status === 'loading') {
      return html`<div class="state"><mn-loading size="sm" text="Loading graph"></mn-loading></div>`
    }
    if (this.status === 'error') {
      return html`
        <div class="state">
          <mn-empty-state
            icon="alert-circle"
            title="Could not load graph"
            description=${this.error || 'The graph projection read failed.'}
            mood="danger"
          ></mn-empty-state>
        </div>
      `
    }
    const nodes = this._activeNodes()
    const edges = this._activeEdges()
    if (nodes.length === 0) {
      const documentMode = this.viewMode === 'document'
      return html`
        <div class="state">
          <mn-empty-state
            icon=${documentMode ? 'file-text' : 'graph-star'}
            title=${documentMode ? 'No document open' : 'Your space awaits'}
            description=${documentMode
              ? 'Open a document in the editor to visualize its structure.'
              : 'Create a document to see your ideas take shape in three dimensions.'}
          ></mn-empty-state>
        </div>
      `
    }
    return html`
      <mn-graph-three
        .nodes=${nodes}
        .edges=${edges}
        .viewMode=${this.viewMode}
        .selectedNodeId=${this.selectedNodeId}
        dimension="3d"
        interactive
        animated
        .active=${this.active}
        hint=${this.subtitle || this.title}
        @mn-graph-node-select=${(event: CustomEvent<MnGraphPanelNode>) => this._selectNode(event.detail)}
        @mn-graph-node-activate=${(event: CustomEvent<MnGraphPanelNode>) => this._openNode(event.detail)}
        @mn-graph-edge-select=${(event: CustomEvent<MnGraphPanelEdge>) => this._selectEdge(event.detail)}
      ></mn-graph-three>
    `
  }

  render(): TemplateResult {
    if (this._usesAtlas) return this._renderAtlasHeader()
    const nodeCount = this._activeNodes().length
    const edgeCount = this._activeEdges().length
    const documentMode = this.viewMode === 'document'
    const title = documentMode ? 'Document Structure' : this.title || 'Knowledge Space'
    const itemLabel = documentMode ? 'block' : 'item'
    const subtitle = this.subtitle || `${nodeCount} ${itemLabel}${nodeCount === 1 ? '' : 's'} / ${edgeCount} connection${edgeCount === 1 ? '' : 's'}`
    return html`
      <header class="header">
        <span class="title-wrap">
          ${this._renderRendererToggle()}
          <h2 class="title">${icon(documentMode ? 'file-text' : 'graph-star', { size: 15 })}${title}</h2>
          <span class="subtitle">${subtitle}</span>
        </span>
        <span class="actions">
          <button
            type="button"
            class="icon-button"
            title="Back"
            aria-label="Back to previous node"
            ?disabled=${!this.canNavigateBack}
            @click=${this._navigateBack}
          >
            ${icon('chevron-left', { size: 15 })}
          </button>
          <button
            type="button"
            class="icon-button"
            title="Forward"
            aria-label="Forward to next node"
            ?disabled=${!this.canNavigateForward}
            @click=${this._navigateForward}
          >
            ${icon('chevron-right', { size: 15 })}
          </button>
          <span class="count" title="Graph nodes">${nodeCount}</span>
          <button
            type="button"
            class="text-button"
            title="Center graph view"
            aria-label="Center graph view"
            @click=${this._center}
          >${icon('target', { size: 14 })}<span class="center-label">Center</span></button>
          ${!this.lockWorkspaceMode && (this.documentNodes.length > 0 || documentMode)
            ? html`<button
                type="button"
                class="text-button"
                title=${documentMode ? 'Show the whole graph' : 'Show this document'}
                aria-label=${documentMode ? 'Show the whole graph' : 'Show this document'}
                @click=${() => this._setViewMode(documentMode ? 'workspace' : 'document')}
              >${documentMode ? 'Whole Graph' : 'This Document'}</button>`
            : nothing}
          <button
            type="button"
            class="icon-button"
            title="Refresh graph"
            aria-label="Refresh graph"
            @click=${this._refresh}
          >
            ${icon('refresh', { size: 15 })}
          </button>
        </span>
      </header>
      <div class="body">${this._renderBody()}</div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-graph-panel': MnGraphPanel
  }
}
