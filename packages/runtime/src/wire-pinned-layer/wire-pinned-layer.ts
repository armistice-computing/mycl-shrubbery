import { LitElement, css, html, nothing, svg, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import {
  DEFAULT_WIRE_PREDICATE_URI,
  PREDICATE_GROUPS,
  getWirePredicateLabel,
} from '@shrubbery/nucleus'
import type { BlockWireRequestDetail } from '../editor-host.js'
import {
  WIRE_PINNED_BLOCK_CLOSE_EVENT,
  WIRE_PINNED_BLOCK_CONTEXT_REQUEST_EVENT,
  WIRE_PINNED_BLOCK_MOVE_EVENT,
  WIRE_PINNED_BLOCK_OPEN_EVENT,
  WIRE_PINNED_BLOCK_REFRESH_EVENT,
  WIRE_PINNED_DOC_CLOSE_EVENT,
  WIRE_PINNED_DOC_MOVE_EVENT,
  WIRE_PINNED_DOC_OPEN_EVENT,
  WIRE_PINNED_WIRE_CLOSE_EVENT,
  WIRE_PINNED_WIRE_CONTEXT_REQUEST_EVENT,
  WIRE_PINNED_WIRE_MOVE_EVENT,
  WIRE_PINNED_WIRE_OPEN_EVENT,
  WIRE_PINNED_WIRE_UPDATE_REQUEST_EVENT,
  WIRE_PINNED_WIRE_DELETE_REQUEST_EVENT,
  WIRE_PINNED_RESIZE_EVENT,
  type WirePinnedResizeDetail,
  type WirePinnedWireDeleteRequestDetail,
  type WirePinnedBlockCloseDetail,
  type WirePinnedBlockContextRequestDetail,
  type WirePinnedBlockMoveDetail,
  type WirePinnedBlockOpenDetail,
  type WirePinnedBlockRefreshDetail,
  type WirePinnedDocCloseDetail,
  type WirePinnedDocMoveDetail,
  type WirePinnedDocOpenDetail,
  type WirePinnedWireCloseDetail,
  type WirePinnedWireContextRequestDetail,
  type WirePinnedWireMoveDetail,
  type WirePinnedWireOpenDetail,
  type WirePinnedWireUpdateRequestDetail,
} from '../wire-events.js'

export interface PinnedWireDocument {
  readonly id: string
  readonly graphId: string
  readonly documentId: string
  readonly title: string
  readonly x: number
  readonly y: number
  /** Set once the person drags the card's corner. */
  readonly width?: number
  readonly height?: number
}

export interface PinnedWireBlock {
  readonly id: string
  readonly graphId: string
  readonly documentId: string
  readonly blockId: string
  readonly text: string
  readonly documentTitle: string
  readonly x: number
  readonly y: number
  readonly width?: number
  readonly height?: number
}

export interface PinnedWireNode {
  readonly id: string
  readonly wireId: string
  readonly graphId: string
  readonly predicate: string
  readonly predicateLabel: string
  readonly bidirectional: boolean
  readonly sourceGraphId: string
  readonly sourceDocumentId: string
  readonly sourceBlockId?: string | null
  readonly sourceTitle: string
  readonly sourceText: string
  readonly targetGraphId: string
  readonly targetDocumentId: string
  readonly targetBlockId?: string | null
  readonly targetTitle: string
  readonly targetText: string
  readonly x: number
  readonly y: number
  readonly width?: number
  readonly height?: number
  /**
   * Whether the card's top end is the wire's source. Reversing a wire swaps
   * source and target but leaves the card's two ends where they are, so the
   * host flips this instead. Missing means true.
   */
  readonly topIsSource?: boolean
}

export interface PinnedWireBlockContextBlock {
  readonly id: string
  readonly text: string
  readonly isTarget: boolean
}

export interface PinnedWireBlockContextData {
  readonly blocks: readonly PinnedWireBlockContextBlock[]
}

export type PinnedWireBlockContextState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message?: string }
  | { readonly status: 'ready'; readonly data: PinnedWireBlockContextData }

export type PinnedWireBlockContextMap =
  | ReadonlyMap<string, PinnedWireBlockContextState>
  | Readonly<Record<string, PinnedWireBlockContextState>>

export type PinnedWireNodeContextMap = PinnedWireBlockContextMap

/** The Wires tab's Expand context mark (wires-panel.ts panelIcon('layers')), so both say it the same way. */
const CONTEXT_ICON = svg`<path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" />`

@customElement('sh-wire-pinned-layer')
export class ShWirePinnedLayer extends LitElement {
  private static readonly DOC_CARD_WIDTH = 260
  private static readonly BLOCK_CARD_WIDTH = 300
  private static readonly WIRE_CARD_WIDTH = 340
  private static readonly MIN_CARD_WIDTH = 220
  private static readonly MAX_CARD_WIDTH = 720
  private static readonly MIN_CARD_HEIGHT = 120

  static styles = css`
    /* A pin is a piece of a document, so it reads in the document's own face
       (Appearance > Editor font sets --mn-editor-font on the root). The small
       controls keep the interface face so they read as controls. */
    :host {
      display: contents;
      font-family: var(--mn-editor-font, var(--mn-font-prose, Georgia, 'Times New Roman', serif));
    }


    .pinned-layer {
      position: fixed;
      inset: 0;
      z-index: var(--mn-z-wire-overlay, 800);
      pointer-events: none;
    }

    .pinned-wire,
    .pinned-doc,
    .pinned-block {
      position: absolute;
      width: ${ShWirePinnedLayer.DOC_CARD_WIDTH}px;
      min-height: 78px;
      border: 1px solid var(--mn-color-wire-200, #ddd6fe);
      border-top: 3px solid var(--mn-color-wire-400, #a78bfa);
      border-radius: 8px;
      background: var(--mn-color-surface-raised, #fff);
      box-shadow: 0 4px 24px rgba(15, 23, 42, 0.16);
      color: var(--mn-color-text-primary, #17202a);
      pointer-events: auto;
      box-sizing: border-box;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .titlebar,
    .actions,
    .wire-divider,
    .predicate-picker {
      flex: 0 0 auto;
    }

    .resize-handle {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      color: var(--mn-color-text-muted, #697386);
      opacity: 0.55;
      touch-action: none;
    }

    .resize-handle:hover {
      opacity: 1;
    }

    .resize-handle svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.5;
      stroke-linecap: round;
    }

    section[data-sized] .block-stack {
      flex: 1 1 auto;
      max-height: none;
    }

    .pinned-wire[data-sized] .wire-endpoint {
      flex: 1 1 0;
    }

    .pinned-wire {
      width: ${ShWirePinnedLayer.WIRE_CARD_WIDTH}px;
      min-height: 148px;
    }

    .wire-endpoint {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .pinned-block {
      width: ${ShWirePinnedLayer.BLOCK_CARD_WIDTH}px;
      min-height: 96px;
      border-color: var(--mn-color-wire-300, #c4b5fd);
      border-top-color: var(--mn-color-wire-400, #a78bfa);
    }

    .titlebar {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 5px 26px 4px 8px;
      cursor: grab;
      background: var(--mn-color-surface-base, #fff);
      border-bottom: 1px solid var(--mn-color-border-subtle, #e6e8eb);
      box-sizing: border-box;
    }

    .titlebar.dragging {
      cursor: grabbing;
    }

    .doc-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--mn-color-text-primary, #17202a);
      font-size: var(--mn-text-sm, 0.875rem);
      font-weight: 650;
      text-align: left;
      background: transparent;
      border: 0;
      padding: 0;
      cursor: pointer;
    }

    .wire-doc-label,
    .block-doc-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--mn-color-text-muted, #697386);
      font-size: var(--mn-text-2xs, 0.625rem);
      font-weight: 650;
      text-align: left;
      background: transparent;
      border: 0;
      padding: 0;
      cursor: pointer;
    }

    .wire-doc-label {
      color: var(--mn-color-text-secondary, #394150);
    }

    .wire-doc-label:hover,
    .block-doc-label:hover {
      color: var(--mn-color-text-primary, #17202a);
      text-decoration: underline;
    }

    .close {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 21px;
      height: 21px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--mn-color-text-muted, #697386);
      cursor: pointer;
      font: inherit;
      font-size: var(--mn-text-xs, 0.75rem);
      font-weight: 700;
      line-height: 1;
    }

    .close:hover {
      background: var(--mn-color-danger-surface, #fff1f1);
      color: var(--mn-color-danger-strong, #b42318);
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      padding: 6px 8px 8px;
    }

    .block-body {
      max-height: 176px;
      overflow: auto;
      padding: 6px 8px 2px;
      color: var(--mn-color-text-primary, #17202a);
      font-size: var(--mn-text-xs, 0.75rem);
      line-height: 1.5;
      white-space: pre-wrap;
    }

    .wire-body {
      max-height: 128px;
      overflow: auto;
      padding: 6px 8px;
      color: var(--mn-color-text-primary, #17202a);
      font-size: var(--mn-text-xs, 0.75rem);
      line-height: 1.5;
      white-space: pre-wrap;
    }

    .wire-divider {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 5px 8px;
      border-top: 1px solid var(--mn-color-border-subtle, #e6e8eb);
      border-bottom: 1px solid var(--mn-color-border-subtle, #e6e8eb);
      background: var(--mn-color-wire-50, #f5f3ff);
      color: var(--mn-color-wire-600, #7c3aed);
      font-size: var(--mn-text-xs, 0.75rem);
      font-weight: 650;
      text-align: center;
    }

    .wire-control {
      min-height: 21px;
      border: 1px solid var(--mn-color-border-subtle, #d0d7de);
      border-radius: 5px;
      background: var(--mn-color-surface-raised, #f6f8fa);
      color: var(--mn-color-text-secondary, #394150);
      cursor: pointer;
      font: inherit;
      font-size: var(--mn-text-2xs, 0.625rem);
      font-weight: 650;
      padding: 0 5px;
    }

    .wire-control:hover,
    .wire-control.active {
      border-color: var(--mn-color-wire-300, #c4b5fd);
      background: var(--mn-color-wire-100, #ede9fe);
      color: var(--mn-color-wire-700, #6d28d9);
    }

    .wire-control.danger:hover {
      border-color: var(--mn-color-danger-border, #e5a1a1);
      background: var(--mn-color-danger-surface, #fdecec);
      color: var(--mn-color-danger-strong, #b42318);
    }

    .wire-direction {
      min-width: 30px;
      font-size: var(--mn-text-sm, 0.875rem);
      font-weight: 600;
      line-height: 1;
    }

    .wire-control:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .wire-bidirectional {
      border: 1px solid var(--mn-color-border-subtle, #d0d7de);
      border-radius: 999px;
      color: var(--mn-color-text-muted, #697386);
      font-size: var(--mn-text-2xs, 0.625rem);
      line-height: 1;
      padding: 2px 4px;
      text-transform: uppercase;
    }

    .predicate-picker {
      display: grid;
      gap: 6px;
      padding: 7px 8px;
      border-bottom: 1px solid var(--mn-color-border-subtle, #e6e8eb);
      background: var(--mn-color-surface-base, #fff);
    }

    .predicate-group {
      display: grid;
      gap: 4px;
    }

    .predicate-group-label {
      color: var(--mn-color-text-muted, #697386);
      font-size: var(--mn-text-2xs, 0.625rem);
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .predicate-options {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .predicate-option {
      min-height: 21px;
      border: 1px solid var(--mn-color-border-subtle, #d0d7de);
      border-radius: 5px;
      background: var(--mn-color-surface-raised, #f6f8fa);
      color: var(--mn-color-text-secondary, #394150);
      cursor: pointer;
      font: inherit;
      font-size: var(--mn-text-2xs, 0.625rem);
      padding: 0 5px;
    }

    .predicate-option.selected {
      border-color: var(--mn-color-wire-300, #c4b5fd);
      background: var(--mn-color-wire-100, #ede9fe);
      color: var(--mn-color-wire-700, #6d28d9);
      font-weight: 650;
    }

    .block-placeholder {
      color: var(--mn-color-text-muted, #697386);
      font-style: italic;
    }

    .context-toggle {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 19px;
      margin-left: auto;
      padding: 0;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--mn-color-text-muted, #697386);
      cursor: pointer;
    }

    .context-toggle svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .context-toggle:hover {
      background: var(--mn-color-surface-active, #e9eef3);
      color: var(--mn-color-text-primary, #17202a);
    }

    .context-toggle.active {
      background: var(--mn-color-wire-100, #ede9fe);
      color: var(--mn-color-wire-700, #6d28d9);
    }

    .context-toggle:focus-visible {
      outline: 2px solid var(--mn-color-border-accent, #6aa4ff);
      outline-offset: 1px;
    }

    /* The pinned block with its neighbours: above, the block, below, in reading order. */
    .block-stack {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: auto;
    }

    .pinned-block .block-stack {
      max-height: 260px;
    }

    .pinned-wire .block-stack {
      max-height: 180px;
    }

    .block-stack .block-body,
    .block-stack .wire-body {
      max-height: none;
      overflow: visible;
    }

    .block-stack.open .block-body,
    .block-stack.open .wire-body {
      margin: 0 8px;
      padding: 3px 0 3px 6px;
      border-left: 2px solid var(--mn-color-wire-400, #a78bfa);
    }

    .context-blocks {
      display: grid;
      gap: 2px;
      padding: 3px 8px;
    }

    .context-blocks.above {
      padding-top: 6px;
    }

    .context-blocks.below {
      padding-bottom: 6px;
    }

    .context-block {
      border-left: 2px solid var(--mn-color-border-subtle, #d0d7de);
      padding: 2px 0 2px 6px;
      color: var(--mn-color-text-muted, #697386);
      font-size: var(--mn-text-2xs, 0.625rem);
      line-height: 1.45;
      white-space: pre-wrap;
    }

    .context-block.message {
      border-left-color: transparent;
      font-style: italic;
    }

    .action {
      min-height: 22px;
      border: 1px solid var(--mn-color-border-subtle, #d0d7de);
      border-radius: 6px;
      background: var(--mn-color-surface-base, #fff);
      color: var(--mn-color-text-secondary, #394150);
      cursor: pointer;
      font: inherit;
      font-size: var(--mn-text-xs, 0.75rem);
      font-weight: 600;
      padding: 0 7px;
    }

    .action:hover {
      border-color: var(--mn-color-border-accent, #6aa4ff);
      color: var(--mn-color-text-primary, #17202a);
    }

    /* A button does not inherit the font on its own; the titles should. */
    .doc-title,
    .wire-doc-label,
    .block-doc-label {
      font-family: inherit;
    }

    /* Last, so it wins over the buttons' font: inherit. */
    .close,
    .action,
    .wire-control,
    .predicate-option,
    .predicate-group-label {
      font-family: var(--mn-font-sans, system-ui, sans-serif);
    }
  `

  @property({ attribute: false })
  docs: readonly PinnedWireDocument[] = []

  @property({ attribute: false })
  nodes: readonly PinnedWireNode[] = []

  @property({ attribute: false })
  blocks: readonly PinnedWireBlock[] = []

  @property({ attribute: false })
  blockContexts: PinnedWireBlockContextMap | null = null

  @property({ attribute: false })
  nodeContexts: PinnedWireNodeContextMap | null = null

  @state()
  private dragging: { readonly id: string; readonly offsetX: number; readonly offsetY: number } | null = null

  @state()
  private resizing: {
    readonly id: string
    readonly startX: number
    readonly startY: number
    readonly startWidth: number
    readonly startHeight: number
    readonly left: number
    readonly top: number
  } | null = null

  @state()
  private expandedContextSlots: ReadonlySet<string> = new Set()

  @state()
  private openPredicateNodeId: string | null = null

  @state()
  private zOrder: readonly string[] = []

  private requestedNodeContextIds = new Set<string>()
  private requestedBlockContextIds = new Set<string>()

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('nodes') || changed.has('nodeContexts')) {
      this.requestMissingWireNodeContexts()
    }
    if (changed.has('blocks') || changed.has('blockContexts')) {
      this.requestMissingBlockContexts()
    }
  }

  private orderedPinnedIds(): readonly string[] {
    return [
      ...this.nodes.map((node) => node.id),
      ...this.docs.map((doc) => doc.id),
      ...this.blocks.map((block) => block.id),
    ]
  }

  private normalizedZOrder(): readonly string[] {
    const ids = this.orderedPinnedIds()
    const idSet = new Set(ids)
    const kept = this.zOrder.filter((id) => idSet.has(id))
    const keptSet = new Set(kept)
    return [
      ...ids.filter((id) => !keptSet.has(id)),
      ...kept,
    ]
  }

  private cardZIndex(id: string): number {
    const index = this.normalizedZOrder().indexOf(id)
    return 900 + Math.max(0, index)
  }

  private bringToFront(id: string): void {
    const ids = new Set(this.orderedPinnedIds())
    if (!ids.has(id)) return
    this.zOrder = [
      ...this.normalizedZOrder().filter((item) => item !== id),
      id,
    ]
  }

  private requestMissingWireNodeContexts(): void {
    const currentIds = new Set(this.orderedPinnedIds())
    for (const id of Array.from(this.requestedNodeContextIds)) {
      const nodeId = id.slice(0, id.lastIndexOf(':'))
      if (!currentIds.has(nodeId)) this.requestedNodeContextIds.delete(id)
    }
    for (const node of this.nodes) {
      for (const side of ['source', 'target'] as const) {
        const key = this.wireNodeContextKey(node, side)
        const blockId = side === 'source' ? node.sourceBlockId : node.targetBlockId
        if (!blockId || this.requestedNodeContextIds.has(key) || this.wireNodeContextFor(node, side)) continue
        this.requestedNodeContextIds.add(key)
        this.requestWireNodeContext(node, side)
      }
    }
  }

  private requestMissingBlockContexts(): void {
    const currentIds = new Set(this.blocks.map((block) => block.id))
    for (const id of Array.from(this.requestedBlockContextIds)) {
      if (!currentIds.has(id)) this.requestedBlockContextIds.delete(id)
    }
    for (const block of this.blocks) {
      if (this.requestedBlockContextIds.has(block.id) || this.blockContextFor(block.id)) continue
      this.requestedBlockContextIds.add(block.id)
      this.requestBlockContext(block)
    }
  }

  private openDoc(doc: PinnedWireDocument): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedDocOpenDetail>(WIRE_PINNED_DOC_OPEN_EVENT, {
        bubbles: true,
        composed: true,
        detail: { graphId: doc.graphId, documentId: doc.documentId },
      }),
    )
  }

  private closeDoc(doc: PinnedWireDocument): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedDocCloseDetail>(WIRE_PINNED_DOC_CLOSE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { id: doc.id },
      }),
    )
  }

  private moveDoc(doc: PinnedWireDocument, x: number, y: number): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedDocMoveDetail>(WIRE_PINNED_DOC_MOVE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { id: doc.id, x, y },
      }),
    )
  }

  private openWireNodeEndpoint(
    graphId: string,
    documentId: string,
    blockId: string | null | undefined,
  ): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedWireOpenDetail>(WIRE_PINNED_WIRE_OPEN_EVENT, {
        bubbles: true,
        composed: true,
        detail: { graphId, documentId, blockId },
      }),
    )
  }

  private requestWireDelete(node: PinnedWireNode): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedWireDeleteRequestDetail>(WIRE_PINNED_WIRE_DELETE_REQUEST_EVENT, {
        bubbles: true,
        composed: true,
        detail: { id: node.id, wireId: node.wireId },
      }),
    )
  }

  private closeWireNode(node: PinnedWireNode): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedWireCloseDetail>(WIRE_PINNED_WIRE_CLOSE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { id: node.id },
      }),
    )
  }

  private moveWireNode(node: PinnedWireNode, x: number, y: number): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedWireMoveDetail>(WIRE_PINNED_WIRE_MOVE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { id: node.id, x, y },
      }),
    )
  }

  private updateWireNode(
    node: PinnedWireNode,
    predicate: string,
    bidirectional: boolean,
    swap: boolean,
  ): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedWireUpdateRequestDetail>(WIRE_PINNED_WIRE_UPDATE_REQUEST_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          id: node.id,
          wireId: node.wireId,
          predicate,
          bidirectional,
          swap,
        },
      }),
    )
  }

  private requestWireNodeContext(
    node: PinnedWireNode,
    side: 'source' | 'target',
  ): void {
    const graphId = side === 'source' ? node.sourceGraphId : node.targetGraphId
    const documentId = side === 'source' ? node.sourceDocumentId : node.targetDocumentId
    const blockId = side === 'source' ? node.sourceBlockId : node.targetBlockId
    if (!blockId) return
    this.dispatchEvent(
      new CustomEvent<WirePinnedWireContextRequestDetail>(WIRE_PINNED_WIRE_CONTEXT_REQUEST_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          id: this.wireNodeContextKey(node, side),
          side,
          graphId,
          documentId,
          blockId,
        },
      }),
    )
  }

  private openBlock(block: PinnedWireBlock): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedBlockOpenDetail>(WIRE_PINNED_BLOCK_OPEN_EVENT, {
        bubbles: true,
        composed: true,
        detail: { graphId: block.graphId, documentId: block.documentId, blockId: block.blockId },
      }),
    )
  }

  private closeBlock(block: PinnedWireBlock): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedBlockCloseDetail>(WIRE_PINNED_BLOCK_CLOSE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { id: block.id },
      }),
    )
  }

  private moveBlock(block: PinnedWireBlock, x: number, y: number): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedBlockMoveDetail>(WIRE_PINNED_BLOCK_MOVE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { id: block.id, x, y },
      }),
    )
  }

  private refreshBlock(block: PinnedWireBlock): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedBlockRefreshDetail>(WIRE_PINNED_BLOCK_REFRESH_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          id: block.id,
          graphId: block.graphId,
          documentId: block.documentId,
          blockId: block.blockId,
        },
      }),
    )
  }

  private requestBlockContext(block: PinnedWireBlock): void {
    this.dispatchEvent(
      new CustomEvent<WirePinnedBlockContextRequestDetail>(WIRE_PINNED_BLOCK_CONTEXT_REQUEST_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          id: block.id,
          graphId: block.graphId,
          documentId: block.documentId,
          blockId: block.blockId,
        },
      }),
    )
  }

  private wireBlock(block: PinnedWireBlock, event: MouseEvent): void {
    this.dispatchEvent(
      new CustomEvent<BlockWireRequestDetail>('mn-block-wire-request', {
        bubbles: true,
        composed: true,
        detail: {
          graphId: block.graphId,
          documentId: block.documentId,
          blockId: block.blockId,
          clientX: event.clientX,
          clientY: event.clientY,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        },
      }),
    )
  }

  private contextFromMap(
    contexts: PinnedWireBlockContextMap | null,
    id: string,
  ): PinnedWireBlockContextState | null {
    if (!contexts) return null
    const maybeMap = contexts as ReadonlyMap<string, PinnedWireBlockContextState>
    if (typeof maybeMap.get === 'function') return maybeMap.get(id) ?? null
    return (contexts as Readonly<Record<string, PinnedWireBlockContextState>>)[id] ?? null
  }

  private blockContextFor(blockId: string): PinnedWireBlockContextState | null {
    return this.contextFromMap(this.blockContexts, blockId)
  }

  private wireNodeContextKey(node: PinnedWireNode, side: 'source' | 'target'): string {
    return `${node.id}:${side}`
  }

  private wireNodeContextFor(node: PinnedWireNode, side: 'source' | 'target'): PinnedWireBlockContextState | null {
    return this.contextFromMap(this.nodeContexts, this.wireNodeContextKey(node, side))
  }

  private contextSlotKey(block: PinnedWireBlock): string {
    return block.id
  }

  private wireNodeContextSlotKey(node: PinnedWireNode, side: 'source' | 'target'): string {
    const ends = [
      `${node.sourceDocumentId}#${node.sourceBlockId ?? ''}`,
      `${node.targetDocumentId}#${node.targetBlockId ?? ''}`,
    ].sort()
    const self = side === 'source'
      ? `${node.sourceDocumentId}#${node.sourceBlockId ?? ''}`
      : `${node.targetDocumentId}#${node.targetBlockId ?? ''}`
    return `wire:${node.graphId}:${ends.join('|')}:${self}`
  }

  private toggleBlockContext(block: PinnedWireBlock): void {
    const slotKey = this.contextSlotKey(block)
    const next = new Set(this.expandedContextSlots)
    if (next.has(slotKey)) {
      next.delete(slotKey)
    } else {
      next.add(slotKey)
      if (!this.blockContextFor(block.id)) this.requestBlockContext(block)
    }
    this.expandedContextSlots = next
  }

  private toggleWireNodeContext(node: PinnedWireNode, side: 'source' | 'target'): void {
    const slotKey = this.wireNodeContextSlotKey(node, side)
    const next = new Set(this.expandedContextSlots)
    if (next.has(slotKey)) {
      next.delete(slotKey)
    } else {
      next.add(slotKey)
      if (!this.wireNodeContextFor(node, side)) this.requestWireNodeContext(node, side)
    }
    this.expandedContextSlots = next
  }

  private renderContextToggle(open: boolean, onToggle: () => void, endpoint?: 'source' | 'target'): TemplateResult {
    const label = open ? 'Collapse context' : 'Expand context'
    return html`<button
      type="button"
      class="context-toggle ${open ? 'active' : ''}"
      data-pinned-context-toggle
      data-wire-endpoint=${endpoint ?? nothing}
      title=${label}
      aria-label=${label}
      aria-expanded=${String(open)}
      @pointerdown=${(event: Event) => event.stopPropagation()}
      @click=${onToggle}
    ><svg viewBox="0 0 24 24" aria-hidden="true">${CONTEXT_ICON}</svg></button>`
  }

  /** The two blocks before (or after) the pinned one, set right against it. */
  private renderContextSide(
    state: PinnedWireBlockContextState | null,
    direction: 'above' | 'below',
  ): TemplateResult | typeof nothing {
    if (!state || state.status === 'loading') {
      return direction === 'above'
        ? html`<div class="context-blocks above"><div class="context-block message">Loading…</div></div>`
        : nothing
    }
    if (state.status === 'error') {
      return direction === 'above'
        ? html`<div class="context-blocks above"><div class="context-block message">Couldn't load the blocks around this one.</div></div>`
        : nothing
    }
    const blocks = state.data.blocks
    const targetIndex = blocks.findIndex((entry) => entry.isTarget)
    if (targetIndex < 0) return nothing
    const visible = direction === 'above'
      ? blocks.slice(Math.max(0, targetIndex - 2), targetIndex)
      : blocks.slice(targetIndex + 1, targetIndex + 3)
    if (visible.length === 0) {
      const edge = direction === 'above' ? 'Start of the document' : 'End of the document'
      return html`<div class="context-blocks ${direction}"><div class="context-block message">${edge}</div></div>`
    }
    return html`<div class="context-blocks ${direction}" data-pinned-context=${direction}>${visible.map((entry) => html`<div class="context-block">${entry.text}</div>`)}</div>`
  }

  private onTitlePointerDown(event: PointerEvent, doc: PinnedWireDocument): void {
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    if (typeof target.setPointerCapture === 'function' && Number.isFinite(event.pointerId)) {
      target.setPointerCapture(event.pointerId)
    }
    target.classList.add('dragging')
    this.bringToFront(doc.id)
    this.dragging = {
      id: doc.id,
      offsetX: event.clientX - doc.x,
      offsetY: event.clientY - doc.y,
    }
  }

  private onTitlePointerMove(event: PointerEvent, doc: PinnedWireDocument): void {
    const drag = this.dragging
    if (!drag || drag.id !== doc.id) return
    const view = this.ownerDocument.defaultView
    const cardWidth = doc.width ?? ShWirePinnedLayer.DOC_CARD_WIDTH
    const maxX = Math.max(0, (view?.innerWidth ?? cardWidth) - cardWidth - 8)
    const maxY = Math.max(0, (view?.innerHeight ?? 120) - 40)
    const x = Math.max(0, Math.min(maxX, event.clientX - drag.offsetX))
    const y = Math.max(0, Math.min(maxY, event.clientY - drag.offsetY))
    this.moveDoc(doc, x, y)
  }

  private onBlockTitlePointerDown(event: PointerEvent, block: PinnedWireBlock): void {
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    if (typeof target.setPointerCapture === 'function' && Number.isFinite(event.pointerId)) {
      target.setPointerCapture(event.pointerId)
    }
    target.classList.add('dragging')
    this.bringToFront(block.id)
    this.dragging = {
      id: block.id,
      offsetX: event.clientX - block.x,
      offsetY: event.clientY - block.y,
    }
  }

  private onBlockTitlePointerMove(event: PointerEvent, block: PinnedWireBlock): void {
    const drag = this.dragging
    if (!drag || drag.id !== block.id) return
    const view = this.ownerDocument.defaultView
    const cardWidth = block.width ?? ShWirePinnedLayer.BLOCK_CARD_WIDTH
    const maxX = Math.max(0, (view?.innerWidth ?? cardWidth) - cardWidth - 8)
    const maxY = Math.max(0, (view?.innerHeight ?? 120) - 40)
    const x = Math.max(0, Math.min(maxX, event.clientX - drag.offsetX))
    const y = Math.max(0, Math.min(maxY, event.clientY - drag.offsetY))
    this.moveBlock(block, x, y)
  }

  private onWireTitlePointerDown(event: PointerEvent, node: PinnedWireNode): void {
    event.preventDefault()
    const target = event.currentTarget as HTMLElement
    if (typeof target.setPointerCapture === 'function' && Number.isFinite(event.pointerId)) {
      target.setPointerCapture(event.pointerId)
    }
    target.classList.add('dragging')
    this.bringToFront(node.id)
    this.dragging = {
      id: node.id,
      offsetX: event.clientX - node.x,
      offsetY: event.clientY - node.y,
    }
  }

  private onWireTitlePointerMove(event: PointerEvent, node: PinnedWireNode): void {
    const drag = this.dragging
    if (!drag || drag.id !== node.id) return
    const view = this.ownerDocument.defaultView
    const cardWidth = node.width ?? ShWirePinnedLayer.WIRE_CARD_WIDTH
    const maxX = Math.max(0, (view?.innerWidth ?? cardWidth) - cardWidth - 8)
    const maxY = Math.max(0, (view?.innerHeight ?? 160) - 40)
    const x = Math.max(0, Math.min(maxX, event.clientX - drag.offsetX))
    const y = Math.max(0, Math.min(maxY, event.clientY - drag.offsetY))
    this.moveWireNode(node, x, y)
  }

  private cardStyle(
    item: { readonly x: number; readonly y: number; readonly width?: number; readonly height?: number },
    id: string,
    defaultWidth: number,
  ): string {
    const width = item.width ?? defaultWidth
    const height = item.height ? `height:${item.height}px;` : ''
    return `left:${item.x}px;top:${item.y}px;width:${width}px;${height}z-index:${this.cardZIndex(id)};`
  }

  private onResizePointerDown(event: PointerEvent, id: string): void {
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget as HTMLElement
    const card = handle.closest('section') as HTMLElement | null
    if (!card) return
    if (typeof handle.setPointerCapture === 'function' && Number.isFinite(event.pointerId)) {
      handle.setPointerCapture(event.pointerId)
    }
    this.bringToFront(id)
    this.resizing = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: card.offsetWidth,
      startHeight: card.offsetHeight,
      left: card.offsetLeft,
      top: card.offsetTop,
    }
  }

  private onResizePointerMove(event: PointerEvent, id: string): void {
    const size = this.resizing
    if (!size || size.id !== id) return
    const view = this.ownerDocument.defaultView
    const roomRight = (view?.innerWidth ?? 1200) - size.left - 8
    const roomDown = (view?.innerHeight ?? 800) - size.top - 8
    const maxWidth = Math.max(ShWirePinnedLayer.MIN_CARD_WIDTH, Math.min(ShWirePinnedLayer.MAX_CARD_WIDTH, roomRight))
    const maxHeight = Math.max(ShWirePinnedLayer.MIN_CARD_HEIGHT, roomDown)
    const width = Math.round(Math.max(ShWirePinnedLayer.MIN_CARD_WIDTH, Math.min(maxWidth, size.startWidth + event.clientX - size.startX)))
    const height = Math.round(Math.max(ShWirePinnedLayer.MIN_CARD_HEIGHT, Math.min(maxHeight, size.startHeight + event.clientY - size.startY)))
    this.dispatchEvent(
      new CustomEvent<WirePinnedResizeDetail>(WIRE_PINNED_RESIZE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { id, width, height },
      }),
    )
  }

  private onResizePointerUp(event: PointerEvent): void {
    const handle = event.currentTarget as HTMLElement
    if (
      typeof handle.hasPointerCapture === 'function' &&
      Number.isFinite(event.pointerId) &&
      handle.hasPointerCapture(event.pointerId)
    ) {
      handle.releasePointerCapture(event.pointerId)
    }
    this.resizing = null
  }

  private renderResizeHandle(id: string): TemplateResult {
    return html`<div
      class="resize-handle"
      data-pinned-resize
      title="Drag to resize"
      aria-hidden="true"
      @pointerdown=${(event: PointerEvent) => this.onResizePointerDown(event, id)}
      @pointermove=${(event: PointerEvent) => this.onResizePointerMove(event, id)}
      @pointerup=${(event: PointerEvent) => this.onResizePointerUp(event)}
      @pointercancel=${(event: PointerEvent) => this.onResizePointerUp(event)}
    ><svg viewBox="0 0 16 16">${svg`<path d="M14 6 6 14M14 10l-4 4" />`}</svg></div>`
  }

  private onTitlePointerUp(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement
    target.classList.remove('dragging')
    if (
      typeof target.hasPointerCapture === 'function' &&
      Number.isFinite(event.pointerId) &&
      target.hasPointerCapture(event.pointerId)
    ) {
      target.releasePointerCapture(event.pointerId)
    }
    this.dragging = null
  }

  private renderDoc(doc: PinnedWireDocument): TemplateResult {
    return html`
      <section
        class="pinned-doc"
        data-wire-pinned-doc
        data-pinned-doc-id=${doc.id}
        style=${this.cardStyle(doc, doc.id, ShWirePinnedLayer.DOC_CARD_WIDTH)}
        ?data-sized=${Boolean(doc.height)}
        role="dialog"
        aria-modal="false"
        aria-label=${`Pinned document: ${doc.title}`}
        @pointerdown=${() => this.bringToFront(doc.id)}
      >
        <button
          type="button"
          class="close"
          data-wire-pinned-doc-close
          aria-label="Close pinned document"
          @click=${() => this.closeDoc(doc)}
        >x</button>
        <div
          class="titlebar"
          data-wire-pinned-doc-drag
          @pointerdown=${(event: PointerEvent) => this.onTitlePointerDown(event, doc)}
          @pointermove=${(event: PointerEvent) => this.onTitlePointerMove(event, doc)}
          @pointerup=${(event: PointerEvent) => this.onTitlePointerUp(event)}
          @pointercancel=${(event: PointerEvent) => this.onTitlePointerUp(event)}
        >
          <button
            type="button"
            class="doc-title"
            data-wire-pinned-doc-title
            title=${doc.title}
            @click=${() => this.openDoc(doc)}
          >${doc.title}</button>
        </div>
        <div class="actions">
          <button type="button" class="action" data-wire-pinned-doc-open @click=${() => this.openDoc(doc)}>Open</button>
        </div>
        ${this.renderResizeHandle(doc.id)}
      </section>
    `
  }

  private wireNodeEndpointText(
    node: PinnedWireNode,
    side: 'source' | 'target',
    snippet: string,
  ): string {
    const state = this.wireNodeContextFor(node, side)
    if (state?.status !== 'ready') return snippet
    return state.data.blocks.find((entry) => entry.isTarget)?.text ?? snippet
  }

  private renderWireEndpoint(
    node: PinnedWireNode,
    title: string,
    text: string,
    graphId: string,
    documentId: string,
    blockId: string | null | undefined,
    side: 'source' | 'target',
    dragNode: PinnedWireNode | null = null,
  ): TemplateResult {
    const body = this.wireNodeEndpointText(node, side, text).trim()
    const open = Boolean(blockId) && this.expandedContextSlots.has(this.wireNodeContextSlotKey(node, side))
    const state = open ? this.wireNodeContextFor(node, side) : null
    const drag = dragNode
    return html`
      <div class="wire-endpoint" data-wire-endpoint-section=${side}>
        <div
          class="titlebar"
          data-wire-pinned-wire-endpoint
          data-wire-endpoint=${side}
          data-wire-pinned-wire-drag=${drag ? '' : nothing}
          @pointerdown=${(event: PointerEvent) => { if (drag) this.onWireTitlePointerDown(event, drag) }}
          @pointermove=${(event: PointerEvent) => { if (drag) this.onWireTitlePointerMove(event, drag) }}
          @pointerup=${(event: PointerEvent) => { if (drag) this.onTitlePointerUp(event) }}
          @pointercancel=${(event: PointerEvent) => { if (drag) this.onTitlePointerUp(event) }}
        >
          <button
            type="button"
            class="wire-doc-label"
            data-wire-pinned-wire-endpoint-title
            data-wire-pinned-wire-source-title=${side === 'source' ? '' : nothing}
            data-wire-endpoint=${side}
            title=${title}
            @click=${() => this.openWireNodeEndpoint(graphId, documentId, blockId)}
          >${title}</button>
          ${blockId ? this.renderContextToggle(open, () => this.toggleWireNodeContext(node, side), side) : nothing}
        </div>
        <div class="block-stack ${open ? 'open' : ''}">
          ${open ? this.renderContextSide(state, 'above') : nothing}
          <div class="wire-body" data-wire-pinned-wire-endpoint-body data-wire-pinned-wire-source-body=${side === 'source' ? '' : nothing} data-wire-endpoint=${side}>${body
            ? body
            : blockId
              ? html`<span class="block-placeholder">Empty block</span>`
              : html`<span class="block-placeholder">No block preview</span>`}</div>
          ${open ? this.renderContextSide(state, 'below') : nothing}
        </div>
      </div>
    `
  }

  private renderPredicatePicker(node: PinnedWireNode): TemplateResult {
    const groups = [
      [
        'Default',
        {
          predicates: [
            {
              uri: DEFAULT_WIRE_PREDICATE_URI,
              label: getWirePredicateLabel(DEFAULT_WIRE_PREDICATE_URI),
              description: 'General association',
            },
          ],
        },
      ] as const,
      ...Object.entries(PREDICATE_GROUPS),
    ]
    return html`
      <div class="predicate-picker" data-wire-pinned-wire-predicate-picker>
        ${groups.map(([groupName, category]) => html`
          <div class="predicate-group">
            <div class="predicate-group-label">${groupName}</div>
            <div class="predicate-options">
              ${category.predicates.map((predicate) => html`
                <button
                  type="button"
                  class="predicate-option ${node.predicate === predicate.uri ? 'selected' : ''}"
                  data-wire-pinned-wire-predicate-option
                  data-predicate-uri=${predicate.uri}
                  title=${predicate.description ?? predicate.label}
                  @click=${() => {
                    this.openPredicateNodeId = null
                    if (predicate.uri !== node.predicate) {
                      this.updateWireNode(node, predicate.uri, node.bidirectional, false)
                    }
                  }}
                >${predicate.label}</button>
              `)}
            </div>
          </div>
        `)}
      </div>
    `
  }

  /**
   * One button for the wire's direction, read against the card: → the top
   * block points to the bottom one, ← the bottom points to the top, ↔ both
   * ways. Each click moves to the next. Every change recreates the wire on the
   * host (the node has no edit for a wire, only create and delete).
   */
  private renderDirectionToggle(node: PinnedWireNode): TemplateResult {
    const topIsSource = node.topIsSource !== false
    const state = node.bidirectional ? 'both' : topIsSource ? 'down' : 'up'
    const glyph = state === 'both' ? '↔' : state === 'down' ? '→' : '←'
    const label = state === 'both'
      ? 'Points both ways. Click to point from the top block to the bottom one.'
      : state === 'down'
        ? 'Points from the top block to the bottom one. Click to reverse it.'
        : 'Points from the bottom block to the top one. Click to make it point both ways.'
    const next = (): void => {
      if (state === 'down') this.updateWireNode(node, node.predicate, false, true)
      else if (state === 'up') this.updateWireNode(node, node.predicate, true, false)
      else this.updateWireNode(node, node.predicate, false, !topIsSource)
    }
    return html`<button
      type="button"
      class="wire-control wire-direction ${state === 'both' ? 'active' : ''}"
      data-wire-pinned-wire-direction=${state}
      title=${label}
      aria-label=${label}
      @click=${next}
    >${glyph}</button>`
  }

  private renderWireNode(node: PinnedWireNode): TemplateResult {
    const predicateOpen = this.openPredicateNodeId === node.id
    const topIsSource = node.topIsSource !== false
    const source = (dragNode: PinnedWireNode | null): TemplateResult => this.renderWireEndpoint(
      node,
      node.sourceTitle,
      node.sourceText,
      node.sourceGraphId,
      node.sourceDocumentId,
      node.sourceBlockId,
      'source',
      dragNode,
    )
    const target = (dragNode: PinnedWireNode | null): TemplateResult => this.renderWireEndpoint(
      node,
      node.targetTitle,
      node.targetText,
      node.targetGraphId,
      node.targetDocumentId,
      node.targetBlockId,
      'target',
      dragNode,
    )
    return html`
      <section
        class="pinned-wire"
        data-wire-pinned-wire
        data-pinned-wire-id=${node.id}
        style=${this.cardStyle(node, node.id, ShWirePinnedLayer.WIRE_CARD_WIDTH)}
        ?data-sized=${Boolean(node.height)}
        role="dialog"
        aria-modal="false"
        aria-label=${`Pinned wire: ${node.sourceTitle} ${node.predicateLabel} ${node.targetTitle}`}
        @pointerdown=${() => this.bringToFront(node.id)}
      >
        <button
          type="button"
          class="close"
          data-wire-pinned-wire-close
          aria-label="Close pinned wire"
          @click=${() => this.closeWireNode(node)}
        >x</button>
        ${topIsSource ? source(node) : target(node)}
        <div class="wire-divider" data-wire-pinned-wire-predicate title=${node.predicate}>
          ${this.renderDirectionToggle(node)}
          <button
            type="button"
            class="wire-control ${predicateOpen ? 'active' : ''}"
            data-wire-pinned-wire-predicate-button
            aria-expanded=${predicateOpen ? 'true' : 'false'}
            @click=${() => {
              this.openPredicateNodeId = predicateOpen ? null : node.id
            }}
          >${node.predicateLabel}</button>
          <button
            type="button"
            class="wire-control danger"
            data-wire-pinned-wire-delete
            title="Delete this wire"
            aria-label="Delete this wire"
            @click=${() => this.requestWireDelete(node)}
          >Delete</button>
        </div>
        ${predicateOpen ? this.renderPredicatePicker(node) : nothing}
        ${topIsSource ? target(null) : source(null)}
        ${this.renderResizeHandle(node.id)}
      </section>
    `
  }

  private renderBlock(block: PinnedWireBlock): TemplateResult {
    const text = block.text.trim()
    const open = this.expandedContextSlots.has(this.contextSlotKey(block))
    const state = open ? this.blockContextFor(block.id) : null
    return html`
      <section
        class="pinned-block"
        data-wire-pinned-block
        data-pinned-block-id=${block.id}
        style=${this.cardStyle(block, block.id, ShWirePinnedLayer.BLOCK_CARD_WIDTH)}
        ?data-sized=${Boolean(block.height)}
        role="dialog"
        aria-modal="false"
        aria-label=${`Pinned block: ${block.documentTitle}`}
        @pointerdown=${() => this.bringToFront(block.id)}
      >
        <button
          type="button"
          class="close"
          data-wire-pinned-block-close
          aria-label="Close pinned block"
          @click=${() => this.closeBlock(block)}
        >x</button>
        <div
          class="titlebar"
          data-wire-pinned-block-drag
          @pointerdown=${(event: PointerEvent) => this.onBlockTitlePointerDown(event, block)}
          @pointermove=${(event: PointerEvent) => this.onBlockTitlePointerMove(event, block)}
          @pointerup=${(event: PointerEvent) => this.onTitlePointerUp(event)}
          @pointercancel=${(event: PointerEvent) => this.onTitlePointerUp(event)}
        >
          <button
            type="button"
            class="block-doc-label"
            data-wire-pinned-block-title
            title=${block.documentTitle}
            @click=${() => this.openBlock(block)}
          >${block.documentTitle}</button>
          ${this.renderContextToggle(open, () => this.toggleBlockContext(block))}
        </div>
        <div class="block-stack ${open ? 'open' : ''}">
          ${open ? this.renderContextSide(state, 'above') : nothing}
          <div class="block-body" data-wire-pinned-block-body>${text ? text : html`<span class="block-placeholder">Empty block</span>`}</div>
          ${open ? this.renderContextSide(state, 'below') : nothing}
        </div>
        <div class="actions">
          <button type="button" class="action" data-wire-pinned-block-refresh @click=${() => this.refreshBlock(block)}>Refresh</button>
          <button type="button" class="action" data-wire-pinned-block-wire @click=${(event: MouseEvent) => this.wireBlock(block, event)}>Wire</button>
          <button type="button" class="action" data-wire-pinned-block-open @click=${() => this.openBlock(block)}>Open</button>
        </div>
        ${this.renderResizeHandle(block.id)}
      </section>
    `
  }

  override render(): TemplateResult | typeof nothing {
    if (this.nodes.length === 0 && this.docs.length === 0 && this.blocks.length === 0) return nothing
    return html`
      <div class="pinned-layer" data-wire-pinned-layer>
        ${this.nodes.map((node) => this.renderWireNode(node))}
        ${this.docs.map((doc) => this.renderDoc(doc))}
        ${this.blocks.map((block) => this.renderBlock(block))}
      </div>
    `
  }
}

export interface WirePinnedLayerMountOptions {
  readonly nodes?: readonly PinnedWireNode[] | null
  readonly docs?: readonly PinnedWireDocument[] | null
  readonly blocks?: readonly PinnedWireBlock[] | null
  readonly blockContexts?: PinnedWireBlockContextMap | null
  readonly nodeContexts?: PinnedWireNodeContextMap | null
}

export function mountWirePinnedLayer(options: WirePinnedLayerMountOptions = {}): TemplateResult {
  return html`<sh-wire-pinned-layer
    .nodes=${options.nodes ?? []}
    .docs=${options.docs ?? []}
    .blocks=${options.blocks ?? []}
    .blockContexts=${options.blockContexts ?? null}
    .nodeContexts=${options.nodeContexts ?? null}
  ></sh-wire-pinned-layer>`
}

declare global {
  interface HTMLElementTagNameMap {
    'sh-wire-pinned-layer': ShWirePinnedLayer
  }
}
