/**
 * editor-host.ts — <sh-editor-host>, the live Class-B EDITOR HOST (SE4).
 *
 * The editor stops being stamped INERT inside the split-tree arm (which made the
 * layout OWN the node — a violation of the Class-B law at component-library.ts:
 * "for classes B and C, the layout emits a position anchor and NEVER owns the
 * live node"). Instead:
 *   - the arm's center cell becomes an EMPTY position anchor (renderCenterSlotAnchor,
 *     in mount.ts), and
 *   - ONE <sh-editor-host> live node is mounted ONCE as a keyed sibling of the
 *     spine inside `.main` (mountEditorHost, in mount.ts).
 *
 * This element subscribes to an injected EditorHostBinding (a ReactiveSource —
 * D4, NOT @lit/context). Its body has TWO graduated states:
 *   - PRE-MOUNT (honest labelled placeholder): no-binding / error / loading /
 *     idle-with-no-provider render a labelled inert element (data-inert /
 *     data-mode probe attributes), never faked content;
 *   - LIVE (rung-3): when the binding carries an open `provider` (a contract.crdt
 *     ProviderHandle) and is ready, render() yields a STABLE mount-target <div>
 *     and a REAL collaborative TipTap Editor is imperatively mounted into it (via
 *     the sibling collab/ plane). The editor's recording history is owned by one
 *     room-level UndoManager — the kernel dropped its own (collaborative mode) —
 *     so undo is recorded EXACTLY once. See collab/live-editor + room-history.
 *
 * ISLAND DISCIPLINE: this top-level file is scanned by render-workspace-island.
 * test.ts and must import ONLY lit + @shrubbery/nucleus (+ sibling .js). It
 * therefore NEVER imports the collaboration runtime / @tiptap / the kernel
 * directly — the entire CRDT plane is delegated to the sibling subdir module
 * collab/live-editor.js (NOT top-level → not scanned → allowed the collab deps).
 * The opaque CrdtDoc never gets resolved to a concrete type here; that lives in
 * the collab module.
 *
 * NAMING: the element tag is `sh-editor-host` (sh- prefix), NOT `mn-`. The mn-
 * namespace is the Class-A/B/C vetted-library namespace resolved through
 * resolveSurfaceTag/COMPONENT_LIBRARY; the host is the POSITIONING AUTHORITY
 * that owns a Class-B node, so it must stay OFF persistenceOf by construction
 * (D7 — a pack can SELECT mn-document-editor but can never reach the host).
 *
 * POSITIONING: computeHostVars(anchorRect, mainRect) writes ONLY the four float
 * vars --editor-x/y/w/h relative to `.main`. R-FIXED-CB: it NEVER emits
 * transform/filter/clip-path/backdrop-filter/will-change/contain/perspective/
 * mask — any of those would establish a containing block and break the fixed/
 * absolute float. The element re-measures in updated()/ResizeObserver, finding
 * its anchor by getElementById('mn-main-editor') and its frame by closest('.main').
 *
 * HONEST CAVEAT: happy-dom has no layout engine (getBoundingClientRect → 0), so
 * the pixel positioning + a live EditorView's identity are Playwright/browser-
 * mode territory, DEFERRED not mocked. computeHostVars is proven via its pure
 * rect-math mirror; node-identity-survival is proven structurally in happy-dom.
 *
 * Dependencies: lit (+ lit/decorators.js) and a TYPE-ONLY import of
 * EditorHostState/EditorHostBinding from a sibling .js — no store/contract/CRDT.
 */

import { LitElement, html, css, nothing, unsafeCSS, type TemplateResult } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { customElement, property, state } from 'lit/decorators.js'
import type { EditorHostState, EditorHostBinding } from './editor-host-binding.js'
// The CRDT plane is quarantined to the collab/ SUBDIR (not island-scanned). The
// host knows only this factory + a structural Editor handle — no collab runtime
// or @tiptap import here.
import {
  collaborationCursorStyles,
  createLiveCollabEditor,
  editorSemanticStyles,
  liveHeadingOutline,
  liveZoomSnapshot,
  type EditorKernelOptions,
  type LiveCitationAttrs,
  type LiveDocumentJSON,
  type LiveHeadingOutlineEntry,
  type LiveSlashCommandId,
  type LiveTagChipAttrs,
  type LiveWikiLinkAttrs,
  type LiveZoomSnapshot,
  setLiveActiveComment,
  setLiveBlockControls,
  setLiveValueMarks,
  setLiveValueMarksOpen,
  type LiveValueMark,
  setLiveWireHighlight,
  setLiveWiredBlocks,
  liveImportanceViewTargets,
  type ImportanceViewTarget,
  type LiveBlockControlButton,
} from './collab/live-editor.js'
import type { BlockScore } from '@shrubbery/nucleus'
import { documentLevelWires } from './editor-services/wire-bundle-service.js'
import type { WireBundle, WireSummary } from './editor-services/wire-bundle-service.js'
import type { SalienceBundle } from './editor-services/salience-bundle-service.js'
import {
  signalIcon,
  nextImportance,
  FORGET_IMPORTANCE,
  nextValence,
  importanceIcon,
  isVeryImportant,
  hasUserImportance,
  valenceIcon,
  importanceLabel,
  valenceLabel,
  combinedImportance,
  combinedValence,
  canRenewFreshness,
  lastValuedLabel,
  renewLabel,
} from './editor-services/salience-bundle-service.js'
import {
  WIRE_HIGHLIGHT_BLOCK_EVENT,
  WIRE_DOCUMENT_REQUEST_EVENT,
  WIRE_PIN_WIRE_REQUEST_EVENT,
  type DocumentWireRequestDetail,
  type WireHighlightBlockDetail,
  type WirePinWireRequestDetail,
} from './wire-events.js'
import { OPEN_DOCUMENT_EVENT, type OpenDocumentDetail } from './editor-services/navigation-service.js'

/** Controlled graph projections listen for invalidation; no editor state leaks. */
export const EDITOR_STRUCTURE_CHANGE_EVENT = 'mn-editor-structure-change'

export interface EditorStructureChangeDetail {
  readonly reason: 'mounted' | 'transaction' | 'selection'
  readonly activeBlockId: string | null
}

/**
 * Fires only when the topmost-in-view heading changes (IntersectionObserver-
 * driven), decoupled from EDITOR_STRUCTURE_CHANGE_EVENT so scroll-position
 * highlighting doesn't route through the shell's structure-change rerender
 * gate — a consumer (e.g. a sidebar outline panel) listens for this directly.
 */
export const EDITOR_HEADING_IN_VIEW_EVENT = 'mn-editor-heading-in-view-change'

export interface EditorHeadingInViewDetail {
  readonly blockId: string | null
}

/**
 * Gutter-icon click request to rate a block's importance/valence. The host
 * itself holds no contract reference (it only displays `salienceBundle` and
 * emits intent) — the shell listens, calls `contract.salience.setUserValue`,
 * and re-renders with the updated bundle.
 */
export const SALIENCE_RATE_REQUEST_EVENT = 'mn-salience-rate-request'

/**
 * Gutter request to renew a block's freshness without changing its rating
 * ("this still matters"). Same shape of contract as the rate request: the
 * shell calls `contract.salience.renew` and re-renders with the result.
 */
export const SALIENCE_RENEW_REQUEST_EVENT = 'mn-salience-renew-request'

export interface SalienceRenewRequestDetail {
  readonly blockId: string
  /** The block's document, when it is not the open one (the importance view). */
  readonly documentId?: string
}

export interface SalienceRateRequestDetail {
  readonly blockId: string
  /** The block's document, when it is not the open one (the importance view). */
  readonly documentId?: string
  /** null | 0 | 3 | 5 */
  readonly importance: number | null
  /** null | -4 | 0 | 4 */
  readonly valence: number | null
}

/**
 * The importance view: gardend's read-only Geist page of the graph's most
 * important blocks (geist_important_blocks.rs). Its quotes are copies, so the
 * value controls on each quote rate the source block.
 */
export const IMPORTANCE_VIEW_DOCUMENT_ID = 'geist-important-blocks'

/**
 * The host found the importance view's source blocks (on open, and when the
 * view rebuilds). The shell reads their scores and sets `sourceSalienceScores`.
 */
export const IMPORTANCE_VIEW_SOURCES_EVENT = 'mn-importance-view-sources'

export interface ImportanceViewSourcesDetail {
  readonly targets: readonly ImportanceViewTarget[]
}

/** Key for `sourceSalienceScores`: a source document and block. */
/** Fired on the owner document when the open document is deleted. */
export const EDITOR_DOCUMENT_DELETED_EVENT = 'mn-editor-document-deleted'

/**
 * Numbered-list counters for the flat list model. List items are siblings
 * of the paragraphs around them, with depth in data-indent (0-6), so one
 * document-wide counter made every numbered list continue the one before it
 * (Eschaton, 2026-11-18: "the number never resets"). Each depth has its own
 * counter. A block that isn't a list item starts every depth over, a list
 * item starts the depths below it over, and a bullet or task item starts its
 * own depth over too, as a change of list type does in Markdown.
 */
export const LIST_COUNTER_MAX_INDENT = 6

export function numberedListCounterCss(): string {
  const depths = Array.from({ length: LIST_COUNTER_MAX_INDENT + 1 }, (_, depth) => depth)
  const names = (from: number) => depths.filter(depth => depth >= from).map(depth => `list-counter-${depth}`).join(' ')
  const root = '.editor-mount .ProseMirror'
  const indent = (depth: number) => (depth === 0 ? ':not([data-indent])' : `[data-indent='${depth}']`)
  const rules: string[] = [
    `${root} > [data-block-id]:not(li), ${root} > :is(p, h1, h2, h3, h4, h5, h6, blockquote, pre, hr, ul, ol, .tableWrapper) { counter-reset: ${names(0)}; }`,
  ]
  for (const depth of depths) {
    const below = depth < LIST_COUNTER_MAX_INDENT ? names(depth + 1) : ''
    rules.push(`${root} > li:not([data-list-type='ordered'])${indent(depth)} { counter-reset: ${names(depth)}; }`)
    rules.push(`${root} > li[data-list-type='ordered']${indent(depth)} { ${below ? `counter-reset: ${below}; ` : ''}counter-increment: list-counter-${depth}; }`)
    rules.push(`${root} > li[data-list-type='ordered']${indent(depth)} .list-item-number::before { content: counter(list-counter-${depth}) '.'; }`)
  }
  return rules.join('\n')
}

export function sourceScoreKey(documentId: string, blockId: string): string {
  return `${documentId}:${blockId}`
}

/**
 * Inline Lucide glyphs for the value gutter. `packages/runtime` has no
 * dependency on `@shrubbery/components` (confirmed while building the mini-TOC
 * icon in center-panes-host.ts), so icons are inlined the same safe way:
 * ONE flat `html` template per glyph, `<svg>…<path/>…</svg>` with no nested
 * sub-templates — the alternate pattern (a separate `html`-tagged sub-template
 * interpolated into an outer `<svg>`) was confirmed this same effort to
 * silently drop under happy-dom AND fail to render as real SVG in production
 * Chrome (an existing bug in this codebase's wires-panel.ts, not on the live
 * path here — do not copy it).
 */
/**
 * Path data per glyph, as STRINGS — not `html`-tagged sub-templates. A
 * separate `html`-tagged fragment interpolated into an outer `<svg>...</svg>`
 * template is exactly the pattern @shrubbery/components/icons.ts documents as
 * broken (confirmed this same effort, in wires-panel.ts: `childElementCount:
 * 0` under happy-dom, and in real Chrome the "path" survives insertion but
 * comes back outside the SVG namespace — not a real SVGPathElement, so
 * nothing paints). The fix, mirrored from icons.ts: build the WHOLE
 * `<svg>…</svg>` as one string and inject it with a single `unsafeHTML` —
 * the icon vocabulary here is fixed and internal, never untrusted input.
 */
const SALIENCE_ICON_PATHS: Readonly<Record<string, string>> = {
  'signal-zero': '<path d="M3 20h.01" /><path d="M7 20v-2" opacity="0.3" /><path d="M11 20v-6" opacity="0.3" /><path d="M15 20v-10" opacity="0.3" /><path d="M19 20v-14" opacity="0.3" />',
  'signal-low': '<path d="M3 20h.01" /><path d="M7 20v-2" /><path d="M11 20v-6" opacity="0.3" /><path d="M15 20v-10" opacity="0.3" /><path d="M19 20v-14" opacity="0.3" />',
  'signal-medium': '<path d="M3 20h.01" /><path d="M7 20v-2" /><path d="M11 20v-6" /><path d="M15 20v-10" opacity="0.3" /><path d="M19 20v-14" opacity="0.3" />',
  'signal-high': '<path d="M3 20h.01" /><path d="M7 20v-2" /><path d="M11 20v-6" /><path d="M15 20v-10" /><path d="M19 20v-14" opacity="0.3" />',
  'signal': '<path d="M3 20h.01" /><path d="M7 20v-2" /><path d="M11 20v-6" /><path d="M15 20v-10" /><path d="M19 20v-14" />',
  'flag': '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22V3" />',
  'flag-off': '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" opacity="0.35" /><path d="M4 22V3" opacity="0.35" />',
  'circle-slash': '<circle cx="12" cy="12" r="10" /><path d="m5 5 14 14" />',
  'sunrise': '<path d="M12 2v8" /><path d="m4.93 10.93 1.41 1.41" /><path d="M2 18h2" /><path d="M20 18h2" /><path d="m19.07 10.93-1.41 1.41" /><path d="M22 22H2" /><path d="m8 6 4-4 4 4" /><path d="M16 18a4 4 0 0 0-8 0" />',
  'eclipse': '<circle cx="12" cy="12" r="10" /><path d="M12 2a7 7 0 1 0 10 10" />',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
  'sun-moon': '<path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.9 4.9 1.4 1.4" /><path d="m17.7 17.7 1.4 1.4" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.3 17.7-1.4 1.4" /><path d="m19.1 4.9-1.4 1.4" /><circle cx="12" cy="12" r="4" />',
}

/** A block with no score yet, as a base for a rating made just now. */
function emptyBlockScore(blockId: string): BlockScore {
  return {
    blockId,
    documentId: '',
    cumulativeImportance: 0,
    cumulativeValence: 0,
    rawImportanceSum: 0,
    rawValenceSum: 0,
    importanceCount: 0,
    valenceCount: 0,
    compositeScore: 0,
    blockWireCount: 0,
    docWireCount: 0,
    lastValuatedAt: null,
    userImportance: null,
    userValence: null,
  }
}

function salienceIconSvg(name: string): string {
  const body = SALIENCE_ICON_PATHS[name] ?? SALIENCE_ICON_PATHS['flag-off']
  return `<svg class="salience-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
}

function salienceIcon(name: string): ReturnType<typeof unsafeHTML> {
  return unsafeHTML(salienceIconSvg(name))
}

// Conservative estimates covering the EXPANDED popover (icon stack + numbers
// panel) — the hotspot that opens this is the block's right edge, so an
// unclamped anchor near a narrow pane's right edge routinely pushes the
// popover partially or fully off-screen (mirrors the clamping
// mn-wire-radial-overlay already does for the same reason).
const SALIENCE_GUTTER_WIDTH_ESTIMATE = 140
const SALIENCE_GUTTER_HEIGHT_ESTIMATE = 140
const SALIENCE_GUTTER_MARGIN = 8

function clampSalienceOverlayAnchor(x: number, y: number): { readonly x: number; readonly y: number } {
  const vw = globalThis.innerWidth || 1024
  const vh = globalThis.innerHeight || 768
  const clampedX = Math.max(
    SALIENCE_GUTTER_MARGIN,
    Math.min(vw - SALIENCE_GUTTER_WIDTH_ESTIMATE - SALIENCE_GUTTER_MARGIN, x),
  )
  // The gutter is vertically centered on its anchor (`transform: translateY(-50%)`),
  // so clamping the center must leave room for half the estimated height above and below.
  const halfHeight = SALIENCE_GUTTER_HEIGHT_ESTIMATE / 2
  const clampedY = Math.max(
    SALIENCE_GUTTER_MARGIN + halfHeight,
    Math.min(vh - SALIENCE_GUTTER_MARGIN - halfHeight, y),
  )
  return { x: clampedX, y: clampedY }
}

/**
 * The structural handle the host exposes over a live collab editor — the SHIPPED
 * public surface other shell code (e.g. the picker glue) reaches through.
 *
 *   - getText()/destroy() — the original rung-3 surface;
 *   - insertWikiLink(attrs) — a thin pass-through to the real editor's
 *     `commands.insertWikiLink` (boolean = whether the command applied). This is the
 *     L1 widening: the picker glue inserts a WikiLink node through THIS public handle,
 *     not a private `_editor` cast. The attrs type is the kernel's WikiLinkAttrs,
 *     carried OPAQUELY via the sibling collab module's alias (LiveWikiLinkAttrs) so the
 *     island-scanned host imports no @shrubbery/editor-kernel.
 *   - getJSON() — the LOSSLESS read (W14.1). See its own doc comment below.
 */
export interface LiveEditorHandle {
  getText(): string
  /**
   * The live document as TipTap JSON — the lossless read of what the editor
   * currently holds, byte-for-byte what the real `Editor.getJSON()` returns.
   *
   * WHY THIS EXISTS (W14.1): `getText()` was the handle's only content read, and
   * it is a FLATTENING one — it drops marks, node attributes, code-fence
   * boundaries, and every wikilink's target. Any consumer that needs the
   * document itself (the SEELe workbench's source projection is the first) had
   * to either re-derive ProseMirror JSON from the provider's shared CRDT
   * document (the collab plane's own binding, at its own field name) or cast to
   * the host's private `_editor`. This accessor is the supported path; the
   * re-derivation route stays available as a documented escape hatch, not the
   * expected one.
   *
   * Read-only and side-effect-free: it dispatches nothing, mutates nothing, and
   * cannot become ambient authority. Prefer the host-level
   * `ShEditorHost.getDocumentJSON()` when the consumer outlives one EditorView
   * (this handle's identity dies with the view; the host's does not).
   */
  getJSON(): LiveDocumentJSON
  getActiveBlockId(): string | null
  /** Current caret/selection anchor in viewport coordinates for shell popovers. */
  getOverlayAnchorRect(): EditorOverlayAnchorRect | null
  restoreHtml(html: string): boolean
  insertWikiLink(attrs: LiveWikiLinkAttrs): boolean
  insertCitation(attrs: LiveCitationAttrs): boolean
  insertWikiLinkAt(range: { from: number; to: number }, attrs: LiveWikiLinkAttrs): boolean
  insertZoteroPromotion(promotion: LiveZoteroPromotion): LiveZoteroPromotionResult
  insertTagChipAt(range: { from: number; to: number }, attrs: LiveTagChipAttrs): boolean
  insertTagTextAt(range: { from: number; to: number }, name: string): boolean
  runSlashCommandAt(range: { from: number; to: number }, commandId: LiveSlashCommandId): Promise<boolean>
  setActiveComment(commentId: string | null, options?: { readonly scroll?: boolean }): boolean
  removeComment(commentId: string): boolean
  getZoomSnapshot(): LiveZoomSnapshot
  zoomIntoBlock(blockId: string): boolean
  zoomToAncestor(blockId: string): boolean
  zoomOut(): boolean
  /** Lift a block into move mode (the bubble menu's Move block). */
  startBlockMove(blockId: string): boolean
  /** Toggle inline editing while visual wire mode owns keyboard/pointer input. */
  setEditable(editable: boolean): void
  /** Resolve a rendered block by its stable id, including the historical block- alias. */
  getBlockElement(blockId: string): HTMLElement | null
  /** Return rendered wireable blocks in document order. */
  getOrderedBlockElements(): HTMLElement[]
  /** Focus the editor selection on a stable block id (graph → editor sync). */
  focusBlock(blockId: string): boolean
  /** The document's headings in order, for table-of-contents style navigation. */
  getHeadings(): LiveHeadingOutlineEntry[]
  /** The topmost-in-view heading's block id, or null (no headings / not scrolled to one yet). */
  getCurrentHeadingId(): string | null
  /** Run one of the outliner's structural commands (collapse/zoom/move/select). */
  runOutlinerCommand(command: LiveOutlinerCommand): void
  destroy(): void
}

/** Re-exported so consumers can name what `getJSON()` returns without importing the collab plane. */
export type { LiveDocumentJSON }

/**
 * One content-change notification (W14.1(b)). `json` is the document AT THE
 * MOMENT the notification fired — carried, not merely pullable, so a consumer
 * cannot accidentally read a newer document than the one it was told about and
 * then attribute the newer bytes to the older event.
 *
 * `json` is `null` only for the "the pane no longer has a live body" edge (the
 * editor was torn down while subscribers remained). `reason` is the structural
 * trigger that ultimately produced the change; it is diagnostic, not a
 * contract — content-equality, not the reason, decides whether a notification
 * fires at all.
 */
export interface EditorContentChange {
  readonly json: LiveDocumentJSON | null
  readonly reason: EditorContentChangeReason
}

/**
 * The structure-change reasons, plus `'teardown'` — the one trigger that has no
 * structure-change counterpart because there is no longer an editor to describe.
 */
export type EditorContentChangeReason = EditorStructureChangeDetail['reason'] | 'teardown'

export interface EditorContentSubscribeOptions {
  /**
   * Trailing debounce window in ms (default 250). 0 still coalesces every
   * change made within one task, because the notification is scheduled on a
   * timer rather than delivered inline from the ProseMirror transaction.
   */
  readonly debounceMs?: number
}

/** Internal per-listener bookkeeping for `ShEditorHost.onDocumentContentChanged`. */
interface EditorContentSubscription {
  readonly listener: (change: EditorContentChange) => void
  readonly debounceMs: number
  timer: ReturnType<typeof setTimeout> | null
  /** Content signature last DELIVERED to this listener (baseline at subscribe time). */
  signature: string
  /** The reason of the most recent trigger inside the pending window. */
  pendingReason: EditorContentChangeReason
}

export type LiveOutlinerCommand =
  | 'toggleCollapse'
  | 'collapseAll'
  | 'expandAll'
  | 'moveUp'
  | 'moveDown'
  | 'selectParent'
  | 'selectAll'
  | 'zoomIn'
  | 'zoomOut'

/** Opaque viewport geometry projected from ProseMirror without exposing EditorView. */
export interface EditorOverlayAnchorRect {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export interface LiveZoteroPromotion {
  readonly text: string
  readonly comment?: string | null
  readonly artifactId: string
  readonly zoteroKey: string
  readonly citation: string
}

export interface LiveZoteroPromotionResult {
  readonly applied: boolean
  readonly blockId: string | null
}

/** Plain controlled chapter projection for the shell-owned original reader. */
export interface EditorOriginalFileChapter {
  readonly id: string
  readonly title: string
  readonly href?: string | null
  readonly src?: string | null
  readonly srcdoc?: string | null
  readonly text?: string | null
}

/* ---------------------------------------------------------------------------
 * PDF reader (Garden PDF Phase 2). Structural mirror of the backend-free
 * MnPdf* component types — runtime cannot import @shrubbery/components, so
 * these plain shapes are the contract the organism controller projects and
 * the host binds onto the <mn-pdf-reader> element.
 * ------------------------------------------------------------------------- */

export interface EditorPdfTextItemView {
  readonly id: string
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface EditorPdfPageView {
  readonly pageNumber: number
  readonly label?: string
  readonly width: number
  readonly height: number
  readonly imageUrl?: string
  readonly textItems: readonly EditorPdfTextItemView[]
}

export interface EditorPdfAnnotationView {
  readonly id: string
  readonly pageNumber: number
  readonly label?: string
  readonly quote: string
  readonly note?: string
  readonly color?: string
  readonly kind?: 'highlight' | 'note'
  readonly source?: 'reader' | 'embedded'
  readonly rects: readonly (readonly [number, number, number, number])[]
}

export interface EditorPdfAnnotateDetail {
  readonly pageNumber: number
  readonly exact: string
  readonly prefix: string
  readonly suffix: string
  readonly quads: readonly [number, number, number, number][]
  readonly mode: 'highlight' | 'note'
}

export interface EditorPdfAnnotationSelectDetail {
  readonly annotationId: string
  readonly annotation: EditorPdfAnnotationView
}

/** Controlled PDF reader state projected by the shell (organism controller). */
export interface EditorPdfReaderView {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string
  readonly annotationError?: string
  readonly title: string
  readonly filename: string
  readonly mimeType: string
  /**
   * Which surface the PDF source shows: the rendered original or the shared
   * annotation list (mn-pdf-annotation-view). Absent means 'original'.
   */
  readonly mode?: 'original' | 'annotations'
  readonly pages: readonly EditorPdfPageView[]
  readonly annotations: readonly EditorPdfAnnotationView[]
  readonly activeAnnotationId: string
  readonly canAnnotate: boolean
  readonly downloadable: boolean
  readonly externalOpenable: boolean
  readonly zoom: number
  readonly pageNumber: number
}

/**
 * The three explicit source views of a document-backed original. `annotations`
 * exists only for PDF sources; non-PDF originals keep the document/original
 * pair.
 */
export type EditorOriginalFileMode = 'document' | 'original' | 'annotations'

/**
 * Shell-owned original-file state reflected into the persistent editor host.
 * Auth, fetch, Blob/object-URL lifetime, and downloads remain outside runtime.
 */
export interface EditorOriginalFileView {
  readonly available: boolean
  readonly active: boolean
  /**
   * Explicit effective view. When present it is authoritative; `active` stays
   * as the backward-compatible binary projection (active === mode !==
   * 'document'). Absent means the shell is still on the binary contract.
   */
  readonly mode?: EditorOriginalFileMode
  readonly status: 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'unavailable'
  readonly graphId: string
  readonly documentId: string
  readonly title: string
  readonly filename: string
  readonly fileType: string
  readonly mimeType: string
  readonly src: string
  readonly srcdoc: string
  readonly text: string
  readonly error: string
  readonly selectedChapterId: string
  readonly downloadable: boolean
  readonly externalOpenable: boolean
  readonly chapters: readonly EditorOriginalFileChapter[]
  readonly annotations: readonly {
    readonly id: string
    readonly label?: string | null
    readonly quote?: string | null
    readonly pageNumber?: number | null
    readonly sourceRef?: string | null
  }[]
  /**
   * Controlled PDF reader state. When present for a PDF original, the host
   * mounts <mn-pdf-reader> (through mn-original-viewer) instead of the legacy
   * blob iframe.
   */
  readonly pdf?: EditorPdfReaderView | null
  /** Non-PDF source-selection persistence is not wired; the UI must say so explicitly. */
  readonly annotationSupport: 'unavailable'
}

/** Shell-owned access state for the open document. */
export interface EditorDocumentAccess {
  readonly readOnly: boolean
  /**
   * A SERVER-OWNED derived view — gardend's `derived` field, computed from
   * native registration and capabilities rather than from the workspace flag
   * (garden docs/workspace-derived-access.md).
   *
   * Separate from `readOnly` because the two need opposite affordances. An
   * imported document is read-only and Make Editable legitimately lifts it. A
   * derived view is read-only because something else owns it, and the flag is
   * not the authority: clearing it does not make a write land. Offering the
   * button there produced the worst outcome available — the action appeared to
   * succeed, typing was accepted, and every save was refused.
   */
  readonly derived?: boolean
  /** Who owns it — 'geist' for Song/archive views, null for ordinary documents. */
  readonly readOnlyOwner?: string | null
  readonly makeEditableStatus?: 'idle' | 'saving' | 'error'
  readonly makeEditableError?: string | null
  /**
   * Whether this session may replace the graph-shared human salience rating.
   * This is distinct from document editability: imported source text may be
   * read-only while graph Editors can still curate its salience.
   */
  readonly salienceWritable?: boolean
  readonly salienceWriteReason?: string | null
}

export interface ZoomChangeDetail extends LiveZoomSnapshot {}

export interface EditorBlockFocusRequest {
  readonly blockId: string
  readonly token: number
  readonly durationMs?: number
}

export interface BlockWireRequestDetail {
  readonly graphId: string | null
  readonly documentId: string | null
  readonly blockId: string
  readonly clientX: number
  readonly clientY: number
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
}

/**
 * A plain click on a block's bubble asks for the bubble menu: Wire from
 * block, Pin block, Move block (Eschaton, 2026-10-07). The picker glue owns
 * the menu. The detail is the same as a wire request's.
 */
export const BLOCK_BUBBLE_REQUEST_EVENT = 'mn-block-bubble-request'
export type BlockBubbleRequestDetail = BlockWireRequestDetail

/** A click on the pane header's document dot: Wire from document, Pin document. */
export const DOCUMENT_BUBBLE_REQUEST_EVENT = 'mn-document-bubble-request'
export interface DocumentBubbleRequestDetail {
  readonly graphId: string | null
  readonly documentId: string | null
  readonly clientX: number
  readonly clientY: number
}

export interface WireRadialContextBlock {
  readonly id: string
  readonly type?: string
  readonly level?: number | null
  readonly text: string
  readonly isTarget?: boolean
}

export interface WireRadialContextData {
  readonly mode?: string
  readonly title?: string | null
  readonly blocks: readonly WireRadialContextBlock[]
}

export type WireRadialContextState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message?: string }
  | { readonly status: 'ready'; readonly data: WireRadialContextData }

export type WireRadialContextMap =
  | ReadonlyMap<string, WireRadialContextState>
  | Readonly<Record<string, WireRadialContextState>>

interface WireRadialNavigateDetail {
  readonly wireId: string
  readonly graphId: string
  readonly documentId: string
  readonly blockId?: string
}

interface WireRadialSuggestionDetail {
  readonly docId: string
  readonly blockId: string | null
}

type EditorImageSize = 'small' | 'medium' | 'large'

const SCHEDULED_TAG_NAMES = new Set(['event', 'todo'])

export interface EditorImageInsert {
  readonly src: string
  readonly alt?: string
  readonly title?: string
  readonly size?: EditorImageSize
}

export type EditorImageInserter = () =>
  | EditorImageInsert
  | Promise<EditorImageInsert | null>
  | null

export type EditorFootnoteInserter = () => string | Promise<string | null> | null

export interface EditorCommentInsertRequest {
  readonly selectedText: string
  readonly from: number
  readonly to: number
}

export interface EditorCommentInsert {
  readonly commentId: string
}

export interface EditorCommentInsertedDetail extends EditorCommentInsertRequest {
  readonly commentId: string
  /**
   * Viewport point just below the start of the new mark, where a shell can pin
   * the comment's popover. Null when the mark has no rendered box.
   */
  readonly anchor: EditorCommentAnchor | null
}

export interface EditorCommentAnchor {
  readonly x: number
  readonly y: number
}

/**
 * The pointer met a comment mark in the text. `enter` and `leave` bracket a
 * hover, `click` and `dblclick` are the pointer's own. `anchor` is a viewport
 * point for a popover: below the mark for `enter`, beside the pointer for the
 * clicks.
 */
export interface EditorCommentPointerDetail {
  readonly commentId: string
  readonly action: 'enter' | 'leave' | 'click' | 'dblclick'
  readonly anchor: EditorCommentAnchor
}

export const EDITOR_COMMENT_POINTER_EVENT = 'mn-editor-comment-pointer'

export type EditorCommentInserter = (
  request: EditorCommentInsertRequest,
) => string | EditorCommentInsert | Promise<string | EditorCommentInsert | null> | null

type TextAlignment = 'left' | 'center' | 'right'
type HeadingLevel = 0 | 1 | 2 | 3
type BlockToolbarValue =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'

interface EditorFormatState {
  readonly bold: boolean
  readonly italic: boolean
  readonly strike: boolean
  readonly code: boolean
  readonly highlight: boolean
  readonly fontFamily: string
  readonly fontSize: string
  readonly textAlign: TextAlignment
  readonly headingLevel: HeadingLevel
  readonly blockType: BlockToolbarValue
  readonly inTable: boolean
}

interface EditorToolbarFormatDetail {
  readonly command: 'bold' | 'italic' | 'strike' | 'code' | 'highlight'
}

interface EditorToolbarHistoryDetail {
  readonly command: 'undo' | 'redo'
}

interface EditorToolbarBlockTypeDetail {
  readonly blockType: BlockToolbarValue
}

interface EditorToolbarAlignDetail {
  readonly alignment: TextAlignment
}

interface EditorToolbarTextChangeDetail {
  readonly value: string
}

interface EditorToolbarTextStyleDetail {
  readonly value: string
}

interface EditorToolbarModifierDetail {
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
}

interface EditorToolbarKeyboardDetail {
  readonly keyboardEvent: KeyboardEvent
}

interface EditorInputDialogOptions {
  readonly title: string
  readonly message?: string
  readonly value?: string
  readonly placeholder?: string
  readonly confirmText?: string
}

interface EditorInputDialogConfirmDetail {
  readonly value: string
}

function defaultFormatState(): EditorFormatState {
  return {
    bold: false,
    italic: false,
    strike: false,
    code: false,
    highlight: false,
    fontFamily: '',
    fontSize: '',
    textAlign: 'left',
    headingLevel: 0,
    blockType: 'paragraph',
    inTable: false,
  }
}

function sameFormatState(a: EditorFormatState, b: EditorFormatState): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strike === b.strike &&
    a.code === b.code &&
    a.highlight === b.highlight &&
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.textAlign === b.textAlign &&
    a.headingLevel === b.headingLevel &&
    a.blockType === b.blockType &&
    a.inTable === b.inTable
  )
}

/**
 * The minimal structural shape of the REAL TipTap Editor the collab plane returns,
 * as the host needs it — WITHOUT importing @tiptap/core (forbidden in the island host).
 * The host holds the real Editor in `_editor` (so the existing `_editor.commands` test
 * probes keep working) and projects the narrow public LiveEditorHandle from it.
 */
interface RawLiveEditor {
  readonly state: {
    readonly doc?: RawDocNode
    readonly tr?: RawTransaction
    readonly selection: RawSelection
  }
  readonly view?: {
    dispatch(tr: RawTransaction): void
    readonly dom: HTMLElement
    posAtDOM(node: Node, offset: number, bias?: number): number
    coordsAtPos?(pos: number, side?: number): EditorOverlayAnchorRect
  }
  readonly storage: {
    readonly search?: {
      readonly results?: readonly unknown[]
      readonly currentIndex?: number
    }
  }
  getText(): string
  getJSON(): LiveDocumentJSON
  setEditable(editable: boolean): void
  getAttributes(typeOrName: string): Record<string, unknown>
  isActive(typeOrName: string, attributes?: Record<string, unknown>): boolean
  destroy(): void
  on(event: 'transaction' | 'selectionUpdate' | 'focus', cb: () => void): void
  off(event: 'transaction' | 'selectionUpdate' | 'focus', cb: () => void): void
  readonly commands: {
    focus(): boolean
    setTextSelection(position: number | { from: number; to: number }): boolean
    toggleBold(): boolean
    toggleItalic(): boolean
    toggleStrike(): boolean
    toggleCode(): boolean
    toggleHighlight(): boolean
    undo(): boolean
    redo(): boolean
    setFontFamily(fontFamily: string): boolean
    unsetFontFamily(): boolean
    setFontSize(fontSize: string): boolean
    unsetFontSize(): boolean
    setParagraph(): boolean
    setContent(content: unknown): boolean
    deleteRange(range: { from: number; to: number }): boolean
    unsetAllMarks(): boolean
    toggleHeading(attrs: { level: 1 | 2 | 3 }): boolean
    toggleBulletItem(): boolean
    toggleOrderedItem(): boolean
    toggleTaskItem(): boolean
    toggleBlockquote(): boolean
    toggleCodeBlock(): boolean
    toggleCollapse(): boolean
    collapseAll(): boolean
    expandAll(): boolean
    moveBlockUp(): boolean
    moveBlockDown(): boolean
    selectParentBlock(): boolean
    selectAllBlocks(): boolean
    selectAll(): boolean
    keyboardShortcut(name: string): boolean
    setTextAlign(alignment: TextAlignment): boolean
    insertTable(options: { rows: number; cols: number; withHeaderRow: boolean }): boolean
    deleteTable(): boolean
    addRowBefore(): boolean
    addRowAfter(): boolean
    addColumnBefore(): boolean
    addColumnAfter(): boolean
    deleteRow(): boolean
    deleteColumn(): boolean
    setHorizontalRule(): boolean
    insertQueryBlock(): boolean
    insertBlockMath(src: string): boolean
    insertImage(attrs: EditorImageInsert): boolean
    insertFootnote(attrs: { content: string }): boolean
    setComment(attrs: { commentId: string }): boolean
    setSearchTerm(searchTerm: string, caseSensitive?: boolean): boolean
    clearSearch(): boolean
    nextSearchResult(): boolean
    prevSearchResult(): boolean
    replaceCurrentSearchResult(replaceWith: string): boolean
    replaceAllSearchResults(replaceWith: string): boolean
    updateMarginGloss(outgoing: readonly WireSummary[], incoming: readonly WireSummary[]): boolean
    insertWikiLink(attrs: LiveWikiLinkAttrs): boolean
    insertCitation(attrs: LiveCitationAttrs): boolean
    insertContentAt(range: { from: number; to: number }, value: unknown): boolean
    toggleCollapseAt(pos: number): boolean
    zoomIntoCurrent(): boolean
    zoomIntoBlock(blockId: string): boolean
    zoomToAncestor(blockId: string): boolean
    zoomOut(): boolean
  }
  chain(): RawLiveEditorChain
}

interface RawResolvedPos {
  readonly depth: number
  node(depth: number): RawDocNode
}

interface RawSelection {
  readonly $from: RawResolvedPos
  readonly from?: number
  readonly empty?: boolean
  readonly node?: { readonly attrs?: Record<string, unknown> }
}

interface ShadowCaretPoint {
  readonly offsetNode: Node
  readonly offset: number
}

interface ShadowCaretDocument {
  caretPositionFromPoint?: (
    x: number,
    y: number,
    options?: { readonly shadowRoots?: readonly ShadowRoot[] },
  ) => ShadowCaretPoint | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

/** Blocks whose content is a run of text, for "click right of the last line". */
const TEXT_BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6'

const EDITOR_CARET_BLOCKED_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="false"]',
  '[data-node-view-wrapper]',
  '.block-drag-handle',
  '.outliner-fold-button',
  '.code-copy-btn',
].join(',')

interface RawLiveEditorChain {
  focus(position?: 'start' | 'end' | number): RawLiveEditorChain
  insertContent(value: unknown): RawLiveEditorChain
  insertCitation(attrs: LiveCitationAttrs): RawLiveEditorChain
  run(): boolean
}

interface RawMarkType {
  readonly name?: string
}

interface RawMark {
  readonly type?: RawMarkType
  readonly attrs?: Record<string, unknown>
}

interface RawDocNode {
  readonly attrs?: Record<string, unknown>
  readonly nodeSize?: number
  readonly textContent?: string
  readonly marks?: readonly RawMark[]
  descendants(cb: (node: RawDocNode, pos: number) => boolean | void): void
}

interface RawTransaction {
  readonly docChanged?: boolean
  removeMark(from: number, to: number, mark: RawMark | RawMarkType): RawTransaction
  setNodeMarkup(
    pos: number,
    type: unknown,
    attrs: Record<string, unknown>,
    marks?: unknown,
  ): RawTransaction
}

/** The four float vars the host writes — relative to `.main`. */
export interface EditorHostVars {
  readonly '--editor-x': string
  readonly '--editor-y': string
  readonly '--editor-w': string
  readonly '--editor-h': string
}

/**
 * Compute the host's float position from the anchor box and the `.main` frame.
 * PURE: rects in, the four CSS vars out — relative to `.main`.
 *
 * R-FIXED-CB: this returns ONLY --editor-x/y/w/h. It NEVER returns any
 * containing-block-establishing property (transform/filter/clip-path/
 * backdrop-filter/will-change/contain/perspective/mask). The forbidden-prop
 * guard test asserts this against both this function's output AND the host's
 * template strings.
 */
export function computeHostVars(
  anchorRect: { left: number; top: number; width: number; height: number },
  mainRect: { left: number; top: number },
): EditorHostVars {
  return {
    '--editor-x': `${anchorRect.left - mainRect.left}px`,
    '--editor-y': `${anchorRect.top - mainRect.top}px`,
    '--editor-w': `${anchorRect.width}px`,
    '--editor-h': `${anchorRect.height}px`,
  }
}

/** The id of the empty position anchor the arm emits (garden-reference token). */
const ANCHOR_ID = 'mn-main-editor'

/**
 * <sh-editor-host> — the one live editor node. Subscribes to its injected
 * EditorHostBinding and renders the honest labelled placeholder. Owns its float
 * position via computeHostVars on updated()/ResizeObserver. NEVER stamps faked
 * editor content.
 */
@customElement('sh-editor-host')
export class ShEditorHost extends LitElement {
  static styles = css`
    ${collaborationCursorStyles}
    ${editorSemanticStyles}
    :host {
      /* Float over the measured anchor box. ONLY the four vars position it;
         no containing-block-establishing property here (R-FIXED-CB). */
      position: absolute;
      left: var(--editor-x, 0px);
      top: var(--editor-y, 0px);
      width: var(--editor-w, 100%);
      height: var(--editor-h, 100%);
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
    }
    :host([layout-mode='contained']) {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
    }
    .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      padding: 1rem;
      color: var(--sh-muted, #888);
      font: italic 0.9rem/1.4 system-ui, sans-serif;
      text-align: center;
    }
    .doc-ref {
      display: block;
      margin-top: 0.5rem;
      font-style: normal;
      font-size: 0.8rem;
      opacity: 0.7;
    }
    /* The live editor mount target — fills the float box. It may anchor purely
       decorative absolute furniture, but never establishes a fixed containing
       block (R-FIXED-CB stays honored). */
    .editor-mount {
      position: relative;
      width: 100%;
      height: 100%;
      min-height: 0;
      flex: 1 1 auto;
      box-sizing: border-box;
      overflow: auto;
      background-color: var(--mn-editor-canvas-surface, var(--mn-color-surface-canvas, var(--mn-color-surface-base, #fffdf8)));
      background-image: var(--mn-editor-canvas-image, var(--mn-atmosphere, none));
      color: var(--mn-color-text-primary, #1f2933);
      /* Appearance > Editor font and Text size set --mn-editor-font and
         --mn-editor-text-scale on the root. They reach only the document:
         the app's own chrome keeps the skin's faces and sizes. */
      font: calc(var(--mn-text-md, 1rem) * var(--mn-editor-text-scale, 1)) / var(--mn-editor-line-height, var(--mn-leading-prose, 1.72))
        var(--mn-editor-font, var(--mn-font-prose, Georgia, 'Times New Roman', serif));
      /* Body weight for the chosen editor font; headings and bold set their own. */
      font-weight: var(--mn-editor-font-weight, 400);
      scrollbar-color: var(--mn-color-border-strong, #b8c0b9) transparent;
      scrollbar-width: thin;
    }
    .editor-mount::-webkit-scrollbar {
      width: 8px;
    }
    .editor-mount::-webkit-scrollbar-track {
      background: transparent;
    }
    .editor-mount::-webkit-scrollbar-thumb {
      border-radius: var(--mn-radius-full, 999px);
      background: var(--mn-color-border-strong, #b8c0b9);
    }
    .editor-mount[hidden],
    .original-file-view[hidden] {
      display: none !important;
    }
    .original-file-view {
      display: flex;
      width: 100%;
      min-width: 0;
      min-height: 0;
      flex: 1 1 auto;
      overflow: hidden;
      background: var(--mn-color-surface-base, #fff);
    }
    .original-file-view mn-original-viewer {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
    }
    /* Visual wire mode — when install-wire-mode applies the wire-mode-active
       attribute on this host, every cursor in the editor surface (ProseMirror
       and its descendants) flips to crosshair. The runtime subscribes to
       contract.wireMode and toggles the attribute on enter/exit. Prod uses a
       body-class cascade; shrubbery's editor lives in shadow DOM so the body
       cascade does not reach ProseMirror's cursor:text rule — the host
       attribute + :host rule is the in-shadow analog (option C from the
       2026-06-27 design decision). */
    /* The editor-font body weight (Appearance) is tuned for the prose face;
       code, monospace dates and the sans furniture stay regular. Bold code
       keeps its bold. */
    .editor-mount pre,
    .editor-mount :not(strong, b) > code,
    .editor-mount .calendar-event-time {
      font-weight: 400;
    }
    /* Zen mode (Mod+\\): no toolbar, and the wire dots hold still. */
    :host([zen]) mn-editor-toolbar {
      display: none;
    }
    :host([zen]) .editor-mount .ProseMirror [data-block-wired]::before,
    :host([zen]) .editor-mount .ProseMirror [data-block-wired]::after {
      animation: none;
    }
    :host([wire-mode-active]) .editor-mount,
    :host([wire-mode-active]) .editor-mount * {
      cursor: crosshair !important;
    }
    .editor-mount .ProseMirror {
      width: var(--mn-editor-sheet-width, min(100%, 880px));
      min-height: var(--mn-editor-sheet-min-height, 100%);
      margin: var(--mn-editor-sheet-margin, 0 auto);
      box-sizing: border-box;
      padding: var(--mn-editor-sheet-padding, var(--mn-space-12, 3rem) var(--mn-space-12, 3rem) var(--mn-space-16, 4rem));
      border: var(--mn-editor-sheet-border, 1px solid var(--mn-color-border-subtle, transparent));
      border-radius: var(--mn-editor-sheet-radius, 0);
      background: var(--mn-editor-sheet-surface, var(--mn-color-surface-editor, #fffdf8));
      box-shadow: var(--mn-editor-sheet-shadow, var(--mn-shadow-xs, none));
      color: var(--mn-editor-sheet-ink, var(--mn-color-text-primary, #1f2933));
      outline: none;
      white-space: pre-wrap;
      word-break: break-word;
      counter-reset: footnote;
    }

    @media (min-width: 761px) {
      :host([editor-material='paper']) .editor-mount .ProseMirror {
        color-scheme: light;
        --mn-color-surface-base: var(--mn-editor-sheet-surface, #fffdf8);
        --mn-color-surface-editor: var(--mn-editor-sheet-surface, #fffdf8);
        --mn-color-surface-raised: #fffefa;
        --mn-color-surface-elevated: #fffefa;
        --mn-color-surface-overlay: #fffefa;
        --mn-color-surface-subtle: #f7f5f0;
        --mn-color-surface-warm: #faf6ec;
        --mn-color-surface-sunken: #eeeae2;
        --mn-color-surface-code: #f3f1ec;
        --mn-color-surface-hover: var(--mn-editor-sheet-hover, rgba(79, 134, 107, 0.065));
        --mn-color-surface-active: rgba(var(--mn-editor-paper-accent-ch, 55 109 87), 0.11);
        --mn-color-surface-accent: var(--mn-editor-paper-accent-soft, #eff6f2);
        --mn-color-surface-accent-subtle: rgba(var(--mn-editor-paper-accent-ch, 55 109 87), 0.08);
        --mn-color-text-primary: var(--mn-editor-sheet-ink, #292723);
        --mn-color-text-secondary: var(--mn-editor-sheet-secondary, #5a564f);
        --mn-color-text-tertiary: var(--mn-editor-sheet-tertiary, #716c64);
        --mn-color-text-muted: var(--mn-editor-sheet-tertiary, #716c64);
        --mn-color-text-title: var(--mn-editor-sheet-title, #11110f);
        --mn-color-text-quiet: var(--mn-editor-sheet-tertiary, #716c64);
        --mn-color-text-accent: var(--mn-editor-paper-accent, #376d57);
        --mn-color-text-accent-strong: var(--mn-editor-paper-accent-hover, #2b5846);
        --mn-color-text-on-accent: #fbfaf6;
        --mn-color-border-subtle: rgba(79, 72, 62, 0.12);
        --mn-color-border-default: #dfdad0;
        --mn-color-border-strong: #9d978d;
        --mn-color-border-accent: var(--mn-editor-paper-accent, #376d57);
        --mn-color-border-focus: var(--mn-editor-paper-accent, #376d57);
        --mn-color-accent: var(--mn-editor-paper-accent, #376d57);
        --mn-color-accent-hover: var(--mn-editor-paper-accent-hover, #2b5846);
        --mn-color-accent-active: var(--mn-editor-paper-accent-hover, #2b5846);
        --mn-color-accent-ch: var(--mn-editor-paper-accent-ch, 55 109 87);
        --mn-focus-ring-color: var(--mn-editor-paper-accent, #376d57);
      }
    }
    .editor-mount .ProseMirror > p,
    .editor-mount .ProseMirror > h1,
    .editor-mount .ProseMirror > h2,
    .editor-mount .ProseMirror > h3,
    .editor-mount .ProseMirror > blockquote,
    .editor-mount .ProseMirror > li,
    .editor-mount .ProseMirror > .tableWrapper {
      position: relative;
    }
    /* The empty page's prompt. ::before belongs to the block handle, so the
       prompt rides ::after, laid over the empty line. */
    .editor-mount .ProseMirror > p.is-editor-empty:first-child::after {
      content: attr(data-placeholder);
      position: absolute;
      inset: 0 auto auto 0;
      pointer-events: none;
      user-select: none;
      color: var(--mn-color-text-tertiary, var(--mn-color-text-secondary, #8a8a8a));
    }
    .editor-mount .ProseMirror > p,
    .editor-mount .ProseMirror > h1,
    .editor-mount .ProseMirror > h2,
    .editor-mount .ProseMirror > h3 {
      /* A transparent border, not a margin, for the space below: WebKit paints
         a multi-block selection into the margins between blocks (see the list
         item rule). !important keeps the background clipped against the
         background shorthand in the hover and selected rules. */
      margin: 0;
      border-bottom: var(--mn-editor-block-gap, var(--mn-space-1, 0.25rem)) solid transparent;
      background-clip: padding-box !important;
      padding: var(--mn-space-1-5, 0.375rem) var(--mn-space-2, 0.5rem)
        var(--mn-space-1-5, 0.375rem) var(--mn-space-8, 2rem);
      border-radius: var(--mn-radius-md, 6px);
      transition:
        background var(--mn-transition-fast, 120ms ease),
        box-shadow var(--mn-transition-fast, 120ms ease);
    }
    /* Semantic quote material. StarterKit supplies the blockquote node, but
       its presentation must live inside this Shadow DOM beside the editor. */
    .editor-mount .ProseMirror > blockquote {
      position: relative;
      margin: 0 0 var(--mn-editor-block-gap, var(--mn-space-1, 0.25rem));
      padding: var(--mn-space-1-5, 0.375rem) var(--mn-space-2, 0.5rem)
        var(--mn-space-1-5, 0.375rem) var(--mn-space-6, 1.5rem);
      border-left: 3px solid var(--mn-color-border-accent, var(--mn-color-accent, #3d7f5f));
      border-radius: var(--mn-radius-md, 6px);
      color: var(--mn-color-text-secondary, #4b5563);
      font-family: var(--mn-editor-font, var(--mn-font-prose, Georgia, 'Times New Roman', serif));
      font-style: italic;
      line-height: var(--mn-editor-line-height, 1.65);
      transition:
        background var(--mn-transition-fast, 120ms ease),
        box-shadow var(--mn-transition-fast, 120ms ease);
    }
    .editor-mount .ProseMirror > blockquote:hover {
      background: var(--mn-color-surface-hover, rgba(61, 127, 95, 0.06));
    }
    .editor-mount .ProseMirror > blockquote::before {
      content: '';
      position: absolute;
      left: var(--mn-space-2, 0.5rem);
      top: calc(var(--mn-space-1-5, 0.375rem) + 0.5lh);
      width: 5px;
      height: 5px;
      border-radius: 999px;
      background: var(--mn-color-border-strong, #7a869a);
      transform: translateY(-50%);
      transition:
        background var(--mn-transition-fast, 120ms ease),
        transform var(--mn-transition-fast, 120ms ease),
        box-shadow var(--mn-transition-fast, 120ms ease);
      cursor: pointer;
    }
    .editor-mount .ProseMirror > blockquote:hover::before {
      background: var(--mn-color-accent, #3d7f5f);
      transform: translateY(-50%) scale(1.3);
      box-shadow: var(--mn-focus-ring, 0 0 0 2px rgba(61, 127, 95, 0.22));
    }
    /* ── Tables ─────────────────────────────────────────────────────────────
       THE WRAPPER IS THE BLOCK, and that is the whole reason this section
       exists. TipTap's Table extension mounts every table inside its own
       <div class="tableWrapper">, so a <table> is NEVER a direct child of
       .ProseMirror. Measured, not assumed — table-dom.test.ts in
       editor-kernel asserts the wrapper and asserts the table is not a child.

       UNCONDITIONAL, and worth stating because the obvious guess is wrong: the
       wrapper is NOT a consequence of resizable: true (base.ts:140). Built
       both ways and compared — wrapper and <colgroup> appear identically with
       resizable on and off. Anyone turning resizing off later must not expect
       these selectors to stop applying.

       Two things followed from nobody knowing that:
         · The one table rule this file had — .ProseMirror > table
           { position: relative } — matched NOTHING. cloud-1's own table CSS
           carries the identical dead selector (document-editor.ts:1922), so
           copying it across would have shipped a second rule that does not
           run. Fixed above by naming the wrapper.
         · A table received none of the left gutter every other block carries
           (> p/> h* pad 2rem for the drag handle and the dot), so it sat
           flush against the edge while the prose sat an inch in.

       Everything here hangs off .tableWrapper; the table selector is a
       DESCENDANT, never a child.

       NO border-radius on the table, deliberately. border-collapse: collapse
       and rounded corners fight each other — the cells are not clipped by the
       table's radius, so the corners square themselves off again and the
       border doubles at the join. cloud-1 papers over this with
       overflow: hidden on the <table>, which is unreliable across browsers.
       A flat 1px frame is the honest version; doing it properly needs
       border-collapse: separate plus per-edge cell borders, which is a
       deliberate pass, not a side effect of this one. */
    .editor-mount .ProseMirror > .tableWrapper {
      margin: 0 0 var(--mn-editor-block-gap, var(--mn-space-1, 0.25rem));
      padding: var(--mn-space-1-5, 0.375rem) var(--mn-space-2, 0.5rem)
        var(--mn-space-1-5, 0.375rem) var(--mn-space-8, 2rem);
      /* A table wider than the text column scrolls ITSELF. Without this the
         document grows a horizontal scrollbar and every other block starts
         sliding under it. */
      overflow-x: auto;
    }
    .editor-mount .ProseMirror .tableWrapper table {
      width: 100%;
      border: 1px solid var(--mn-color-border-default, #d1d5db);
      border-collapse: collapse;
      font-size: calc(var(--mn-text-sm, 13px) * var(--mn-editor-text-scale, 1));
      table-layout: fixed;
    }
    /* position: relative anchors the resize handle; box-sizing: border-box
       keeps the padding inside the width prosemirror-tables writes onto the
       <col>, so a dragged column lands where the pointer left it.

       No min-width here on purpose. Under table-layout: fixed a cell's own
       min-width is ignored — the <colgroup> carries the minimum instead
       (<col style="min-width: 25px">, present in the rendered DOM either
       way). A min-width on the cell would read like a guard and enforce
       nothing. */
    .editor-mount .ProseMirror .tableWrapper th,
    .editor-mount .ProseMirror .tableWrapper td {
      position: relative;
      box-sizing: border-box;
      padding: var(--mn-space-2, 0.5rem) var(--mn-space-3, 0.75rem);
      border: 1px solid var(--mn-color-border-subtle, #e5e7eb);
      text-align: left;
      vertical-align: top;
    }
    .editor-mount .ProseMirror .tableWrapper th {
      background: var(--mn-color-surface-subtle, #f7f5f0);
      border-bottom: 2px solid var(--mn-color-border-default, #d1d5db);
      color: var(--mn-color-text-primary, #111827);
      font-weight: var(--mn-font-weight-semibold, 600);
    }
    /* Every cell holds a real paragraph node. It is not a direct child of
       .ProseMirror, so it escapes the block padding above — but not the UA's
       default margin, which is what opens a gap over each cell's first line. */
    .editor-mount .ProseMirror .tableWrapper th > p,
    .editor-mount .ProseMirror .tableWrapper td > p {
      margin: 0;
      padding: 0;
    }
    /* prosemirror-tables' OWN class names, applied at INTERACTION time — a
       cell selection and a hovered column edge. Nothing in this tree styled
       either one, so with resizable: true on (base.ts:140) the column drag
       target was invisible and a multi-cell selection gave no feedback at all.

       These two are the one part of this section not confirmed against a
       rendered DOM: both classes appear only mid-gesture, which happy-dom does
       not produce, so they rest on prosemirror-tables' documented names rather
       than on a measurement. Worth a real browser pass before trusting the
       exact geometry below. */
    .editor-mount .ProseMirror .tableWrapper .selectedCell::after {
      content: '';
      position: absolute;
      z-index: 2;
      inset: 0;
      background: var(--mn-color-surface-accent-subtle, rgba(61, 127, 95, 0.12));
      pointer-events: none;
    }
    .editor-mount .ProseMirror .tableWrapper .column-resize-handle {
      position: absolute;
      z-index: 3;
      top: 0;
      right: -2px;
      bottom: 0;
      width: 3px;
      background: var(--mn-color-border-accent, var(--mn-color-accent, #3d7f5f));
      pointer-events: none;
    }
    /* The plugin puts this class on the editable root, not on a cell. */
    .editor-mount .ProseMirror.resize-cursor {
      cursor: col-resize;
    }
    /* Garden outliner node affordances. Direct-child selectors are
       load-bearing: paragraphs nested inside flat list/task items keep the
       list item's one semantic marker instead of receiving a duplicate dot. */
    .editor-mount .ProseMirror > p::before,
    .editor-mount .ProseMirror > h1::before,
    .editor-mount .ProseMirror > h2::before,
    .editor-mount .ProseMirror > h3::before {
      content: '';
      position: absolute;
      left: var(--mn-space-2, 0.5rem);
      top: calc(var(--mn-space-1-5, 0.375rem) + 0.5lh);
      border-radius: 999px;
      transform: translateY(-50%);
      transition:
        background var(--mn-transition-fast, 120ms ease),
        transform var(--mn-transition-fast, 120ms ease),
        box-shadow var(--mn-transition-fast, 120ms ease);
      cursor: pointer;
    }
    .editor-mount .ProseMirror > p::before {
      width: 5px;
      height: 5px;
      background: var(--mn-color-border-strong, #7a869a);
    }
    .editor-mount .ProseMirror > h1::before,
    .editor-mount .ProseMirror > h2::before,
    .editor-mount .ProseMirror > h3::before {
      width: 8px;
      height: 8px;
      background: var(--mn-color-accent, #3d7f5f);
    }
    .editor-mount .ProseMirror > p:hover::before {
      background: var(--mn-color-accent, #3d7f5f);
      transform: translateY(-50%) scale(1.3);
      box-shadow: var(--mn-focus-ring, 0 0 0 2px rgba(61, 127, 95, 0.22));
    }
    .editor-mount .ProseMirror > h1:hover::before,
    .editor-mount .ProseMirror > h2:hover::before,
    .editor-mount .ProseMirror > h3:hover::before {
      background: var(--mn-color-accent-hover, #2f6f4f);
      transform: translateY(-50%) scale(1.2);
      box-shadow: var(--mn-focus-ring, 0 0 0 2px rgba(61, 127, 95, 0.22));
    }
    .editor-mount .ProseMirror > p:active::before {
      background: var(--mn-color-accent, #3d7f5f);
      transform: translateY(-50%) scale(1.1);
    }
    .editor-mount .ProseMirror > h1:active::before,
    .editor-mount .ProseMirror > h2:active::before,
    .editor-mount .ProseMirror > h3:active::before {
      background: var(--mn-color-accent-hover, #2f6f4f);
      transform: translateY(-50%) scale(1.05);
    }
    /* ProseMirror focuses one contenteditable root, not each child block. The
       kernel's FocusedBlock decoration marks the selected block; gating its
       treatment on the root's real focus keeps toolbar/blur state honest. */
    .editor-mount .ProseMirror:focus > p[data-block-focused],
    .editor-mount .ProseMirror:focus > h1[data-block-focused],
    .editor-mount .ProseMirror:focus > h2[data-block-focused],
    .editor-mount .ProseMirror:focus > h3[data-block-focused] {
      box-shadow: inset 2px 0 0 var(--mn-color-border-accent, #3d7f5f);
    }
    .editor-mount .ProseMirror:focus > p[data-block-focused]::before,
    .editor-mount .ProseMirror:focus > h1[data-block-focused]::before,
    .editor-mount .ProseMirror:focus > h2[data-block-focused]::before,
    .editor-mount .ProseMirror:focus > h3[data-block-focused]::before {
      background: var(--mn-color-accent, #3d7f5f);
      box-shadow: var(--mn-focus-ring, 0 0 0 2px rgba(61, 127, 95, 0.22));
    }
    @keyframes node-wire-pulse {
      0%, 100% {
        opacity: 0.72;
        box-shadow: 0 0 0 2px rgba(61, 127, 95, 0.16);
      }
      50% {
        opacity: 1;
        box-shadow: 0 0 0 3px rgba(61, 127, 95, 0.3);
      }
    }
    .editor-mount .ProseMirror > p[data-block-wired]::before,
    .editor-mount .ProseMirror > h1[data-block-wired]::before,
    .editor-mount .ProseMirror > h2[data-block-wired]::before,
    .editor-mount .ProseMirror > h3[data-block-wired]::before {
      background: var(--mn-color-accent, #3d7f5f);
      animation: var(--mn-wire-pulse-animation, node-wire-pulse 2s ease-in-out infinite);
    }
    .editor-mount .ProseMirror > p[data-block-wired]:hover::before,
    .editor-mount .ProseMirror > h1[data-block-wired]:hover::before,
    .editor-mount .ProseMirror > h2[data-block-wired]:hover::before,
    .editor-mount .ProseMirror > h3[data-block-wired]:hover::before {
      background: var(--mn-color-accent-hover, #2f6f4f);
      animation: none;
      box-shadow: var(--mn-focus-ring, 0 0 0 2px rgba(61, 127, 95, 0.22));
    }
    @media (prefers-reduced-motion: reduce) {
      .editor-mount .ProseMirror > p[data-block-wired]::before,
      .editor-mount .ProseMirror > h1[data-block-wired]::before,
      .editor-mount .ProseMirror > h2[data-block-wired]::before,
      .editor-mount .ProseMirror > h3[data-block-wired]::before {
        animation: none;
      }
    }
    /* The hover wash STAYS while you type in the block, steadily. It used to
       blink once per keystroke: ProseMirror replaced the block element on every
       keystroke, the new element was born un-hovered, and the 120ms transition
       animated the wash back in. The replacement was ours. The host wrote
       data-block-focused onto ProseMirror's block elements on every
       transaction, ProseMirror's DOMObserver took each write as a foreign edit
       and redrew the node, and the redraw dropped the attribute, so the next
       transaction wrote it again. That marker is a decoration now
       (editor-kernel FocusedBlock) and the element survives typing. Measured
       with a stationary pointer: 92 transitions before, 0 after. An earlier
       fix hid the wash while typing instead; it is gone. */
    .editor-mount .ProseMirror > p:hover,
    .editor-mount .ProseMirror > h1:hover,
    .editor-mount .ProseMirror > h2:hover,
    .editor-mount .ProseMirror > h3:hover,
    .editor-mount .ProseMirror > li:hover {
      background: var(--mn-color-surface-hover, rgba(15, 23, 42, 0.05));
    }
    .editor-mount .ProseMirror h1,
    .editor-mount .ProseMirror h2,
    .editor-mount .ProseMirror h3 {
      color: var(--mn-color-text-title, var(--mn-color-text-primary, #1f2933));
      font-family: var(--mn-editor-font, var(--mn-font-display, var(--mn-font-prose, Georgia, serif)));
      line-height: var(--mn-leading-tight, 1.2);
      letter-spacing: -0.025em;
    }
    .editor-mount .ProseMirror h1 {
      font-size: calc(var(--mn-text-2xl, 1.5rem) * var(--mn-editor-text-scale, 1));
      font-weight: 650;
    }
    .editor-mount .ProseMirror h2 {
      font-size: calc(var(--mn-text-xl, 1.25rem) * var(--mn-editor-text-scale, 1));
      font-weight: 620;
    }
    .editor-mount .ProseMirror h3 {
      font-size: calc(var(--mn-text-lg, 1.125rem) * var(--mn-editor-text-scale, 1));
      font-weight: 620;
    }
    .editor-mount .ProseMirror .footnote-ref {
      position: relative;
      top: -0.4em;
      display: inline;
      margin: 0 0.1em;
      color: var(--mn-color-text-accent, #3d7f5f);
      font: 500 0.75em/0 var(--mn-font-sans, system-ui, sans-serif);
      vertical-align: baseline;
      cursor: help;
      transition: color 120ms ease;
    }
    .editor-mount .ProseMirror .footnote-ref::before {
      counter-increment: footnote;
      content: '[' counter(footnote) ']';
      position: relative;
      z-index: 1;
    }
    .editor-mount .ProseMirror .footnote-ref:hover,
    .editor-mount .ProseMirror .footnote-ref:focus {
      color: var(--mn-color-text-accent-strong, var(--mn-color-text-accent, #2f6f4f));
      outline: none;
    }
    .editor-mount .ProseMirror .footnote-ref::after {
      content: attr(data-footnote-content);
      position: absolute;
      top: calc(100% + 12px);
      left: 50%;
      z-index: var(--mn-z-popover, 1100);
      box-sizing: border-box;
      width: max-content;
      min-width: 12rem;
      max-width: 20rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--mn-color-border-default, #d0d7de);
      border-radius: var(--mn-radius-md, 8px);
      background: var(--mn-color-surface-warm, var(--mn-color-surface-base, #fffdf8));
      color: var(--mn-color-text-primary, #1f2933);
      box-shadow: var(--mn-shadow-raised, 0 8px 24px rgba(15, 23, 42, 0.16));
      font: 400 0.875rem/1.5 var(--mn-font-serif, Georgia, serif);
      text-align: left;
      white-space: normal;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateX(-50%) scale(0.96);
      transform-origin: top center;
      transition: opacity 160ms ease, visibility 160ms ease, transform 160ms ease;
    }
    .editor-mount .ProseMirror .footnote-ref:hover::after,
    .editor-mount .ProseMirror .footnote-ref:focus::after {
      opacity: 1;
      visibility: visible;
      transform: translateX(-50%) scale(1);
    }
    .editor-mount .ProseMirror .mn-citation-chip {
      display: inline;
      margin: 0 0.1em;
      padding: 0.05rem 0.375rem;
      border: 1px solid var(--mn-color-border-accent, #3d7f5f);
      border-radius: var(--mn-radius-sm, 4px);
      background: var(--mn-color-surface-accent-subtle, rgba(61, 127, 95, 0.1));
      color: var(--mn-color-text-accent, #2f6f4f);
      font: 500 0.9em/1.35 var(--mn-font-sans, system-ui, sans-serif);
      white-space: nowrap;
      cursor: pointer;
    }
    .editor-mount .ProseMirror .mn-citation-chip:hover,
    .editor-mount .ProseMirror .mn-citation-chip:focus-visible {
      background: var(--mn-color-surface-accent, rgba(61, 127, 95, 0.16));
      outline: 2px solid color-mix(in srgb, var(--mn-color-border-accent, #3d7f5f) 28%, transparent);
      outline-offset: 1px;
    }
    .editor-mount .ProseMirror mn-calendar-event[data-calendar-event] {
      display: grid;
      grid-template-columns: minmax(5.5rem, auto) 1fr;
      gap: 0.125rem 0.75rem;
      align-items: baseline;
      margin: 0.75rem 0;
      padding: 0.5rem 0.75rem;
      border-left: 3px solid var(--mn-color-border-accent, #3d7f5f);
      background: var(--mn-color-surface-subtle, rgba(15, 23, 42, 0.03));
      font-family: var(--mn-font-serif, Georgia, serif);
    }
    .editor-mount .ProseMirror mn-calendar-event[data-calendar-event].ProseMirror-selectednode {
      outline: 2px solid var(--mn-color-border-accent, #3d7f5f);
      outline-offset: 2px;
    }
    .editor-mount .ProseMirror .calendar-event-time {
      font-family: var(--mn-font-mono, ui-monospace, monospace);
      font-size: var(--mn-text-xs, 0.75rem);
      color: var(--mn-color-text-tertiary, #697386);
      white-space: nowrap;
    }
    .editor-mount .ProseMirror .calendar-event-title {
      min-width: 0;
      overflow: hidden;
      color: var(--mn-color-text-primary, #1f2933);
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .editor-mount .ProseMirror .calendar-event-details {
      grid-column: 2;
      color: var(--mn-color-text-secondary, #4b5563);
      font-size: var(--mn-text-sm, 0.875rem);
      font-style: italic;
    }
    .editor-mount .ProseMirror .comment-mark {
      padding: 0 1px;
      border-bottom: 2px solid var(--mn-color-warning-border, #f59e0b);
      border-radius: 2px;
      background: var(--mn-color-warning-surface, #fff7ed);
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .editor-mount .ProseMirror .comment-mark:hover {
      border-bottom-color: var(--mn-color-warning-strong, #b45309);
      background: var(--mn-color-warning-surface-strong, #ffedd5);
    }
    /* The active comment is a decoration span INSIDE the mark (comment-active.ts
       in the kernel), so the wash goes on that span and the underline on the
       mark around it. */
    .editor-mount .ProseMirror .comment-mark:has(.comment-active) {
      border-bottom-color: var(--mn-color-warning-strong, #b45309);
    }
    .editor-mount .ProseMirror .comment-mark .comment-active {
      background: var(--mn-color-warning-surface-strong, #ffedd5);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--mn-color-warning-border, #f59e0b) 28%, transparent);
    }
    /* The space under each list item is a transparent BORDER, not a margin.
       WebKit paints a selection across blocks into the margins between them,
       from the list's left edge: Select All drew a band under every bullet.
       A border is part of the block, so nothing is painted there. The
       background stays clipped to the padding box, so the hover and selected
       washes keep their size; !important holds that against the background
       shorthand in those rules, which would reset the clip. */
    .editor-mount .ProseMirror > li {
      margin: 0;
      border-bottom: var(--mn-editor-block-gap, var(--mn-space-2, 0.5rem)) solid transparent;
      background-clip: padding-box !important;
      padding: var(--mn-space-1-5, 0.375rem) var(--mn-space-2, 0.5rem)
        var(--mn-space-1-5, 0.375rem) var(--mn-space-8, 2rem);
      border-radius: var(--mn-radius-md, 6px);
      line-height: var(--mn-editor-line-height, 1.65);
      list-style: none;
    }
    .editor-mount .ProseMirror > li p {
      margin: 0;
      padding: 0;
    }
    .editor-mount .ProseMirror > li[data-list-type='bullet']::before,
    .editor-mount .ProseMirror > li[data-list-type='ordered']::before,
    .editor-mount .ProseMirror > li[data-list-type='task']::before {
      content: '';
      position: absolute;
      left: var(--mn-space-2, 0.5rem);
      top: calc(var(--mn-space-1-5, 0.375rem) + 0.5lh);
      width: 5px;
      height: 5px;
      border-radius: 999px;
      background: var(--mn-color-border-strong, #7a869a);
      cursor: pointer;
    }
    .editor-mount .ProseMirror > li[data-list-type='bullet']::before {
      background: transparent;
      border: 1.5px solid var(--mn-color-border-strong, #7a869a);
    }
    /* A bullet item sits half an indent in from the paragraphs around it, at
       every depth, so a list reads as a list and not only as a different dot.
       Its bullet is its wire bubble, so the bubble moves in with the text.
       Half, because Tab's own indent (data-indent, below) is the full step
       and numbered items also sit half a step in (Eschaton, 2026-11-19). */
    .editor-mount .ProseMirror > li[data-list-type='bullet'] {
      padding-left: calc(var(--mn-space-8, 2rem) + var(--mn-list-bullet-inset, 0.75rem));
    }
    .editor-mount .ProseMirror > li[data-list-type='bullet']::before {
      left: calc(var(--mn-space-2, 0.5rem) + var(--mn-list-bullet-inset, 0.75rem));
    }
    /* A wired list item lights its own gutter dot, as a paragraph does. It
       used to draw a second, separate wire dot further right, so a numbered
       item showed two bubbles side by side (Eschaton, 2026-10-09). */
    .editor-mount .ProseMirror > li[data-block-wired]::before {
      border-color: transparent;
      background: var(--mn-color-accent, #3d7f5f);
      animation: var(--mn-wire-pulse-animation, node-wire-pulse 2s ease-in-out infinite);
    }
    .editor-mount .ProseMirror > li[data-block-wired]:hover::before {
      background: var(--mn-color-accent-hover, #2f6f4f);
      animation: none;
      box-shadow: var(--mn-focus-ring, 0 0 0 2px rgba(61, 127, 95, 0.22));
    }
    @media (prefers-reduced-motion: reduce) {
      .editor-mount .ProseMirror > li[data-block-wired]::before { animation: none; }
    }
    .editor-mount .ProseMirror > li[data-list-type='bullet']:hover::before,
    .editor-mount .ProseMirror > li[data-list-type='ordered']:hover::before,
    .editor-mount .ProseMirror > li[data-list-type='task']:hover::before {
      background: var(--mn-color-accent, #3d7f5f);
      border-color: var(--mn-color-border-accent, #3d7f5f);
    }
    .editor-mount .ProseMirror > li[data-list-type='ordered'],
    .editor-mount .ProseMirror > li[data-list-type='task'] {
      display: flex;
      align-items: flex-start;
      gap: var(--mn-space-2, 0.5rem);
    }
    .editor-mount .ProseMirror > li[data-list-type='ordered'] .list-item-number {
      flex-shrink: 0;
      min-width: 1.5em;
      color: var(--mn-color-text-tertiary, #697386);
      font-variant-numeric: tabular-nums;
      font-size: 0.85em;
      font-weight: 500;
      text-align: right;
      user-select: none;
    }
    ${unsafeCSS(numberedListCounterCss())}
    .editor-mount .ProseMirror > li[data-list-type='task'] > label {
      flex-shrink: 0;
      margin-top: 0.15em;
      user-select: none;
    }
    .editor-mount .ProseMirror > li[data-list-type='task'] input[type='checkbox'] {
      width: 1.1em;
      height: 1.1em;
      accent-color: var(--mn-color-accent, #3d7f5f);
      cursor: pointer;
    }
    .editor-mount .ProseMirror > li[data-list-type='task'] > .list-item-content {
      min-width: 0;
      flex: 1;
    }
    .editor-mount .ProseMirror > li[data-list-type='task'][data-checked='true'] {
      color: var(--mn-color-text-tertiary, #697386);
    }
    .editor-mount .ProseMirror > li[data-list-type='task'][data-checked='true'] > .list-item-content > p {
      text-decoration: line-through;
    }
    .editor-mount .ProseMirror [data-indent='1'] { margin-left: 1.5rem; }
    .editor-mount .ProseMirror [data-indent='2'] { margin-left: 3rem; }
    .editor-mount .ProseMirror [data-indent='3'] { margin-left: 4.5rem; }
    .editor-mount .ProseMirror [data-indent='4'] { margin-left: 6rem; }
    .editor-mount .ProseMirror [data-indent='5'] { margin-left: 7.5rem; }
    .editor-mount .ProseMirror [data-indent='6'] {
      margin-left: 9rem;
      border-right: 2px solid var(--mn-color-border-default, #d0d7de);
    }
    .editor-mount .ProseMirror .code-block-wrapper {
      position: relative;
      margin: 0 0 var(--mn-editor-block-gap, var(--mn-space-2, 0.5rem));
      padding-left: var(--mn-space-8, 2rem);
    }
    .editor-mount .ProseMirror .code-block-wrapper > pre {
      margin: 0;
      padding: var(--mn-space-3, 0.75rem) var(--mn-space-4, 1rem);
      overflow-x: auto;
      border-radius: var(--mn-radius-lg, 8px);
      background: var(--mn-color-surface-code, #f3f1ec);
    }
    .editor-mount .ProseMirror .code-block-wrapper code {
      padding: 0;
      background: none;
      color: inherit;
      font: var(--mn-text-sm, 0.875rem)/1.55 var(--mn-font-mono, ui-monospace, monospace);
      white-space: pre;
    }
    .editor-mount .ProseMirror .code-copy-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      padding: 3px 8px;
      border: 0;
      border-radius: var(--mn-radius-sm, 4px);
      background: transparent;
      color: var(--mn-color-text-tertiary, #697386);
      font: 600 var(--mn-text-xs, 0.75rem)/1.35 var(--mn-font-sans, system-ui, sans-serif);
      cursor: pointer;
      opacity: 0;
      transition: color 120ms ease, background 120ms ease, opacity 120ms ease;
    }
    .editor-mount .ProseMirror .code-block-wrapper:hover > .code-copy-btn,
    .editor-mount .ProseMirror .code-copy-btn:focus-visible,
    .editor-mount .ProseMirror .code-copy-btn.copied {
      opacity: 1;
    }
    .editor-mount .ProseMirror .code-copy-btn:hover {
      background: var(--mn-color-surface-hover, rgba(15, 23, 42, 0.06));
      color: var(--mn-color-text-primary, #1f2933);
    }
    .editor-mount .ProseMirror .code-copy-btn:focus-visible {
      outline: 2px solid var(--mn-color-border-focus, #3d7f5f);
      outline-offset: 1px;
    }
    .editor-mount .ProseMirror .code-copy-btn.copied {
      color: var(--mn-color-success-strong, #287a4b);
    }
    .editor-mount .ProseMirror .mermaid-code-block-wrapper {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(15rem, 42%);
      padding-left: 0;
      overflow: hidden;
      border: 1px solid var(--mn-color-border-default, #d0d7de);
      border-radius: var(--mn-radius-lg, 8px);
      background: var(--mn-color-surface-raised, #fff);
    }
    .editor-mount .ProseMirror .mermaid-code-block-header {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--mn-space-3, 0.75rem);
      min-height: 2.25rem;
      padding: var(--mn-space-1, 0.25rem) var(--mn-space-2, 0.5rem)
        var(--mn-space-1, 0.25rem) var(--mn-space-3, 0.75rem);
      border-bottom: 1px solid var(--mn-color-border-subtle, #d8dee4);
      background: var(--mn-color-surface-subtle, rgba(15, 23, 42, 0.025));
      font-family: var(--mn-font-sans, system-ui, sans-serif);
    }
    .editor-mount .ProseMirror .mermaid-code-block-title {
      color: var(--mn-color-text-secondary, #475467);
      font-size: var(--mn-text-xs, 0.75rem);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .editor-mount .ProseMirror .mermaid-code-block-actions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .editor-mount .ProseMirror .mermaid-code-block-actions .code-copy-btn {
      position: static;
      opacity: 1;
    }
    .editor-mount .ProseMirror .mermaid-render-btn.is-dirty {
      color: var(--mn-color-warning-strong, #b45309);
      background: var(--mn-color-warning-surface, #fff7ed);
    }
    .editor-mount .ProseMirror .mermaid-source-toggle.is-open {
      color: var(--mn-color-text-accent, #2f6f4f);
      background: var(--mn-color-surface-accent-subtle, rgba(61, 127, 95, 0.1));
    }
    .editor-mount .ProseMirror .mermaid-preview {
      grid-column: 1;
      display: grid;
      place-items: center;
      min-width: 0;
      min-height: 10rem;
      padding: var(--mn-space-4, 1rem);
      overflow: auto;
      background: var(--mn-color-surface-elevated, var(--mn-color-surface-raised, #fff));
    }
    .editor-mount .ProseMirror .mermaid-preview svg {
      display: block;
      max-width: 100%;
      height: auto;
    }
    .editor-mount .ProseMirror .mermaid-preview[aria-busy='true'] {
      cursor: progress;
    }
    .editor-mount .ProseMirror .mermaid-empty,
    .editor-mount .ProseMirror .mermaid-loading,
    .editor-mount .ProseMirror .mermaid-error {
      max-width: 36rem;
      color: var(--mn-color-text-tertiary, #697386);
      font: var(--mn-text-sm, 0.875rem)/1.5 var(--mn-font-sans, system-ui, sans-serif);
      text-align: center;
    }
    .editor-mount .ProseMirror .mermaid-error {
      color: var(--mn-color-danger-strong, #b42318);
    }
    .editor-mount .ProseMirror .mermaid-source {
      grid-column: 2;
      min-width: 0;
      min-height: 10rem;
      border-left: 1px solid var(--mn-color-border-subtle, #d8dee4);
      border-radius: 0;
    }
    .editor-mount .ProseMirror .mermaid-source-collapsed {
      grid-template-columns: minmax(0, 1fr);
    }
    .editor-mount .ProseMirror .mermaid-source-collapsed .mermaid-preview {
      grid-column: 1 / -1;
    }
    .editor-mount .ProseMirror .mermaid-source-collapsed .mermaid-source {
      display: none;
    }
    .editor-mount .ProseMirror .mermaid-code-block-wrapper-editing {
      border-color: var(--mn-color-border-accent, #3d7f5f);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--mn-color-border-accent, #3d7f5f) 24%, transparent);
    }
    @media (max-width: 760px) {
      .editor-mount::before,
      .editor-mount::after {
        display: none;
      }
      .editor-mount .ProseMirror {
        width: 100%;
        min-height: 100%;
        margin: 0;
        padding: var(--mn-space-6, 1.5rem) var(--mn-space-3, 0.75rem) var(--mn-space-10, 2.5rem);
        border: 0;
        border-radius: 0;
        background: var(--mn-color-surface-editor, #fffdf8);
        box-shadow: none;
        color: var(--mn-color-text-primary, #1f2933);
      }
      .editor-mount .ProseMirror .mermaid-code-block-wrapper {
        grid-template-columns: minmax(0, 1fr);
      }
      .editor-mount .ProseMirror .mermaid-preview,
      .editor-mount .ProseMirror .mermaid-source {
        grid-column: 1;
      }
      .editor-mount .ProseMirror .mermaid-source {
        border-top: 1px solid var(--mn-color-border-subtle, #d8dee4);
        border-left: 0;
      }
    }
    @media (min-width: 761px) and (max-width: 960px) {
      .editor-mount::after {
        display: none;
      }
    }
    .editor-mount .ProseMirror .outliner-fold-button {
      position: absolute;
      left: 0;
      top: calc(var(--mn-space-1-5, 0.375rem) + 0.5lh);
      transform: translateY(-50%);
      width: 1rem;
      height: 1.1rem;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      cursor: pointer;
      display: inline-block;
      vertical-align: top;
    }
    .editor-mount .ProseMirror .outliner-fold-button::before {
      content: '';
      position: absolute;
      left: 0.15rem;
      top: 50%;
      width: 0;
      height: 0;
      border-left: 4px solid var(--mn-color-text-tertiary, #697386);
      border-top: 3.5px solid transparent;
      border-bottom: 3.5px solid transparent;
      transform: translateY(-50%) rotate(90deg);
      transform-origin: 2px 50%;
      opacity: 0;
      transition: opacity 0.15s ease, transform 0.15s ease, border-left-color 0.15s ease;
    }
    .editor-mount .ProseMirror .outliner-has-children:hover .outliner-fold-button::before,
    .editor-mount .ProseMirror .outliner-fold-button:hover::before,
    .editor-mount .ProseMirror .outliner-fold-button:focus-visible::before {
      opacity: 0.5;
    }
    .editor-mount .ProseMirror .outliner-fold-button[aria-expanded='false']::before {
      transform: translateY(-50%) rotate(0deg);
      border-left-color: var(--mn-color-text-accent, #3d7f5f);
      opacity: 0.85;
    }
    .editor-mount .ProseMirror .outliner-fold-button[aria-expanded='false']:hover::before {
      opacity: 1;
    }
    .editor-mount .ProseMirror .outliner-fold-button:focus-visible {
      outline: 2px solid var(--mn-color-border-accent, #3d7f5f);
      outline-offset: 2px;
      border-radius: var(--mn-radius-sm, 4px);
    }
    .editor-mount .ProseMirror .outliner-hidden,
    .editor-mount .ProseMirror .outliner-zoom-hidden {
      display: none !important;
    }
    .editor-mount .ProseMirror .outliner-zoom-root {
      font-size: var(--mn-text-lg, 1.125rem);
      font-weight: 650;
      padding-bottom: var(--mn-space-2, 0.5rem);
      margin-bottom: var(--mn-space-2, 0.5rem);
      border-bottom: 1px solid var(--mn-color-border-subtle, #d8dee4);
    }
    .editor-mount .ProseMirror .outliner-zoom-root::before {
      display: none !important;
    }
    .zoom-breadcrumb {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--mn-space-1, 0.25rem);
      padding: var(--mn-space-1, 0.25rem) var(--mn-space-4, 1rem)
        var(--mn-space-2, 0.5rem);
      font: 0.75rem/1.4 var(--mn-font-sans, system-ui, sans-serif);
      color: var(--mn-color-text-tertiary, #697386);
      background: var(--mn-color-surface-editor, var(--mn-color-surface-base, #fffdf8));
      border-bottom: 1px solid var(--mn-color-border-subtle, #d8dee4);
    }
    .zoom-breadcrumb[hidden] {
      display: none;
    }
    .zoom-breadcrumb-sep {
      color: var(--mn-color-text-tertiary, #697386);
      opacity: 0.65;
      user-select: none;
    }
    .zoom-breadcrumb-crumb {
      max-width: 16ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 4px;
      border: 0;
      border-radius: var(--mn-radius-sm, 4px);
      background: transparent;
      color: var(--mn-color-text-secondary, #475467);
      font: inherit;
      cursor: pointer;
    }
    .zoom-breadcrumb-crumb:hover {
      background: var(--mn-color-surface-hover, rgba(15, 23, 42, 0.05));
      color: var(--mn-color-text-primary, #1f2933);
    }
    .zoom-breadcrumb-crumb:focus-visible {
      outline: 2px solid var(--mn-color-border-accent, #3d7f5f);
      outline-offset: 2px;
    }
    .wire-radial-layer {
      display: contents;
    }
    .salience-gutter-layer {
      display: contents;
    }
    /* The block whose value controls are open wears a bar on its right edge,
       so it is plain which block is being valued (Eschaton, 2026-10-14: "make
       the block react"). The block being typed in wears the focus bar on its
       left; both are box-shadows, so they are listed together or one silently
       replaces the other. */
    .editor-mount .ProseMirror > [data-value-open] {
      box-shadow: inset -3px 0 0 color-mix(in srgb, var(--mn-color-accent, #16a34a) 55%, transparent);
    }
    .editor-mount .ProseMirror:focus > :is(p, h1, h2, h3)[data-block-focused][data-value-open] {
      box-shadow:
        inset 2px 0 0 var(--mn-color-border-accent, #3d7f5f),
        inset -3px 0 0 color-mix(in srgb, var(--mn-color-accent, #16a34a) 55%, transparent);
    }
    /* The value gutter at rest (value-marks.ts; graph doc "Value Gutter —
       revision (2026-10-16)"): a faint row right of each block's first line,
       pinned the way the wire bubble is on the left. The signal bars show while
       the block is hovered; the reader's own flag and valence always show. */
    .value-marks {
      position: absolute;
      left: calc(100% + 4px);
      /* Centered on the first line. Not 0.5lh: this row's own line-height
         is 0, so lh would measure the row, not the block's line. */
      top: calc(var(--mn-space-1-5, 0.375rem) + var(--mn-editor-line-height, 1.72) * 0.5em);
      z-index: 1;
      display: inline-flex;
      align-items: center;
      gap: 1px;
      transform: translateY(-50%);
      color: var(--mn-color-text-tertiary, #7a8580);
      line-height: 0;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
      transition: opacity var(--mn-transition-fast, 120ms ease);
    }
    .value-marks .salience-icon {
      width: 12px;
      height: 12px;
    }
    /* An atom (image, math, query, rule) cannot hold the
       row, so it hangs from this zero-height block just before the atom. It
       takes no space; an atom with a top margin (math) has
       its row a little above its first line. */
    .value-marks-anchor {
      position: relative;
      height: 0;
    }
    /* A table cell holds its row in the top-right corner, inside its padding:
       to the right of the cell is the next cell. */
    .value-marks--cell {
      left: auto;
      right: 2px;
      top: 2px;
      transform: none;
    }
    .value-marks--cell .salience-icon {
      width: 10px;
      height: 10px;
    }
    .value-marks-signal {
      display: inline-flex;
      visibility: hidden;
      opacity: 0.55;
    }
    /* Her own marks carry her decisions: fainter than the text, but not as
       faint as the machine's signal. */
    .value-marks-flag,
    .value-marks-valence {
      display: inline-flex;
      opacity: 0.8;
    }
    .value-marks-flag--2 .salience-icon + .salience-icon {
      margin-left: -6px;
    }
    @media (hover: hover) and (pointer: fine) {
      /* A table's rows belong to its cells: hovering one cell shows that
         cell's signal, not the whole table's. */
      .editor-mount .ProseMirror > :not(.tableWrapper):hover > .value-marks .value-marks-signal,
      .editor-mount .ProseMirror > :not(.tableWrapper):hover .value-marks .value-marks-signal,
      .editor-mount .ProseMirror > [data-value-open] .value-marks-signal,
      .editor-mount .ProseMirror :is(td, th):hover > .value-marks .value-marks-signal,
      .editor-mount .ProseMirror :is(td, th)[data-value-open] > .value-marks .value-marks-signal {
        visibility: visible;
      }
      /* Its own rule: an engine without :has() drops only this one. */
      .editor-mount .ProseMirror > .value-marks-anchor:has(+ :hover) .value-marks-signal,
      .editor-mount .ProseMirror > .value-marks-anchor:has(+ [data-value-open]) .value-marks-signal {
        visibility: visible;
      }
      .value-marks:hover > * {
        opacity: 1;
      }
    }
    :host([value-markers='always']) .value-marks-signal {
      visibility: visible;
    }
    /* Hidden draws nothing, but the row stays where it is, so hovering
       there still opens the controls: the only way to value a block. */
    :host([value-markers='hidden']) .value-marks {
      opacity: 0;
    }
    :host([value-markers='hidden']) .value-marks:hover {
      opacity: 1;
    }
    :host([zen]) .value-marks {
      display: none;
    }
    .salience-gutter {
      position: fixed;
      z-index: var(--mn-z-popover, 1100);
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 3px;
      border-radius: var(--mn-radius-md, 8px);
      background: var(--mn-color-surface-raised, #fff);
      box-shadow: var(--mn-shadow-popover, 0 4px 16px rgba(15, 23, 42, 0.18));
      animation: salience-gutter-in 100ms ease;
    }
    @keyframes salience-gutter-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .salience-gutter-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 1px;
      width: 20px;
      height: 20px;
      padding: 0;
      border: 0;
      border-radius: var(--mn-radius-sm, 4px);
      background: transparent;
      color: var(--mn-color-text-tertiary, #7a8580);
      cursor: pointer;
    }
    .salience-gutter-icon:hover {
      background: var(--mn-color-surface-hover, rgba(65, 91, 75, 0.08));
      color: var(--mn-color-text-secondary, #536159);
    }
    .salience-gutter-icon:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .salience-gutter-icon:disabled:hover {
      background: transparent;
      color: var(--mn-color-text-tertiary, #7a8580);
    }
    .salience-gutter-icon--scored {
      color: var(--mn-color-text-success, #16a34a);
    }
    .salience-gutter-icon--active {
      color: var(--mn-color-text-accent, #2563eb);
    }
    .salience-icon {
      width: 13px;
      height: 13px;
      flex-shrink: 0;
    }
    /* The importance view's always-visible value controls (block-controls.ts):
       a quiet row after each quote, for the block it quotes. */
    .block-controls {
      display: inline-flex;
      gap: 2px;
      margin-left: 8px;
      vertical-align: middle;
      user-select: none;
      -webkit-user-select: none;
    }
    .block-controls-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      min-width: 22px;
      height: 22px;
      padding: 0 4px;
      border: 0;
      border-radius: var(--mn-radius-control, 4px);
      background: transparent;
      color: var(--mn-color-text-muted, #8a8578);
      cursor: pointer;
    }
    .block-controls-button:hover:not(:disabled) {
      background: var(--mn-color-surface-hover, rgba(56, 91, 72, 0.08));
      color: var(--mn-color-text-primary, #1f2a24);
    }
    .block-controls-button--active {
      color: var(--mn-color-text-accent, #2d6a4f);
    }
    .block-controls-button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .block-controls-button .salience-icon {
      flex: none;
      width: 14px;
      height: 14px;
    }
    .block-controls-button .salience-icon + .salience-icon {
      margin-left: -7px;
    }

    .salience-gutter-numbers {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-top: 2px;
      padding: 4px 6px;
      border-top: 1px solid var(--mn-color-border-subtle, #ddd8ce);
      font-size: 10px;
      line-height: 1.4;
      color: var(--mn-color-text-secondary, #536159);
      white-space: nowrap;
    }
    .zoom-breadcrumb-current {
      max-width: 24ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 4px;
      color: var(--mn-color-text-primary, #1f2933);
      font-weight: 650;
    }
    .editor-mount .ProseMirror .outliner-collapsed-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 1.1rem;
      height: 1.1rem;
      margin-left: var(--mn-space-2, 0.5rem);
      padding: 0 0.35rem;
      font-size: 0.7rem;
      font-weight: 650;
      line-height: 1;
      color: var(--mn-color-text-tertiary, #697386);
      background: var(--mn-color-surface-hover, rgba(15, 23, 42, 0.06));
      border-radius: 999px;
      vertical-align: middle;
      user-select: none;
    }
    .editor-mount .ProseMirror .outliner-collapsed:hover .outliner-collapsed-count {
      color: var(--mn-color-text-accent, #3d7f5f);
    }
    .editor-mount .ProseMirror .block-selected {
      background: var(--mn-color-surface-accent, rgba(61, 127, 95, 0.12));
      box-shadow: inset 2px 0 0 var(--mn-color-border-accent, #3d7f5f);
      border-radius: var(--mn-radius-md, 6px);
    }
    .editor-mount .ProseMirror .block-selected ::selection,
    .editor-mount .ProseMirror .block-selected::selection {
      background: transparent;
    }
    /* ONE drag handle for the whole document, a sibling of the editor root
       (BlockDnd's BlockHandleOverlay). It used to be a widget inside every
       block's text, which WebKit's caret and drag selection walked into. The
       overlay sets left/top to the hovered block's left edge and first-line
       centre; the offsets here put it in the gutter beside that line. Tables
       get the same placement, since the handle is no longer inside one. */
    .editor-mount > .block-drag-handle {
      position: absolute;
      z-index: 1;
      margin-left: -1.15rem;
      transform: translateY(-50%);
      width: 0.85rem;
      height: 1.1rem;
      border-radius: var(--mn-radius-sm, 4px);
      cursor: grab;
      opacity: 0;
      pointer-events: none;
      color: var(--mn-color-text-tertiary, #697386);
      background-image: radial-gradient(currentColor 1px, transparent 1.4px);
      background-size: 4px 4px;
      background-position: center;
      transition: opacity 0.15s ease, color 0.15s ease;
      user-select: none;
      -webkit-user-select: none;
    }
    .editor-mount > .block-drag-handle[data-visible] {
      opacity: 0.6;
      pointer-events: auto;
    }
    .editor-mount > .block-drag-handle[data-visible]:hover {
      opacity: 1;
      color: var(--mn-color-text-accent, #3d7f5f);
    }
    .editor-mount > .block-drag-handle:active {
      cursor: grabbing;
    }
    /* Paragraph/heading wires promote their node marker above. Other block
       kinds retain the separate wire dot — same pulse treatment, so a wired
       blockquote/list-item/code-block reads as alive too, not just flagged.
       The dot keeps its static surface-color separator ring at rest; the
       pulse animates a second, outer accent ring layered alongside it
       (reusing node-wire-pulse's box-shadow directly would clobber the
       separator ring rather than layer with it). */
    @keyframes node-wire-pulse-dot {
      0%, 100% {
        opacity: 0.72;
        box-shadow: 0 0 0 2px var(--mn-color-surface-editor, #fffdf8), 0 0 0 4px rgba(61, 127, 95, 0.16);
      }
      50% {
        opacity: 1;
        box-shadow: 0 0 0 2px var(--mn-color-surface-editor, #fffdf8), 0 0 0 5px rgba(61, 127, 95, 0.3);
      }
    }
    .editor-mount .ProseMirror [data-block-wired]:not(p):not(h1):not(h2):not(h3):not(li)::after {
      content: '';
      position: absolute;
      left: var(--mn-space-5, 1.25rem);
      top: calc(var(--mn-space-1-5, 0.375rem) + 0.52lh);
      width: 0.45rem;
      height: 0.45rem;
      border-radius: 999px;
      background: var(--mn-color-text-accent, #3d7f5f);
      box-shadow: 0 0 0 2px var(--mn-color-surface-editor, #fffdf8);
      pointer-events: none;
      animation: var(--mn-wire-pulse-animation, node-wire-pulse-dot 2s ease-in-out infinite);
    }
    .editor-mount .ProseMirror [data-block-wired]:not(p):not(h1):not(h2):not(h3):not(li):hover::after {
      background: var(--mn-color-accent-hover, #2f6f4f);
      animation: none;
      box-shadow: 0 0 0 2px var(--mn-color-surface-editor, #fffdf8), var(--mn-focus-ring, 0 0 0 2px rgba(61, 127, 95, 0.22));
    }
    @media (prefers-reduced-motion: reduce) {
      .editor-mount .ProseMirror [data-block-wired]:not(p):not(h1):not(h2):not(h3):not(li)::after {
        animation: none;
      }
    }
    /* ── Wire highlight ─────────────────────────────────────────────────────
       TWO TREATMENTS, because hovering and arriving are different events.
       Ported from cloud-1, which drew them apart and felt right for it; this
       frontend had collapsed both onto one hard on/off outline.

         hover   — steady and quiet, eased in under the pointer. You are
                   browsing a list; the document answers without shouting.
         arrival — a one-shot pulse. You were carried here from somewhere else
                   and the block says which one it is.

       Cloud-1 got its pulse by animating opacity and transform: scale() on a
       position: fixed overlay div appended to document.body and kept aligned
       by a scroll listener. NOT ported, on purpose: that overlay needs
       re-measuring on every scroll, resize and reflow, and being a body-level
       singleton it cannot represent two panes at once — which is a fair
       suspect for why this kept breaking there. Same reason the pulse below
       animates box-shadow rather than transform: scaling a real block would
       shove the text around it. The expanding ring reads as the swell without
       touching layout.

       The value selector is deliberate and load-bearing — see the note on
       _syncWireHighlight, and the guard in wire-highlight-contract.test.ts
       that couples this string to the writer. */
    /* Move mode: the lifted block. A border and a shadow, no layout change,
       so the block does not shift as it lifts. */
    .editor-mount .ProseMirror [data-block-moving='true'] {
      border-radius: 6px;
      outline: 1px solid var(--mn-color-border-accent, #3d7f5f);
      background: var(--mn-color-surface-base, #fff);
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.16);
      cursor: grab;
      caret-color: transparent;
    }

    .editor-mount .ProseMirror [data-wire-highlighted='true'] {
      border-radius: 6px;
      outline: 1px solid var(--mn-color-border-accent, #3d7f5f);
      background: var(--mn-color-surface-accent, #eef8f2);
      box-shadow: 0 0 0 3px rgba(61, 127, 95, 0.16);
      /* Kept for the case where the element PERSISTS and only its attributes
         change — moving the highlight between blocks can mutate rather than
         replace. It does nothing on the common path; see the note on the
         hover animation below. */
      transition:
        background var(--mn-transition-fast, 110ms ease),
        outline-color var(--mn-transition-fast, 110ms ease),
        box-shadow var(--mn-transition-fast, 110ms ease);
    }
    /* HOVER FADES IN WITH AN ANIMATION, NOT A TRANSITION, and the difference is
       forced by decorations rather than chosen.

       Applying a decoration makes ProseMirror REPLACE the block element —
       measured: elementReplacedByDecoration: true. The replacement is born
       already carrying the highlight, so there is no earlier value for a
       transition to run from, and the fade never fires. The declaration above
       was valid the whole time (0.11s, correct easing) and simply had nothing
       to animate; on screen it read as instant.

       An animation runs when the element is rendered, which is exactly what a
       decoration produces. The arrival pulse below was already an animation,
       which is why it worked while this did not — the same file, the same
       state, one mechanism compatible with decorations and one not.

       The keyframes carry only a from: the implicit to is the element's own
       computed style, so the fade lands on whatever the rule above says without
       restating those values here and letting them drift. */
    @keyframes mn-wire-hover-in {
      from {
        outline-color: transparent;
        background: transparent;
        box-shadow: 0 0 0 0 rgba(61, 127, 95, 0);
      }
    }
    .editor-mount .ProseMirror [data-wire-highlight-mode='hover'] {
      animation: mn-wire-hover-in 190ms ease-out 1;
    }
    @media (prefers-reduced-motion: reduce) {
      .editor-mount .ProseMirror [data-wire-highlight-mode='hover'] {
        animation: none;
      }
    }
    @keyframes mn-wire-arrival-pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(61, 127, 95, 0.45);
      }
      40% {
        box-shadow: 0 0 0 6px rgba(61, 127, 95, 0.26);
      }
      100% {
        box-shadow: 0 0 0 12px rgba(61, 127, 95, 0);
      }
    }
    .editor-mount .ProseMirror [data-wire-highlight-mode='arrival'] {
      animation: mn-wire-arrival-pulse 950ms ease-out 1;
    }
    /* The tint still fades in and out; only the ring's flourish is dropped. */
    @media (prefers-reduced-motion: reduce) {
      .editor-mount .ProseMirror [data-wire-highlight-mode='arrival'] {
        animation: none;
      }
    }
    .mg-widget {
      position: absolute;
      left: 100%;
      top: var(--mn-space-1-5, 0.375rem);
      display: none;
      width: var(--mn-margin-col, 248px);
      margin-left: var(--mn-space-6, 1.5rem);
      padding-left: var(--mn-space-3, 0.75rem);
      border-left: var(--mn-rule-hair, 1px solid var(--mn-color-border-subtle, rgba(15, 23, 42, 0.12)));
      flex-direction: column;
      gap: var(--mn-space-1, 0.25rem);
      user-select: none;
      z-index: 1;
    }
    .mg-note {
      display: flex;
      flex-direction: column;
      gap: 1px;
      cursor: pointer;
    }
    .mg-note:hover .mg-target {
      color: var(--mn-color-text-primary, #1f2933);
    }
    .mg-predicate {
      color: var(--mn-color-marginalia-ink, var(--mn-color-text-accent, #3d7f5f));
      font: 500 var(--mn-text-marginalia, 11px)/1.25 var(--mn-font-chrome, system-ui, sans-serif);
      font-variant-numeric: tabular-nums;
      letter-spacing: var(--sophia-tracking-label, 0.04em);
      white-space: nowrap;
    }
    .mg-target {
      color: var(--mn-color-text-secondary, #475467);
      font: 500 var(--mn-text-2xs, 0.72rem)/1.25 var(--mn-font-chrome, system-ui, sans-serif);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mg-snippet {
      display: -webkit-box;
      max-height: 2.6em;
      overflow: hidden;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      color: var(--mn-color-text-tertiary, #697386);
      font: 400 var(--mn-text-2xs, 0.72rem)/1.25 var(--mn-font-prose, serif);
    }
    .editor-mount .ProseMirror .search-match {
      border-radius: 2px;
      background: var(--mn-color-search-match, #fff1a8);
      color: inherit;
    }
    .editor-mount .ProseMirror .search-match-current {
      background: var(--mn-color-search-current, #ffd166);
      box-shadow: 0 0 0 1px var(--mn-color-border-accent, #3d7f5f);
    }
    .editor-mount .ProseMirror[contenteditable='false'] ~ .block-drag-handle {
      display: none;
    }
    .editor-mount .ProseMirror .block-dragging {
      opacity: 0.4;
    }
    .editor-mount .ProseMirror .block-drop-indicator {
      content: '';
      position: absolute;
      left: 0;
      right: var(--mn-space-2, 0.5rem);
      height: 2px;
      background: var(--mn-color-border-accent, #3d7f5f);
      border-radius: 1px;
      box-shadow: 0 0 4px rgba(61, 127, 95, 0.45);
      pointer-events: none;
      z-index: 1;
    }
    .editor-mount .ProseMirror .block-drop-indicator[data-mode='before'] {
      top: -1px;
    }
    .editor-mount .ProseMirror .block-drop-indicator[data-mode='after'] {
      bottom: -1px;
    }
    .editor-mount .ProseMirror > .image-block {
      position: relative;
      padding: var(--mn-space-3, 0.75rem) 0 var(--mn-space-3, 0.75rem) var(--mn-space-6, 1.5rem);
    }
    .editor-mount .ProseMirror > .image-block img {
      display: block;
      max-width: 100%;
      height: auto;
      border-radius: var(--mn-radius-sm, 4px);
      cursor: pointer;
    }
    .editor-mount .ProseMirror > .image-block.ProseMirror-selectednode {
      border-radius: var(--mn-radius-sm, 4px);
      outline: 2px solid var(--mn-color-border-focus, #3d7f5f);
      outline-offset: 2px;
    }
    .editor-mount .ProseMirror > .image-block[data-size='small'] img {
      width: 33%;
    }
    .editor-mount .ProseMirror > .image-block[data-size='medium'] img {
      width: 66%;
    }
    .editor-mount .ProseMirror > .image-block[data-size='large'] img {
      width: 100%;
    }
    .editor-mount .ProseMirror > .image-block .image-block-placeholder {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--mn-space-3, 0.75rem) var(--mn-space-4, 1rem);
      border: 1px dashed var(--mn-color-border-subtle, #d8ddd8);
      border-radius: var(--mn-radius-sm, 4px);
      color: var(--mn-color-text-muted, #697386);
      font-family: var(--mn-font-ui, system-ui, sans-serif);
      font-size: var(--mn-text-sm, 0.875rem);
    }
    .editor-mount .ProseMirror > .image-block .image-block-placeholder-alt {
      color: var(--mn-color-text-secondary, #4b5563);
      font-weight: 600;
    }
    .image-resize-button {
      position: fixed;
      z-index: 200;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 7px;
      border: 1px solid var(--mn-color-border-default, rgba(15, 23, 42, 0.16));
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-secondary, #475467);
      box-shadow: var(--mn-shadow-raised, 0 2px 8px rgba(15, 23, 42, 0.12));
      font: 600 var(--mn-type-ui-xs-size, 0.75rem)/1.2 var(--mn-font-sans, system-ui, sans-serif);
      cursor: pointer;
      pointer-events: auto;
      white-space: nowrap;
    }
    .image-resize-button:hover {
      background: var(--mn-color-surface-hover, rgba(15, 23, 42, 0.05));
      color: var(--mn-color-text-primary, #1f2933);
    }
    .image-resize-button:focus-visible {
      outline: 2px solid var(--mn-color-border-focus, #3d7f5f);
      outline-offset: 2px;
    }
    .image-resize-glyph {
      width: 0.7rem;
      height: 0.7rem;
      border: 1.5px solid currentColor;
      border-radius: 2px;
      box-sizing: border-box;
    }
  `

  /** The injected reactive seam (D4). The host READS only — get()/subscribe(). */
  @property({ attribute: false })
  binding: EditorHostBinding | null = null

  /**
   * `floating` follows the historical measured workspace anchor. `contained`
   * fills a position:relative pane stage, allowing several independent Class-B
   * hosts without a document-global anchor id.
   */
  @property({ reflect: true, attribute: 'layout-mode' })
  layoutMode: 'floating' | 'contained' = 'floating'

  /** Only the active pane consumes document-level editor shortcuts. */
  @property({ type: Boolean, reflect: true, attribute: 'pane-active' })
  paneActive = true

  /**
   * OPAQUE kernel-options forwarded into the live editor's kernel slot — the two
   * wikilink callbacks the shell assembled (buildKernelOptions(services, scope)),
   * typed via the sibling collab module's EditorKernelOptions alias so the
   * island-scanned host carries them as plain function values WITHOUT importing
   * @shrubbery/editor-kernel (which the island guard forbids). The concrete
   * EditorServices/RestClient assembly stays in the shell + editor-services/ subdir;
   * the host never sees the contract — only these opaque callbacks.
   *
   * LOAD-BEARING: this is NOT part of the provider-identity compare (_reconcileEditor
   * keys teardown SOLELY on the ProviderHandle). A kernelOptions VALUE change does
   * not rebuild the live editor (which would drop the undo history) — it is read once
   * when a provider is first claimed (_mountClaimed). The shell builds it ONCE per
   * provider claim and re-emits the SAME object across re-renders.
   */
  @property({ attribute: false })
  kernelOptions: EditorKernelOptions | null = null

  /** Stable block id restored by the shell from URL state (`?b=` in Garden). */
  @property({ attribute: false })
  initialZoomBlockId: string | null = null

  /** Read-side wire bundle for the open document. Plain data; no backend services. */
  @property({ attribute: false })
  wireBundle: WireBundle | null = null

  /** Read-side per-block salience scores for the open document, for the value gutter. */
  @property({ attribute: false })
  salienceBundle: SalienceBundle | null = null

  /**
   * Scores of the blocks the importance view quotes, keyed by
   * sourceScoreKey(documentId, blockId). The shell fills it after
   * IMPORTANCE_VIEW_SOURCES_EVENT.
   */
  @property({ attribute: false })
  sourceSalienceScores: ReadonlyMap<string, BlockScore> | null = null

  /** Importance view: an entry's source line id → the source block it stands for. */
  private _importanceTargets = new Map<string, ImportanceViewTarget>()
  private _importanceTargetsKey = ''

  /** Shell-owned context previews for the Garden-style radial wire overlay. */
  @property({ attribute: false })
  wireRadialContexts: WireRadialContextMap | null = null

  /** Transient Garden-style request to center/highlight a block after navigation. */
  @property({ attribute: false })
  focusRequest: EditorBlockFocusRequest | null = null

  /**
   * Runtime-owned acquisition seam for Garden's Insert Image toolbar action.
   *
   * Garden opens a file picker, uploads to `/artifacts/:graph/images/upload`, and
   * inserts the stable artifact URL. Shrubbery does not yet have that upload
   * service in the contract, so shells can provide the real uploader here; the
   * host's fallback asks for a URL and still inserts a real image node.
   */
  @property({ attribute: false })
  imageInserter: EditorImageInserter | null = null

  /**
   * Runtime-owned acquisition seam for Garden's Footnote toolbar action. Garden
   * opens a rich dialog; Shrubbery keeps that UI host-side and passes only the
   * resulting content into the pure kernel command.
   */
  @property({ attribute: false })
  footnoteInserter: EditorFootnoteInserter | null = null

  /**
   * Runtime-owned acquisition seam for Garden's Add Comment toolbar action.
   *
   * The kernel mark stores only a comment id; comment body/author/resolution live
   * in a host store. Shells can return a stable id here and listen for
   * `mn-editor-comment-inserted` to persist metadata keyed by that id.
   */
  @property({ attribute: false })
  commentInserter: EditorCommentInserter | null = null

  /** Controlled browser TTS state; playback itself remains shell-owned. */
  @property({ attribute: false })
  ttsStatus: 'idle' | 'loading' | 'playing' | 'paused' = 'idle'

  @property({ attribute: false })
  ttsAvailable = false

  /** Controlled shell projection for the alternate original-file presentation. */
  @property({ attribute: false })
  originalFileView: EditorOriginalFileView | null = null

  /** Authoritative workspace projection for read-only imported documents. */
  @property({ attribute: false })
  documentAccess: EditorDocumentAccess | null = null

  /** The last state read from the binding (drives the placeholder render). */
  @state()
  private hostState: EditorHostState | null = null

  @state()
  private searchOpen = false

  @state()
  private searchQuery = ''

  @state()
  private replaceQuery = ''

  @state()
  private searchResultCount = 0

  @state()
  private searchCurrentIndex = 0

  @state()
  private formatState: EditorFormatState = defaultFormatState()

  @state()
  private wireOverlayOpen = false

  @state()
  private wireOverlayBlockId: string | null = null

  @state()
  private wireOverlayAnchor: { readonly x: number; readonly y: number } = { x: 0, y: 0 }

  @state()
  private salienceOverlayOpen = false

  @state()
  private salienceOverlayBlockId: string | null = null

  @state()
  private salienceOverlayAnchor: { readonly x: number; readonly y: number } = { x: 0, y: 0 }

  /** Click on the signal icon toggles this — the composite-score numbers panel. */
  @state()
  private salienceOverlayExpanded = false

  private hoveredImageBlockId: string | null = null

  private hoveredImageRect: DOMRect | null = null

  private inputDialogResolve: ((value: string | null) => void) | null = null

  private zoomSnapshot: LiveZoomSnapshot = { blockId: null, breadcrumb: [] }

  /** The binding subscription teardown, if subscribed. */
  private _unsub: (() => void) | null = null

  /** Live status testimony for the provider currently claimed by this host. */
  private _providerLifecycleUnsub: (() => void) | null = null
  private _providerActivationUnsub: (() => void) | null = null
  private _readinessProvider: NonNullable<EditorHostState['provider']> | null = null

  @state()
  private _activationSynced = true

  @state()
  private _activationEditable = true

  @state()
  private _activationPhase: 'loading' | 'offline-clean' | 'offline-dirty' | 'live' | 'conflict' = 'live'

  @state()
  private _activationDurability: 'none' | 'pending' | 'durable' | 'failed' = 'durable'

  @state()
  private _activationConflict: 'deleted' | 'replaced' | 'unfenced' | null = null

  @state()
  private _activationRenderSource: 'pending' | 'memory' | 'indexeddb' | 'snapshot' | 'live' = 'pending'

  /** Separate interaction lock used by wire mode's public setEditable handle. */
  private _requestedEditable = true

  /** Re-measure on container resize. */
  private _ro: ResizeObserver | null = null

  /** Rebind the measured center anchor when a collapse/mode render replaces it. */
  private _layoutObserver: MutationObserver | null = null
  private _layoutMain: HTMLElement | null = null
  private _observedAnchor: Element | null = null
  private readonly _onSplitReposition = (): void => this._position()

  /**
   * The live collaborative editor (the REAL TipTap Editor), or null when the body is a
   * placeholder. Held as the raw editor so the existing `(host as { _editor }).commands`
   * test probes keep reaching the real command surface; the narrow public
   * LiveEditorHandle is projected from it by the `liveEditor` getter.
   */
  private _editor: RawLiveEditor | null = null

  /** Last editability value actually applied to the current EditorView. */
  private _editorEditable: boolean | null = null

  /**
   * The narrow public LiveEditorHandle projected over `_editor`, built ONCE per live
   * editor and held by STABLE reference. Identity tracks the underlying EditorView: the
   * same handle is returned across re-renders while the same editor survives (the
   * mount-once / undo-survival contract is asserted via `liveEditor` identity), and it is
   * cleared on teardown so a rebuilt editor yields a fresh handle.
   */
  private _editorHandle: LiveEditorHandle | null = null

  /**
   * Live content-change subscriptions (W14.1(b)). HOST-level, not handle-level,
   * and deliberately NOT cleared on disconnect — see
   * `onDocumentContentChanged`'s doc comment for both reasons.
   */
  private readonly _contentSubscriptions = new Set<EditorContentSubscription>()

  /**
   * The frozen-ghost crossfade overlay (CONTINUITY PART ONE): a pure-pixel
   * `cloneNode(true)` snapshot of the outgoing editor's rendered DOM, appended
   * as an absolutely-positioned child of `.editor-mount` the instant a
   * DIFFERENT-provider switch begins (see `_reconcileEditor`), so the mount
   * region is never visually empty during the `whenSynced`-gated async remount
   * gap. It carries NO editor, NO provider, NO listeners — inert/aria-hidden/
   * pointer-events:none pixels only, so it cannot affect collab or undo.
   * Removed the instant the new editor has mounted and painted
   * (`_scheduleGhostRemoval`, called from `_mountClaimed`), replaced before a
   * fresher one is created (`_freezeEditorGhost`), and unconditionally cleared
   * on `disconnectedCallback` and whenever `_wantsLiveBody` flips false — every
   * exit path is guarded so no permanent orphan overlay can survive.
   */
  private _editorGhost: HTMLElement | null = null
  // Belt-and-suspenders for the ghost: if the new editor never mounts within a
  // generous window (e.g. neither cache nor room establishes renderability, so
  // `_scheduleGhostRemoval` never fires), drop the stale overlay
  // anyway. Showing the PREVIOUS document's frozen pixels forever is worse than
  // the honest loading/blank state; the backend decouple keeps sync prompt, but
  // continuity must degrade gracefully on its own if it ever hangs again.
  private static readonly GHOST_MAX_LIFETIME_MS = 8000
  private _ghostTimeout: ReturnType<typeof setTimeout> | null = null
  private _zoomUnsub: (() => void) | null = null
  private _wireClickUnsub: (() => void) | null = null
  private _headingObserver: IntersectionObserver | null = null
  private _headingObservedIds: string[] = []
  private _headingIntersecting = new Map<string, boolean>()
  private _currentHeadingId: string | null = null
  private _highlightedWireBlockId: string | null = null
  /**
   * WHY the highlight has a mode: hovering a wire card and ARRIVING on a block
   * are different events and cloud-1 drew them differently — a steady, quiet
   * outline that eases in under the pointer, versus a one-shot pulse that
   * announces where you just landed. Shrubbery had collapsed both onto one
   * hard on/off treatment, which reads as blunt even once it is visible.
   */
  private _wireHighlightMode: 'hover' | 'arrival' = 'hover'
  private _activeCommentId: string | null = null
  /** The comment the pointer is over, so a hover emits one enter and one leave. */
  private _hoveredCommentMarkId: string | null = null
  /** Where the last press in the text began, to tell a click from a drag. */
  private _commentMouseDownAt: { x: number; y: number } | null = null
  private _lastFocusRequestToken: number | null = null
  private _blockFocusRetryToken = 0
  private _blockFocusHighlightTimer: ReturnType<typeof setTimeout> | null = null
  private _imageHoverLeaveTimer: ReturnType<typeof setTimeout> | null = null
  private _wireOverlayHoverTimer: ReturnType<typeof setTimeout> | null = null
  private _wireOverlayCloseTimer: ReturnType<typeof setTimeout> | null = null
  private _salienceOverlayHoverTimer: ReturnType<typeof setTimeout> | null = null
  private _salienceOverlayCloseTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * ACTIVE PANE ONLY. The event is dispatched on `ownerDocument`, so every
   * mounted host hears it — with the same document open in two panes (a real
   * thing to do on something long: top in one, bottom in the other), an
   * ungated handler lights the block up in both.
   *
   * The arrival path already had this right: `main.ts` hands `focusRequest` to
   * the active pane and null to the rest, so only one pane ever scrolls. Hover
   * had no equivalent gate. Eschaton's rule, and it generalizes: the highlight
   * does not merely light up, it MOVES you — and only the pane you are working
   * in should move.
   */
  private _onWireHighlightEvent = (event: Event): void => {
    const detail = (event as CustomEvent<WireHighlightBlockDetail>).detail
    const blockId = detail?.blockId ?? null
    // A CLEAR ALWAYS LANDS, whatever pane this is. The gate below is right for
    // a highlight — the event goes to ownerDocument so every mounted host hears
    // it, and only the pane being worked in should light up — but gating the
    // CLEAR too was a bug I shipped in d5fce23 and Beta caught in review.
    //
    // `blockId: null` is the wires panel's mouse-leave (wires-panel.ts's
    // `clearHighlight`), carried on the same event. Dropping it stranded the
    // highlight: hover a card while pane A is active, click into pane B, then
    // leave the card — the clear arrives at an inactive pane A, is discarded,
    // and A keeps a highlight nothing will remove until its next hover.
    //
    // A clear can only ever REMOVE, so honouring it in an inactive pane costs
    // nothing and is strictly safer than the alternative. Only the positive
    // case needs the gate.
    if (blockId === null) {
      this._setWireHighlight(null, 'hover')
      return
    }
    if (!this.paneActive) return
    this._setWireHighlight(blockId, 'hover')
  }

  private _onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (!this.paneActive || event.defaultPrevented || !this._editor || this.originalFileView?.active) return
    const key = event.key.toLowerCase()
    const readOnly = this._effectiveReadOnly()
    if (!readOnly && (event.metaKey || event.ctrlKey) && event.shiftKey && key === 'f') {
      event.preventDefault()
      event.stopPropagation()
      void this._insertFootnoteFromToolbar()
      return
    }
    // Shift turns '.' into '>' on most layouts, so match the physical key too.
    const period = event.key === '.' || event.key === '>' || event.code === 'Period'
    if (!readOnly && (event.metaKey || event.ctrlKey) && event.shiftKey && period) {
      event.preventDefault()
      event.stopPropagation()
      void this._insertCommentFromToolbar()
      return
    }
    if ((event.metaKey || event.ctrlKey) && key === 'f') {
      event.preventDefault()
      event.stopPropagation()
      this._openSearch()
      return
    }
    if (event.key === 'Escape' && this.searchOpen) {
      event.preventDefault()
      event.stopPropagation()
      this._closeSearch()
    }
  }

  /**
   * The provider the current `_editor` was built for — identity-compared to
   * decide rebuild-vs-keep on each update. When the binding hands over a DIFFERENT
   * ProviderHandle (a new room opened), the old editor is destroyed and a fresh
   * one is mounted on the new doc. Same provider ⇒ keep the live editor.
   */
  private _editorProvider: unknown = null

  /**
   * Root-level editor material is reflected onto this shadow host instead of
   * relying on :host-context(). The explicit attribute works in the WebKit
   * desktop target as well as Chromium and lets the page remain a light,
   * physical sheet when the surrounding workspace uses dark chrome.
   */
  private _editorMaterialObserver: MutationObserver | null = null

  private _syncEditorMaterial(): void {
    const material = this.ownerDocument.documentElement?.dataset.editorMaterial
    if (material === 'paper') {
      this.setAttribute('editor-material', material)
    } else {
      this.removeAttribute('editor-material')
    }
    this.toggleAttribute('zen', this.ownerDocument.documentElement?.hasAttribute('data-zen') === true)
    // Appearance > Value markers: hover (default, no attribute), always, hidden.
    const markers = this.ownerDocument.documentElement?.dataset.valueMarkers
    if (markers === 'always' || markers === 'hidden') this.setAttribute('value-markers', markers)
    else this.removeAttribute('value-markers')
  }

  private _observeEditorMaterial(): void {
    this._editorMaterialObserver?.disconnect()
    this._editorMaterialObserver = null
    const root = this.ownerDocument.documentElement
    const Observer = this.ownerDocument.defaultView?.MutationObserver
    this._syncEditorMaterial()
    if (!root || !Observer) return
    this._editorMaterialObserver = new Observer(() => this._syncEditorMaterial())
    this._editorMaterialObserver.observe(root, {
      attributes: true,
      attributeFilter: ['data-editor-material', 'data-zen', 'data-value-markers'],
    })
  }

  /**
   * Whether a live body SHOULD exist for the current state: an open provider on a
   * document center that is past the loading/error gates. Drives render() choosing
   * the stable mount-target <div> over a placeholder.
   */
  private get _wantsLiveBody(): boolean {
    const s = this.hostState
    return !!(
      s &&
      s.provider &&
      s.centerMode === 'document' &&
      s.status !== 'error' &&
      s.status !== 'loading'
    )
  }

  private _observeLayoutAnchor(): void {
    if (this.layoutMode === 'contained') return
    const anchor = this.ownerDocument.getElementById(ANCHOR_ID)
    if (anchor === this._observedAnchor) return
    if (this._observedAnchor) this._ro?.unobserve(this._observedAnchor)
    this._observedAnchor = anchor
    if (anchor) this._ro?.observe(anchor)
  }

  override connectedCallback(): void {
    super.connectedCallback()
    this._observeEditorMaterial()
    this.ownerDocument.addEventListener(
      WIRE_HIGHLIGHT_BLOCK_EVENT,
      this._onWireHighlightEvent as EventListener,
    )
    this.ownerDocument.addEventListener('keydown', this._onDocumentKeyDown, { capture: true })
    this._subscribe()
    // Reconnect after a real DOM reparent (e.g. the layout-as-data interpreter
    // relocating this host's wrapper under a new split ancestor — LAY-007/
    // design §4.2's "a move must not destroy the EditorView") tears the live
    // editor down via disconnectedCallback -> _teardownEditor, but `hostState`
    // is a plain field (not a Lit reactive property) reseeded to the SAME
    // object reference by `_subscribe()` above, so nothing here otherwise
    // requests an update — `updated()` (and therefore `_reconcileEditor()`)
    // would never run again and the mount target would stay permanently
    // empty. Mirror disconnectedCallback's symmetric `_teardownEditor()` call
    // with an explicit reconcile here; `_reconcileEditor()`/`_mountClaimed`
    // are already idempotent (a no-op once an editor exists, and safely
    // re-triggerable before the mount target is even stamped), so this is
    // safe on every ordinary connect, not just a reparent.
    this._reconcileEditor()
    this._layoutMain = this.closest('.main')
    this._layoutMain?.addEventListener('sl-reposition', this._onSplitReposition)
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._position())
      if (this._layoutMain) this._ro.observe(this._layoutMain)
      this._observeLayoutAnchor()
    }
    if (this._layoutMain && typeof MutationObserver !== 'undefined') {
      this._layoutObserver = new MutationObserver(() => {
        this._observeLayoutAnchor()
        this._position()
      })
      this._layoutObserver.observe(this._layoutMain, { childList: true, subtree: true })
    }
  }

  override disconnectedCallback(): void {
    this.ownerDocument.removeEventListener(
      WIRE_HIGHLIGHT_BLOCK_EVENT,
      this._onWireHighlightEvent as EventListener,
    )
    this.ownerDocument.removeEventListener('keydown', this._onDocumentKeyDown, { capture: true })
    this._unsub?.()
    this._unsub = null
    this._providerLifecycleUnsub?.()
    this._providerLifecycleUnsub = null
    this._providerActivationUnsub?.()
    this._providerActivationUnsub = null
    this._readinessProvider = null
    this._layoutMain?.removeEventListener('sl-reposition', this._onSplitReposition)
    this._layoutObserver?.disconnect()
    this._layoutObserver = null
    this._layoutMain = null
    this._observedAnchor = null
    this._ro?.disconnect()
    this._ro = null
    this._editorMaterialObserver?.disconnect()
    this._editorMaterialObserver = null
    // Drop any frozen-ghost overlay — an unmount must never leave one orphaned.
    this._removeEditorGhost()
    // Tear down the live EditorView so its ProseMirror/CRDT bindings are released.
    this._teardownEditor()
    // Nothing may fire at a content subscriber while the host is detached — a
    // DOM relocation is not a content change. The subscriptions themselves
    // survive (see `onDocumentContentChanged`); only the armed windows drop.
    this._cancelPendingContentNotify()
    super.disconnectedCallback()
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('binding')) this._subscribe()
    // Reconcile the live body AFTER render() has stamped/removed the mount target.
    this._reconcileEditor()
    if (changed.has('documentAccess')) this._syncDocumentAccess()
    if (changed.has('sourceSalienceScores') || changed.has('documentAccess')) this._syncImportanceView()
    if (changed.has('initialZoomBlockId') && this._editor) this._applyInitialZoom()
    if (changed.has('focusRequest') && this._editor) this._applyFocusRequest()
    if (changed.has('salienceBundle')) {
      // The shell updates the bundle optimistically and rolls it back on a
      // failed write, so a new bundle is the truth either way: a rating
      // pending here only bridges the moment before it arrives. Keeping one
      // past that would show a rating that failed, or hide one an agent or
      // another window just changed (Angel review, 2026-10-16).
      this._pendingRatings.clear()
      this._syncValueMarks()
    }
    if (changed.has('wireBundle')) {
      this._syncWireIndicators()
      this._syncValueMarks()
      this._syncMarginGloss()
      this._closeWireOverlay()
    }
    // NO analogous `changed.has('salienceBundle') → close` here — unlike
    // wireBundle (which only changes on document-switch/create/delete, rare
    // events unrelated to the open overlay), a click on the gutter's own
    // importance/valence icon is exactly what updates salienceBundle next.
    // Auto-closing on that change would close the popover the instant a
    // rating landed — the real document-switch case is already covered by
    // `_teardownEditor()`'s own `_closeSalienceOverlay()` call.
    this._syncWireHighlight()
    this._position()
    this._paintZoomBreadcrumb()
    this._paintImageResizeButton()
  }

  private _syncDocumentAccess(): void {
    const readOnly = this._effectiveReadOnly()
    this.toggleAttribute('data-document-read-only', readOnly)
    if (this._editorProvider) {
      this.setAttribute(
        'data-document-activation',
        this._activationPhase,
      )
      this.setAttribute('data-document-render-source', this._activationRenderSource)
      this.setAttribute('data-document-durability', this._activationDurability)
      if (this._activationConflict) {
        this.setAttribute('data-document-conflict', this._activationConflict)
      } else {
        this.removeAttribute('data-document-conflict')
      }
    } else {
      this.removeAttribute('data-document-activation')
      this.removeAttribute('data-document-render-source')
      this.removeAttribute('data-document-durability')
      this.removeAttribute('data-document-conflict')
    }
    // Provider/readiness promises can settle in the same turn that a Surface
    // is being detached. During that narrow DOM-removal phase happy-dom (and
    // potentially a custom-element reparent) can still report the host itself
    // as connected after its shadow host/editor DOM has ceased to be usable.
    // Require the concrete EditorView mount testimony before driving it.
    const editorDom = this.renderRoot?.querySelector('.editor-mount .ProseMirror')
    const shadowStillOwned = this.shadowRoot?.host === this
    const editable = !readOnly
    if (
      this.isConnected
      && shadowStillOwned
      && editorDom?.isConnected
      && this._editor
      && this._editorEditable !== editable
    ) {
      this._editor.setEditable(editable)
      this._editorEditable = editable
    }
  }

  private _effectiveReadOnly(): boolean {
    return (
      (this.documentAccess?.readOnly ?? false)
      || !this._activationEditable
      || this._activationPhase === 'conflict'
      || (
        this._activationDurability === 'failed'
        && this._activationPhase !== 'live'
      )
      || !this._requestedEditable
    )
  }

  /**
   * Toolbar read-only presentation describes document authority, not a
   * temporary interaction lock such as wire targeting.
   */
  private _toolbarReadOnly(): boolean {
    return (
      (this.documentAccess?.readOnly ?? false)
      || !this._activationEditable
      || this._activationPhase === 'conflict'
      || (
        this._activationDurability === 'failed'
        && this._activationPhase !== 'live'
      )
    )
  }

  private _observeProviderReadiness(
    provider: NonNullable<EditorHostState['provider']> | null,
  ): void {
    if (this._readinessProvider === provider) return
    this._providerLifecycleUnsub?.()
    this._providerLifecycleUnsub = null
    this._providerActivationUnsub?.()
    this._providerActivationUnsub = null
    this._readinessProvider = provider
    if (!provider) {
      this._activationSynced = true
      this._activationEditable = true
      this._activationPhase = 'live'
      this._activationDurability = 'durable'
      this._activationConflict = null
      this._activationRenderSource = 'pending'
      this._requestedEditable = true
      this._syncDocumentAccess()
      return
    }
    this._activationSynced = provider.lifecycle.get().synchronized
    this._activationEditable = this._activationSynced
    this._activationPhase = provider.activation?.get().phase
      ?? (this._activationSynced ? 'live' : 'loading')
    this._activationDurability = provider.activation?.get().durability
      ?? (this._activationSynced ? 'durable' : 'none')
    this._activationConflict = provider.activation?.get().conflict ?? null
    this._activationRenderSource = 'pending'
    this._requestedEditable = true
    this._providerLifecycleUnsub = provider.lifecycle.subscribe(lifecycle => {
      // Initial sync unlocks this provider permanently. A later reconnect is a
      // live continuity event, not a return to cached-activation semantics.
      if (lifecycle.synchronized && !this._activationSynced) {
        this._activationSynced = true
        if (!provider.activation) this._activationPhase = 'live'
        this._syncDocumentAccess()
      }
    })
    this._providerActivationUnsub = provider.activation?.subscribe(activation => {
      if (this._readinessProvider !== provider) return
      this._activationPhase = activation.phase
      this._activationDurability = activation.durability
      const wasDeleted = this._activationConflict === 'deleted'
      this._activationConflict = activation.conflict
      if (activation.phase === 'conflict') this._activationEditable = false
      if (activation.conflict === 'deleted' && !wasDeleted) this._announceDocumentDeleted()
      this._syncDocumentAccess()
      this.requestUpdate()
    }) ?? null
    void provider.whenEditable.then(() => {
      if (
        this._readinessProvider !== provider
        || this._activationPhase === 'conflict'
      ) return
      this._activationEditable = true
      this._syncDocumentAccess()
      this.requestUpdate()
    })
    void provider.whenSynced.then(() => {
      if (this._readinessProvider !== provider || this._activationSynced) return
      this._activationSynced = true
      if (!provider.activation) this._activationPhase = 'live'
      this._syncDocumentAccess()
      this.requestUpdate()
    })
    void provider.renderSource.then(source => {
      if (this._readinessProvider !== provider) return
      this._activationRenderSource = source
      this._syncDocumentAccess()
    })
    this._syncDocumentAccess()
  }

  /**
   * hostState is not a reactive property, but the template reads its graph
   * and document ids (the importance view's scoring panel), so a new one
   * re-renders.
   */
  private _setHostState(next: EditorHostState): void {
    const moved = next.documentId !== this.hostState?.documentId || next.graphId !== this.hostState?.graphId
    this.hostState = next
    if (moved) this.requestUpdate()
  }

  /** (Re)subscribe to the current binding; seed hostState from get(). */
  private _subscribe(): void {
    this._unsub?.()
    this._unsub = null
    const b = this.binding
    if (!b) {
      this._observeProviderReadiness(null)
      this.hostState = null
      return
    }
    const seed = b.get()
    this._observeProviderReadiness(seed.provider)
    this._setHostState(seed)
    this._unsub = b.subscribe((v) => {
      this._observeProviderReadiness(v.provider)
      this._setHostState(v)
    })
  }

  /**
   * Measure the anchor + `.main` and write the four float vars onto :host.
   * R-FIXED-CB: writes ONLY --editor-x/y/w/h. happy-dom returns zero rects, so
   * this is a no-op there (pixel positioning is browser-mode territory).
   */
  private _position(): void {
    if (this.layoutMode === 'contained') return
    const main = this.closest('.main') as HTMLElement | null
    const doc = this.ownerDocument
    const anchor = doc ? doc.getElementById(ANCHOR_ID) : null
    if (!main || !anchor) return
    const vars = computeHostVars(anchor.getBoundingClientRect(), main.getBoundingClientRect())
    this.style.setProperty('--editor-x', vars['--editor-x'])
    this.style.setProperty('--editor-y', vars['--editor-y'])
    this.style.setProperty('--editor-w', vars['--editor-w'])
    this.style.setProperty('--editor-h', vars['--editor-h'])
  }

  /**
   * Reconcile the imperative live editor against the current binding state, run
   * AFTER render() has stamped (or removed) the mount target.
   *
   *   - want a live body, none yet              → mount on the provider's doc;
   *   - want a live body, provider CHANGED      → destroy old, mount on new doc;
   *   - want a live body, same provider         → keep (the whole point: the live
   *                                               EditorView survives re-renders);
   *   - do NOT want a live body but one exists  → destroy (back to placeholder).
   *
   * The history-ownership handoff is sealed inside createLiveCollabEditor: the
   * kernel roster is collaborative (undoRedo dropped), while one room authority
   * records undo across every EditorView attachment.
   *
   * REQUIRED SHELL INVARIANT (the undo-survival contract — load-bearing, tested by
   * sh-editor-host-collab-body.test.ts's second-order mount-once + negative guard):
   * the live EditorView (and therefore its lease on room history)
   * survives a branch/app switch ONLY while the shell keeps BOTH conjuncts true
   * across the re-render: (1) it re-emits the SAME ProviderHandle object (identity,
   * not an equal-but-fresh copy — provider identity IS the survival anchor; an
   * accidentally re-created handle forces a rebuild and DROPS history), AND (2) it
   * holds centerMode==='document' with provider non-null. Flip either and
   * _wantsLiveBody goes false → _teardownEditor() → editor.destroy() → undo history
   * is lost. The host trusts this contract (identity compare, no defensive
   * cache-by-room-key) — exactly where garden put the keying responsibility, minus
   * the store coupling. The shell OWNS provider.destroy(); the host destroys only
   * its Editor.
   */
  private _reconcileEditor(): void {
    const s = this.hostState
    if (!this._wantsLiveBody) {
      // The render is about to swap `.editor-mount` out for the placeholder tree
      // entirely (render() branches on _wantsLiveBody) — no future mount will
      // ever paint over a ghost here, so drop it now rather than leave an
      // orphaned reference to a node Lit is about to detach anyway.
      this._removeEditorGhost()
      this._teardownEditor()
      return
    }
    const provider = s!.provider!
    // A DIFFERENT (or first) provider → drop any old editor and CLAIM this one
    // synchronously, then kick the sync-gated mount. Claiming up front means a
    // re-entrant update for the SAME provider falls through to the retry path
    // below instead of double-mounting across the async sync gate.
    if (this._editorProvider !== provider) {
      // FROZEN-GHOST CROSSFADE: snapshot the outgoing editor's rendered pixels
      // BEFORE teardown destroys its DOM, so `.editor-mount` is never visually
      // empty during the whenRenderable-gated gap below. Pure pixels — no editor,
      // no provider, no listeners; see `_editorGhost`'s doc comment.
      this._freezeEditorGhost()
      this._teardownEditor()
      this._editorProvider = provider
      // A proven cached update can paint before the room handshake. Editing is
      // independently gated by initial whenSynced testimony above.
      void provider.whenRenderable.then(() => this._mountClaimed(provider))
      return
    }
    // SAME provider already claimed. If the mount target appeared only on this
    // render (e.g. status idle→ready stamped .editor-mount after the claim) and
    // sync had already resolved, mount now. Idempotent: _mountClaimed no-ops if an
    // editor already exists or the target is still absent.
    if (!this._editor) void provider.whenRenderable.then(() => this._mountClaimed(provider))
  }

  /**
   * Mount the live editor for an already-CLAIMED provider, if the claim still
   * holds and the mount target is present. Idempotent + provider-guarded so the
   * sync-gate microtask cannot mount onto a stale/closed room.
   */
  private _mountClaimed(provider: NonNullable<EditorHostState['provider']>): void {
    if (this._editorProvider !== provider) return // claim revoked (swapped/closed/disconnected)
    if (this._editor) return // already mounted
    const el = this.renderRoot?.querySelector('.editor-mount') as HTMLElement | null
    if (!el) return // target not stamped yet; a later update retries
    // Forward the opaque kernel-options (the assembled wikilink callbacks) into the
    // kernel slot. `collaborative` is forced ON inside createLiveCollabEditor — it is
    // structurally absent from EditorKernelOptions, so room history stays the sole
    // recording authority. null kernelOptions ⇒ undefined slot (a bare collab editor,
    // the rung-3 shape).
    // The real Editor IS structurally a RawLiveEditor (getText/destroy + commands.
    // insertWikiLink). Holding it raw keeps the existing `(host as { _editor }).commands`
    // probes valid; the public narrow handle is projected by the `liveEditor` getter.
    let editor: RawLiveEditor
    const editable = !this._effectiveReadOnly()
    try {
      editor = createLiveCollabEditor({
        element: el,
        doc: provider.doc,
        awareness: provider.awareness,
        kernel: {
          ...(this.kernelOptions ?? {}),
          onBlockControlAction: (blockId: string, action: string) => this._onImportanceControl(blockId, action),
        },
        editable,
      }) as unknown as RawLiveEditor
    } catch (error) {
      // A failed mount must never leave a frozen ghost stranded over a dead
      // mount target — no future success will arrive to clear it.
      this._removeEditorGhost()
      throw error
    }
    this._editor = editor
    this._editorEditable = editable
    this._syncDocumentAccess()
    const onGutterMouseDown = (event: MouseEvent): void => this._onEditorGutterMouseDown(event)
    const onWireClick = (event: MouseEvent): void => this._onEditorWireClick(event)
    const onTextClick = (event: MouseEvent): void => this._onEditorTextClick(event)
    const onWireMouseMove = (event: MouseEvent): void => this._onEditorWireMouseMove(event)
    const onWireMouseOver = (event: MouseEvent): void => this._onEditorWireMouseMove(event)
    const onSalienceMouseMove = (event: MouseEvent): void => this._onEditorSalienceMouseMove(event)
    const onSalienceMouseOver = (event: MouseEvent): void => this._onEditorSalienceMouseMove(event)
    const onEditorMouseLeave = (): void => this._onEditorMouseLeave()
    const onImageMouseOver = (event: MouseEvent): void => this._onImageMouseOver(event)
    const onImageMouseOut = (event: MouseEvent): void => this._onImageMouseOut(event)
    const onCommentMouseOver = (event: MouseEvent): void => this._onCommentMouseOver(event)
    const onCommentMouseOut = (event: MouseEvent): void => this._onCommentMouseOut(event)
    const onCommentClick = (event: MouseEvent): void => this._onCommentClick(event, 'click')
    const onCommentMouseDown = (event: MouseEvent): void => {
      this._commentMouseDownAt = { x: event.clientX, y: event.clientY }
    }
    const onCommentDblClick = (event: MouseEvent): void => this._onCommentClick(event, 'dblclick')
    el.addEventListener('mouseover', onCommentMouseOver)
    el.addEventListener('mouseout', onCommentMouseOut)
    el.addEventListener('click', onCommentClick)
    el.addEventListener('mousedown', onCommentMouseDown)
    el.addEventListener('dblclick', onCommentDblClick)
    el.addEventListener('mousedown', onGutterMouseDown)
    el.addEventListener('click', onWireClick)
    el.addEventListener('click', onTextClick)
    el.addEventListener('mousemove', onWireMouseMove)
    el.addEventListener('mouseover', onWireMouseOver)
    el.addEventListener('mousemove', onSalienceMouseMove)
    el.addEventListener('mouseover', onSalienceMouseOver)
    el.addEventListener('mouseleave', onEditorMouseLeave)
    el.addEventListener('mouseover', onImageMouseOver)
    el.addEventListener('mouseout', onImageMouseOut)
    this._wireClickUnsub = () => {
      el.removeEventListener('mousedown', onGutterMouseDown)
      el.removeEventListener('click', onWireClick)
      el.removeEventListener('click', onTextClick)
      el.removeEventListener('mousemove', onWireMouseMove)
      el.removeEventListener('mouseover', onWireMouseOver)
      el.removeEventListener('mousemove', onSalienceMouseMove)
      el.removeEventListener('mouseover', onSalienceMouseOver)
      el.removeEventListener('mouseleave', onEditorMouseLeave)
      el.removeEventListener('mouseover', onImageMouseOver)
      el.removeEventListener('mouseout', onImageMouseOut)
      el.removeEventListener('mouseover', onCommentMouseOver)
      el.removeEventListener('mouseout', onCommentMouseOut)
      el.removeEventListener('click', onCommentClick)
      el.removeEventListener('mousedown', onCommentMouseDown)
      el.removeEventListener('dblclick', onCommentDblClick)
    }
    const onTransaction = (): void => {
      this._syncZoomSnapshot()
      this._syncSearchState()
      this._syncFormatState()
      this._syncWireIndicators()
      this._syncWireHighlight()
      this._syncHeadingObserver()
      this._emitStructureChange('transaction')
    }
    const onSelectionUpdate = (): void => {
      this._emitStructureChange('selection')
    }
    // Only a content change can move the importance view's sources; the
    // controls' own meta transaction must not schedule another sync.
    const onImportanceTransaction = (props?: { transaction?: { docChanged?: boolean } }): void => {
      if (props?.transaction?.docChanged) queueMicrotask(() => this._syncImportanceView())
    }
    editor.on('transaction', onTransaction)
    editor.on('transaction', onImportanceTransaction)
    editor.on('selectionUpdate', onSelectionUpdate)
    editor.on('focus', onSelectionUpdate)
    this._zoomUnsub = () => {
      editor.off('transaction', onImportanceTransaction)
      editor.off('transaction', onTransaction)
      editor.off('selectionUpdate', onSelectionUpdate)
      editor.off('focus', onSelectionUpdate)
    }
    // Build the public handle ONCE, held by stable reference (identity = the EditorView's
    // lifetime). getText()/destroy() pass straight through; insertWikiLink delegates to
    // the kernel's REAL commands.insertWikiLink (the public insert path the glue uses).
    this._editorHandle = {
      getText: () => editor.getText(),
      getJSON: (): LiveDocumentJSON => editor.getJSON(),
      getActiveBlockId: (): string | null => this._activeBlockId(),
      getOverlayAnchorRect: (): EditorOverlayAnchorRect | null => this._overlayAnchorRect(),
      restoreHtml: (html: string): boolean => {
        editor.commands.focus()
        return editor.commands.setContent(html)
      },
      insertWikiLink: (attrs: LiveWikiLinkAttrs): boolean =>
        editor.commands.insertWikiLink(attrs),
      insertCitation: (attrs: LiveCitationAttrs): boolean =>
        editor.commands.insertCitation(attrs),
      insertWikiLinkAt: (
        range: { from: number; to: number },
        attrs: LiveWikiLinkAttrs,
      ): boolean => this._insertWikiLinkAt(range, attrs),
      insertZoteroPromotion: (promotion: LiveZoteroPromotion): LiveZoteroPromotionResult =>
        this._insertZoteroPromotion(promotion),
      insertTagChipAt: (
        range: { from: number; to: number },
        attrs: LiveTagChipAttrs,
      ): boolean => this._insertTagChipAt(range, attrs),
      insertTagTextAt: (range: { from: number; to: number }, name: string): boolean =>
        this._insertTagTextAt(range, name),
      runSlashCommandAt: (
        range: { from: number; to: number },
        commandId: LiveSlashCommandId,
      ): Promise<boolean> => this._runSlashCommandAt(range, commandId),
      setActiveComment: (commentId: string | null, options?: { readonly scroll?: boolean }): boolean =>
        this._setActiveComment(commentId, options),
      removeComment: (commentId: string): boolean => this._removeComment(commentId),
      getZoomSnapshot: () => liveZoomSnapshot(editor as never),
      zoomIntoBlock: (blockId: string): boolean => editor.commands.zoomIntoBlock(blockId),
      startBlockMove: (blockId: string): boolean => {
        // The kernel's BlockMove extension binds its entry points into
        // storage; this host does not import the kernel (island guard).
        const storage = (editor as unknown as { storage?: Record<string, { start?: (id: string) => boolean } | undefined> }).storage
        return storage?.blockMove?.start?.(blockId) ?? false
      },
      zoomToAncestor: (blockId: string): boolean => editor.commands.zoomToAncestor(blockId),
      zoomOut: (): boolean => editor.commands.zoomOut(),
      setEditable: (editable: boolean): void => {
        this._requestedEditable = editable
        this._syncDocumentAccess()
      },
      getBlockElement: (blockId: string): HTMLElement | null => this._blockElement(blockId),
      getOrderedBlockElements: (): HTMLElement[] => this._orderedBlockElements(),
      focusBlock: (blockId: string): boolean => this._focusEditorBlock(blockId),
      getHeadings: (): LiveHeadingOutlineEntry[] => liveHeadingOutline(editor as never),
      getCurrentHeadingId: (): string | null => this._currentHeadingId,
      runOutlinerCommand: (command: LiveOutlinerCommand): void => this._runOutlinerCommand(command),
      destroy: () => editor.destroy(),
    }
    this._applyInitialZoom()
    this._syncZoomSnapshot()
    this._syncFormatState()
    this._syncWireIndicators()
    this._syncValueMarks()
    this._syncMarginGloss()
    this._syncWireHighlight()
    this._syncActiveComment()
    this._syncImportanceView()
    this._applyFocusRequest()
    this._syncHeadingObserver()
    queueMicrotask(() => this._emitStructureChange('mounted'))
    // The new editor is stamped into the DOM; drop the frozen ghost once it has
    // actually painted (see _scheduleGhostRemoval) rather than the instant it
    // mounts, so the crossfade never reveals an unpainted frame underneath.
    this._scheduleGhostRemoval()
  }

  /**
   * FROZEN-GHOST CROSSFADE (CONTINUITY PART ONE) — snapshot the currently-live
   * editor's rendered DOM as an inert overlay covering `.editor-mount`, so a
   * DIFFERENT-provider switch (see `_reconcileEditor`) never exposes an empty
   * mount region during the `whenRenderable`-gated remount gap. Pure pixels: a
   * `cloneNode(true)` of the outgoing content, NOT the live editor/provider —
   * it cannot affect collab or undo.
   *
   * A no-op when there is nothing live to snapshot (`_editor` is null — e.g. a
   * rapid A→B→C switch fires again before B ever mounted): in that case any
   * PRIOR ghost is left exactly as-is, still covering the box, rather than
   * being removed with nothing to replace it. Replacing only happens when
   * there is genuinely fresher content to freeze, which is also the one moment
   * a stale prior ghost is dropped (the rapid-switch no-stacking guarantee).
   */
  private _freezeEditorGhost(): void {
    if (!this._editor) return
    const el = this.renderRoot?.querySelector('.editor-mount') as HTMLElement | null
    if (!el) return
    const liveChildren = Array.from(el.children).filter(
      (child) => !child.hasAttribute('data-sh-editor-ghost'),
    )
    if (liveChildren.length === 0) return // nothing rendered yet to freeze
    const overlay = this.ownerDocument.createElement('div')
    overlay.setAttribute('data-sh-editor-ghost', '')
    overlay.setAttribute('aria-hidden', 'true')
    overlay.toggleAttribute('inert', true)
    overlay.style.position = 'absolute'
    overlay.style.inset = '0'
    overlay.style.overflow = 'auto'
    overlay.style.zIndex = '1'
    overlay.style.pointerEvents = 'none'
    overlay.style.userSelect = 'none'
    for (const child of liveChildren) overlay.appendChild(child.cloneNode(true))
    overlay.scrollTop = el.scrollTop
    overlay.scrollLeft = el.scrollLeft
    // Only now drop any earlier ghost — the fresh one is ready to take its
    // place immediately, so the box is never uncovered even for a frame.
    this._removeEditorGhost()
    el.appendChild(overlay)
    this._editorGhost = overlay
    // Self-expire if no mount ever removes it (see the field's doc comment).
    // Captured `overlay` is compared by identity so a fresher ghost is untouched.
    this._ghostTimeout = setTimeout(() => {
      if (this._editorGhost === overlay) this._removeEditorGhost()
    }, ShEditorHost.GHOST_MAX_LIFETIME_MS)
  }

  /**
   * Remove the ghost overlay, if any. Safe and idempotent on every exit path —
   * this is the guarantee that no permanent frozen overlay can survive: called
   * from `_reconcileEditor`'s `!_wantsLiveBody` branch, `disconnectedCallback`,
   * a failed mount in `_mountClaimed`, and (via `_scheduleGhostRemoval`) a
   * successful one.
   */
  private _removeEditorGhost(): void {
    if (this._ghostTimeout !== null) {
      clearTimeout(this._ghostTimeout)
      this._ghostTimeout = null
    }
    this._editorGhost?.remove()
    this._editorGhost = null
  }

  /**
   * Drop the frozen ghost one paint after the new editor has mounted, so the
   * crossfade never reveals an unpainted frame underneath it. Captures the
   * exact overlay reference at schedule time and only removes THAT node —
   * if a newer switch has since replaced or cleared `_editorGhost`, this is a
   * no-op (never clobbers a fresher ghost or an already-clean state).
   */
  private _scheduleGhostRemoval(): void {
    const ghost = this._editorGhost
    if (!ghost) return
    const raf: (cb: FrameRequestCallback) => void =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => setTimeout(() => cb(Date.now()), 0)
    raf(() => {
      if (this._editorGhost === ghost) this._removeEditorGhost()
    })
  }

  private _emitStructureChange(reason: EditorStructureChangeDetail['reason']): void {
    this.dispatchEvent(new CustomEvent<EditorStructureChangeDetail>(EDITOR_STRUCTURE_CHANGE_EVENT, {
      bubbles: true,
      composed: true,
      detail: { reason, activeBlockId: this._activeBlockId() },
    }))
    // Same triggers, different channel: this event carries NO content by design
    // (`{reason, activeBlockId}`), so W14.1's subscribers are armed here and
    // read the document themselves when their window fires.
    this._scheduleContentNotify(reason)
  }

  private _emitHeadingInViewChange(): void {
    this.dispatchEvent(new CustomEvent<EditorHeadingInViewDetail>(EDITOR_HEADING_IN_VIEW_EVENT, {
      bubbles: true,
      composed: true,
      detail: { blockId: this._currentHeadingId },
    }))
  }

  /**
   * (Re)builds the IntersectionObserver tracking which heading owns the
   * current scroll position, rooted at `.editor-mount` (the actual scroll
   * container — see its CSS `overflow: auto`). Cheap no-op when the observed
   * heading id set hasn't changed since last call (typing inside a heading
   * fires a transaction but doesn't add/remove headings).
   */
  private _syncHeadingObserver(): void {
    const editor = this._editor
    const mount = this.renderRoot?.querySelector('.editor-mount') as HTMLElement | null
    if (!editor || !mount) {
      this._teardownHeadingObserver()
      return
    }
    const ids = liveHeadingOutline(editor as never).map((h) => h.id)
    const unchanged = ids.length === this._headingObservedIds.length
      && ids.every((id, i) => id === this._headingObservedIds[i])
    if (unchanged) return

    this._headingObserver?.disconnect()
    this._headingIntersecting.clear()
    this._headingObservedIds = ids
    if (ids.length === 0) {
      this._headingObserver = null
      this._setCurrentHeadingId(null)
      return
    }
    // Shrink the root's effective bottom edge so a heading only counts as
    // "in view" once it's within the top band — standard scroll-spy behavior,
    // matching how a table of contents is expected to track reading position.
    const observer = new IntersectionObserver(
      (entries) => this._onHeadingIntersection(entries),
      { root: mount, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    )
    for (const id of ids) {
      const el = this._blockElement(id)
      if (el) observer.observe(el)
    }
    this._headingObserver = observer
    this._recomputeCurrentHeadingId()
  }

  private _onHeadingIntersection(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).getAttribute('data-block-id')
      if (id) this._headingIntersecting.set(id, entry.isIntersecting)
    }
    this._recomputeCurrentHeadingId()
  }

  /**
   * The last (lowest, most-recently-scrolled-past) intersecting heading in
   * document order. Starts from the current id rather than null so scrolling
   * past the last heading (nothing left intersecting the tracking band)
   * keeps that heading highlighted instead of dropping the highlight.
   */
  private _recomputeCurrentHeadingId(): void {
    let candidate: string | null = this._currentHeadingId
    for (const id of this._headingObservedIds) {
      if (this._headingIntersecting.get(id)) candidate = id
    }
    if (candidate !== null && !this._headingObservedIds.includes(candidate)) candidate = null
    this._setCurrentHeadingId(candidate)
  }

  private _setCurrentHeadingId(blockId: string | null): void {
    if (blockId === this._currentHeadingId) return
    this._currentHeadingId = blockId
    this._emitHeadingInViewChange()
  }

  private _teardownHeadingObserver(): void {
    this._headingObserver?.disconnect()
    this._headingObserver = null
    this._headingObservedIds = []
    this._headingIntersecting.clear()
    this._setCurrentHeadingId(null)
  }

  private _orderedBlockElements(): HTMLElement[] {
    const mount = this.renderRoot?.querySelector('.editor-mount') as HTMLElement | null
    if (!mount) return []
    return Array.from(mount.querySelectorAll<HTMLElement>('.ProseMirror [data-block-id]'))
  }

  private _blockElement(blockId: string): HTMLElement | null {
    const normalized = blockId.trim()
    if (!normalized) return null
    const candidates = new Set<string>([normalized])
    if (normalized.startsWith('block-')) {
      const short = normalized.slice('block-'.length)
      if (short) candidates.add(short)
    } else {
      candidates.add(`block-${normalized}`)
    }
    return this._orderedBlockElements().find((block) => {
      const candidate = block.getAttribute('data-block-id')
      return candidate !== null && candidates.has(candidate)
    }) ?? null
  }

  private _focusEditorBlock(blockId: string): boolean {
    const editor = this._editor
    const candidates = new Set(this._blockIdCandidates(blockId))
    const doc = editor?.state.doc
    if (!editor || !doc || candidates.size === 0) return false
    let selectionPosition: number | null = null
    doc.descendants((node, pos) => {
      const id = node.attrs?.['data-block-id']
      if (typeof id !== 'string' || !candidates.has(id)) return true
      selectionPosition = pos + 1
      return false
    })
    if (selectionPosition === null) return false
    editor.commands.setTextSelection(selectionPosition)
    editor.commands.focus()
    this._blockElement(blockId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // An arrival: the caller navigated us here, so it gets the pulse.
    this._setWireHighlight(blockId, 'arrival')
    return true
  }

  private _activeBlockId(): string | null {
    const editor = this._editor
    if (!editor) return null
    const sel = editor.state.selection
    const { $from } = sel
    for (let depth = $from.depth; depth >= 0; depth--) {
      const node = $from.node(depth)
      const id = node.attrs?.['data-block-id']
      if (typeof id === 'string' && id.length > 0) return id
    }
    if ('node' in sel) {
      const node = (sel as { node?: { attrs?: Record<string, unknown> } }).node
      const id = node?.attrs?.['data-block-id']
      if (typeof id === 'string' && id.length > 0) return id
    }
    return null
  }

  /**
   * Project ProseMirror's private selection geometry into one stable shell
   * contract. `coordsAtPos` is authoritative; the rendered active block and
   * editor root are deliberate fallbacks for node selections and synthetic DOMs.
   */
  private _overlayAnchorRect(): EditorOverlayAnchorRect | null {
    const editor = this._editor
    const view = editor?.view
    if (!editor || !view) return null

    const usable = (
      rect: EditorOverlayAnchorRect | null | undefined,
    ): EditorOverlayAnchorRect | null => {
      if (!rect) return null
      const values = [rect.left, rect.right, rect.top, rect.bottom]
      if (!values.every(Number.isFinite) || values.every(value => value === 0)) return null
      return {
        left: Math.min(rect.left, rect.right),
        right: Math.max(rect.left, rect.right),
        top: Math.min(rect.top, rect.bottom),
        bottom: Math.max(rect.top, rect.bottom),
      }
    }

    const position = editor.state.selection.from
    if (typeof position === 'number' && view.coordsAtPos) {
      try {
        const caret = usable(view.coordsAtPos(position))
        if (caret) return caret
      } catch {
        // A transient unmapped position during CRDT reconciliation falls
        // through to the stable rendered-block geometry below.
      }
    }

    const activeBlockId = this._activeBlockId()
    const block = activeBlockId ? this._blockElement(activeBlockId) : null
    const blockRect = usable(block?.getBoundingClientRect())
    if (blockRect) {
      const inset = Math.min(24, Math.max(8, (blockRect.right - blockRect.left) * 0.08))
      const x = Math.min(blockRect.right, blockRect.left + inset)
      return { left: x, right: x, top: blockRect.top, bottom: blockRect.bottom }
    }

    const editorRect = usable(view.dom.getBoundingClientRect())
    if (!editorRect) return null
    const x = Math.min(editorRect.right, editorRect.left + 24)
    const y = Math.min(editorRect.bottom, editorRect.top + 24)
    return { left: x, right: x, top: y, bottom: y }
  }

  private _insertZoteroPromotion(promotion: LiveZoteroPromotion): LiveZoteroPromotionResult {
    const editor = this._editor
    const artifactId = promotion.artifactId.trim()
    const zoteroKey = promotion.zoteroKey.trim()
    if (!editor || !artifactId || !zoteroKey) return { applied: false, blockId: null }

    const text = promotion.text.trim()
    const comment = promotion.comment?.trim() ?? ''
    const quote = comment ? `${text} \u2014 ${comment}` : text
    const content = quote ? [{ type: 'text', text: quote }] : []

    const applied = editor
      .chain()
      .focus('end')
      .insertContent({ type: 'paragraph', content })
      .insertCitation({
        artifactId,
        zoteroKey,
        citation: promotion.citation.trim(),
      })
      .run()

    return { applied, blockId: applied ? this._activeBlockId() : null }
  }

  private _normalizeTagName(value: unknown): string {
    return typeof value === 'string' ? value.trim().replace(/^#/, '').toLowerCase() : ''
  }

  private _insertWikiLinkAt(range: { from: number; to: number }, attrs: LiveWikiLinkAttrs): boolean {
    const editor = this._editor
    // A file link has no target document; its file (by path, or by id when picked
    // by name from the graph's files) stands in for one.
    if (!editor || !(attrs.targetDocId || attrs.filePath || attrs.targetArtifactId) || !attrs.label) return false
    editor.commands.focus()
    return editor.commands.insertContentAt(range, {
      type: 'wikilink',
      attrs: {
        targetDocId: attrs.targetDocId,
        targetBlockId: attrs.targetBlockId ?? null,
        targetGraphId: attrs.targetGraphId ?? null,
        label: attrs.label,
        blockPreview: attrs.blockPreview ?? null,
        wireId: attrs.wireId ?? null,
        targetArtifactId: attrs.targetArtifactId ?? null,
        filePath: attrs.filePath ?? null,
        region: attrs.region ?? null,
      },
    })
  }

  private _blockContextAt(pos: number): { readonly sourceBlockId: string; readonly sourceContent: string } | null {
    const doc = this._editor?.state.doc
    if (!doc) return null
    let context: { sourceBlockId: string; sourceContent: string } | null = null
    doc.descendants((node, nodePos) => {
      if (context) return false
      const nodeSize = typeof node.nodeSize === 'number' ? node.nodeSize : 0
      if (nodeSize <= 0 || pos < nodePos || pos > nodePos + nodeSize) return
      const id = node.attrs?.['data-block-id']
      if (typeof id !== 'string' || id.length === 0) return
      context = {
        sourceBlockId: id,
        sourceContent: (node.textContent ?? '').trim(),
      }
      return false
    })
    return context
  }

  private _notifyScheduledTagCommit(
    range: { from: number; to: number },
    attrs: LiveTagChipAttrs,
  ): void {
    const tag = this._normalizeTagName(attrs.name)
    const absoluteDate = typeof attrs.date === 'string' && attrs.date.trim() ? attrs.date.trim() : null
    if (!tag || !absoluteDate || !SCHEDULED_TAG_NAMES.has(tag)) return
    const context = this._blockContextAt(range.from)
    this.kernelOptions?.onScheduledTag?.({
      tag,
      absoluteDate,
      sourceBlockId: context?.sourceBlockId ?? '',
      sourceContent: context?.sourceContent ?? '',
    })
  }

  private _insertTagChipAt(range: { from: number; to: number }, attrs: LiveTagChipAttrs): boolean {
    const editor = this._editor
    if (!editor) return false
    const name = this._normalizeTagName(attrs.name)
    if (!name) return false
    const date = typeof attrs.date === 'string' && attrs.date.trim() ? attrs.date.trim() : null
    editor.commands.focus()
    const applied = editor.commands.insertContentAt(range, [
      { type: 'tagChip', attrs: { name, date } },
      { type: 'text', text: ' ' },
    ])
    if (applied) this._notifyScheduledTagCommit(range, { name, date })
    return applied
  }

  private _insertTagTextAt(range: { from: number; to: number }, name: string): boolean {
    const editor = this._editor
    const normalized = this._normalizeTagName(name)
    if (!editor || !normalized) return false
    editor.commands.focus()
    return editor.commands.insertContentAt(range, `#${normalized}`)
  }

  private async _runSlashCommandAt(
    range: { from: number; to: number },
    commandId: LiveSlashCommandId,
  ): Promise<boolean> {
    const editor = this._editor
    if (!editor) return false
    editor.commands.focus()
    if (!editor.commands.deleteRange(range)) return false

    let applied = false
    if (commandId === 'heading1') applied = editor.commands.toggleHeading({ level: 1 })
    else if (commandId === 'heading2') applied = editor.commands.toggleHeading({ level: 2 })
    else if (commandId === 'heading3') applied = editor.commands.toggleHeading({ level: 3 })
    else if (commandId === 'bulletList') applied = editor.commands.toggleBulletItem()
    else if (commandId === 'orderedList') applied = editor.commands.toggleOrderedItem()
    else if (commandId === 'taskList') applied = editor.commands.toggleTaskItem()
    else if (commandId === 'blockquote') applied = editor.commands.toggleBlockquote()
    else if (commandId === 'codeBlock') applied = editor.commands.toggleCodeBlock()
    else if (commandId === 'table') applied = editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    else if (commandId === 'horizontalRule') applied = editor.commands.setHorizontalRule()
    else if (commandId === 'image') applied = await this._insertImageFromToolbar()
    else if (commandId === 'queryBlock') applied = editor.commands.insertQueryBlock()
    else if (commandId === 'math') applied = editor.commands.insertBlockMath('')

    if (applied) {
      this._syncFormatState()
      this._syncWireIndicators()
      this._syncValueMarks()
    }
    return applied
  }

  private _applyInitialZoom(): void {
    const editor = this._editor
    if (!editor) return
    const blockId = this.initialZoomBlockId
    if (blockId) {
      editor.commands.zoomIntoBlock(blockId)
    } else if (this.zoomSnapshot.blockId) {
      editor.commands.zoomOut()
    }
    this._syncZoomSnapshot()
  }

  private _syncZoomSnapshot(): void {
    const editor = this._editor
    const next = editor ? liveZoomSnapshot(editor as never) : { blockId: null, breadcrumb: [] }
    const current = this.zoomSnapshot
    const same =
      next.blockId === current.blockId &&
      next.breadcrumb.length === current.breadcrumb.length &&
      next.breadcrumb.every(
        (crumb, index) =>
          crumb.blockId === current.breadcrumb[index]?.blockId &&
          crumb.text === current.breadcrumb[index]?.text,
      )
    if (same) return
    const changed = next.blockId !== current.blockId
    this.zoomSnapshot = next
    this._paintZoomBreadcrumb()
    if (changed) {
      this.dispatchEvent(
        new CustomEvent<ZoomChangeDetail>('mn-zoom-change', {
          bubbles: true,
          composed: true,
          detail: next,
        }),
      )
    }
  }

  /**
   * `null` means the DOCUMENT level: the wires that name no local block, and
   * so belong to the document as a whole. Same call, same shape, one branch —
   * the alternative was a second nearly-identical method, and the two would
   * have drifted the first time the matching rules changed.
   */
  private _wiresForBlock(blockId: string | null): WireSummary[] {
    const bundle = this.wireBundle
    if (!bundle) return []
    // The document-level rule lives with the bundle, because the pane header
    // draws its bubble from the same rule and the two must not drift.
    if (blockId === null) return [...documentLevelWires(bundle)]
    const candidates = new Set(this._blockIdCandidates(blockId))
    return [...bundle.outgoingWires, ...bundle.incomingWires].filter(
      (wire) => !!wire.localBlockId && candidates.has(wire.localBlockId),
    )
  }

  /** What the pane header's status-dot bubble counts. */
  private _documentWireCount(): number {
    return documentLevelWires(this.wireBundle).length
  }

  /**
   * DRIVES THE PLUGIN; DOES NOT TOUCH THE DOM — same move, and the same
   * reason, as _syncWireHighlight below.
   *
   * This used to walk the mount and `toggleAttribute('data-block-wired', …)`
   * on each block. Those elements belong to ProseMirror, which replaces them on
   * redraw, so the bubbles went dark and stayed dark: measured in the running
   * app, a document whose bundle named a wired block still reported
   * `blocksMarkedWired: []`. The indicator and the highlight were never two
   * bugs; they were one mechanism failing twice.
   *
   * Hover is still handled by the container-level mousemove/mouseover/
   * mouseleave bindings set up once at mount, NOT per block — moving the
   * pointer from wired block A straight to wired block B fires mouseleave on A
   * alone (it does not bubble), and a per-block close timer for A had no way to
   * know B had since opened its own overlay, so it fired ~450ms later and shut
   * the overlay B was still under. That reasoning is unchanged by this port;
   * only the attribute writing moved.
   */
  private _syncWireIndicators(): void {
    if (!this._editor) return
    const bundle = this.wireBundle
    const wired = new Map<string, number>()
    for (const blockId of bundle?.wiredBlockIds ?? []) {
      if (blockId) wired.set(blockId, Math.max(1, this._wiresForBlock(blockId).length))
    }
    // A wire whose local block is not in `wiredBlockIds` still wears a bubble —
    // the old DOM walk took the union of the two, and dropping that here would
    // be a silent behaviour change hiding inside a mechanical port.
    for (const wire of [...(bundle?.outgoingWires ?? []), ...(bundle?.incomingWires ?? [])]) {
      const blockId = wire.localBlockId
      if (!blockId || wired.has(blockId)) continue
      wired.set(blockId, Math.max(1, this._wiresForBlock(blockId).length))
    }
    setLiveWiredBlocks(
      this._editor,
      [...wired].map(([blockId, count]) => ({ blockId, count })),
    )
  }

  /**
   * DRIVES THE PLUGIN (value-marks.ts): each scored block's signal bars, plus
   * the reader's own flag and valence where set. Blocks without a score get the
   * empty signal, so they can still be valued.
   */
  private _syncValueMarks(): void {
    if (!this._editor) return
    // The importance view values the SOURCE blocks with its own controls
    // (block-controls); a row here would rate the projection's copies.
    if (this.hostState?.documentId === IMPORTANCE_VIEW_DOCUMENT_ID) {
      setLiveValueMarks(this._editor, new Map(), '')
      return
    }
    const marks = new Map<string, LiveValueMark>()
    for (const [blockId, score] of this.salienceBundle?.scores ?? []) {
      const level = signalIcon(score)
      const imp = score.userImportance ?? null
      const val = score.userValence ?? null
      marks.set(blockId, {
        signalSvg: salienceIconSvg(level),
        ...(hasUserImportance(score)
          ? { flagCount: imp === 5 ? 2 as const : 1 as const, flagSvg: salienceIconSvg(importanceIcon(score)) }
          : {}),
        ...(val === 4 || val === -4 ? { valenceSvg: salienceIconSvg(valenceIcon(score)) } : {}),
        label: `Composite ${score.compositeScore.toFixed(2)} · Your rating: ${importanceLabel(score)} · ${valenceLabel(score)}`,
      })
    }
    setLiveValueMarks(this._editor, marks, salienceIconSvg('signal-zero'))
  }

  /** Ratings sent but not yet in the salience bundle, by block id. */
  private _pendingRatings = new Map<string, { importance: number | null, valence: number | null }>()

  private _syncMarginGloss(): void {
    const editor = this._editor
    if (!editor) return
    const bundle = this.wireBundle
    editor.commands.updateMarginGloss(
      bundle?.outgoingWires ?? [],
      bundle?.incomingWires ?? [],
    )
  }

  private _clearWireOverlayHoverTimer(): void {
    if (!this._wireOverlayHoverTimer) return
    clearTimeout(this._wireOverlayHoverTimer)
    this._wireOverlayHoverTimer = null
  }

  private _clearWireOverlayCloseTimer(): void {
    if (!this._wireOverlayCloseTimer) return
    clearTimeout(this._wireOverlayCloseTimer)
    this._wireOverlayCloseTimer = null
  }

  private _clearWireOverlayTimers(): void {
    this._clearWireOverlayHoverTimer()
    this._clearWireOverlayCloseTimer()
  }

  private _startWireOverlayCloseTimer(delayMs = 450): void {
    if (!this.wireOverlayOpen || this._wireOverlayCloseTimer) return
    this._wireOverlayCloseTimer = setTimeout(() => {
      this._wireOverlayCloseTimer = null
      this._closeWireOverlay()
    }, delayMs)
  }

  private _openWireOverlay(blockId: string | null, x: number, y: number): void {
    this.wireOverlayBlockId = blockId
    this.wireOverlayAnchor = { x, y }
    this.wireOverlayOpen = true
  }

  private _closeWireOverlay(): void {
    this._clearWireOverlayTimers()
    this.wireOverlayOpen = false
    this.wireOverlayBlockId = null
  }

  private _handleWireOverlayMouseEnter(): void {
    this._clearWireOverlayCloseTimer()
  }

  private _handleWireOverlayMouseLeave(): void {
    this._startWireOverlayCloseTimer(450)
  }

  private _onEditorWireMouseMove(event: MouseEvent): void {
    const hit = this._gutterHitForEvent(event)
    if (!hit || hit.zone !== 'wire') {
      this._clearWireOverlayHoverTimer()
      this._startWireOverlayCloseTimer()
      return
    }
    const blockId = hit.block.getAttribute('data-block-id')
    if (!blockId || this._wiresForBlock(blockId).length === 0) {
      this._clearWireOverlayHoverTimer()
      this._startWireOverlayCloseTimer()
      return
    }
    if (this.wireOverlayOpen && this.wireOverlayBlockId === blockId) {
      this._clearWireOverlayCloseTimer()
      return
    }
    if (this._wireOverlayHoverTimer) return
    const { clientX, clientY } = event
    this._wireOverlayHoverTimer = setTimeout(() => {
      this._wireOverlayHoverTimer = null
      this._openWireOverlay(blockId, clientX, clientY)
    }, 160)
  }

  /**
   * Open the DOCUMENT-level wire fan, from outside this element.
   *
   * The bubble that triggers it is the pane header's status dot, which this
   * element does not own and is not inside: in production the header is drawn
   * by `render-workspace.ts` into the light DOM beside this host, and in the
   * `sh-center-panes` specimen it is in that element's shadow root. Either way
   * the trigger is outside and the fan is inside. The overlay is
   * `position: fixed` in viewport coordinates, so it draws correctly wherever
   * the caller is; only the decision to open it has to cross the boundary, and
   * a method is the honest shape for that. Returns whether a fan actually
   * opened, so a caller can distinguish an empty document from a shown one.
   *
   * No 160ms hover delay here, unlike the block path. That delay exists because
   * the block gutter is a strip the pointer crosses constantly on its way to
   * the text, so opening instantly would flicker a fan at every passing block.
   * The status dot is a thing you aim at; arriving on it is already the intent,
   * and waiting there reads as lag.
   */
  openDocumentWireFan(x: number, y: number): boolean {
    this._clearWireOverlayCloseTimer()
    if (this._documentWireCount() === 0) return false
    this._openWireOverlay(null, x, y)
    return true
  }

  /**
   * The same 450ms grace the block bubbles use, and for the same reason: the
   * pointer has to travel from the dot to the fan, and the gap between them is
   * not a decision to close.
   */
  /**
   * Ask for the document bubble menu, from the pane header's dot. Like
   * openDocumentWireFan, the trigger is outside this element and the request
   * leaves from inside it, so the menu's pin action can reach the shell.
   */
  requestDocumentBubbleMenu(x: number, y: number): void {
    this._closeWireOverlay()
    this.dispatchEvent(
      new CustomEvent<DocumentBubbleRequestDetail>(DOCUMENT_BUBBLE_REQUEST_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          graphId: this.hostState?.graphId ?? null,
          documentId: this.hostState?.documentId ?? null,
          clientX: x,
          clientY: y,
        },
      }),
    )
  }

  closeDocumentWireFan(): void {
    this._startWireOverlayCloseTimer(450)
  }

  private _clearSalienceOverlayHoverTimer(): void {
    if (!this._salienceOverlayHoverTimer) return
    clearTimeout(this._salienceOverlayHoverTimer)
    this._salienceOverlayHoverTimer = null
  }

  private _clearSalienceOverlayCloseTimer(): void {
    if (!this._salienceOverlayCloseTimer) return
    clearTimeout(this._salienceOverlayCloseTimer)
    this._salienceOverlayCloseTimer = null
  }

  private _clearSalienceOverlayTimers(): void {
    this._clearSalienceOverlayHoverTimer()
    this._clearSalienceOverlayCloseTimer()
  }

  private _startSalienceOverlayCloseTimer(delayMs = 600): void {
    if (!this.salienceOverlayOpen || this._salienceOverlayCloseTimer) return
    this._salienceOverlayCloseTimer = setTimeout(() => {
      this._salienceOverlayCloseTimer = null
      this._closeSalienceOverlay()
    }, delayMs)
  }

  private _openSalienceOverlay(blockId: string, x: number, y: number): void {
    this.salienceOverlayBlockId = blockId
    this.salienceOverlayAnchor = clampSalienceOverlayAnchor(x, y)
    this.salienceOverlayOpen = true
    setLiveValueMarksOpen(this._editor, blockId)
  }

  private _closeSalienceOverlay(): void {
    this._clearSalienceOverlayTimers()
    setLiveValueMarksOpen(this._editor, null)
    this.salienceOverlayOpen = false
    this.salienceOverlayBlockId = null
    this.salienceOverlayExpanded = false
  }

  private _handleSalienceOverlayMouseEnter(): void {
    this._clearSalienceOverlayCloseTimer()
  }

  private _handleSalienceOverlayMouseLeave(): void {
    this._startSalienceOverlayCloseTimer(600)
  }

  /**
   * Right-edge hover-open, mirroring `_onEditorWireMouseMove`'s debounce shape
   * — 120ms open-debounce (vs wires' 160ms) and re-querying the block's rect
   * at TIMER-FIRE time (not mousemove time, via `clientX`/`clientY` captured
   * at fire — the block itself is re-resolved fresh on the next mousemove, so
   * a mid-hover scroll never anchors the gutter to a stale position). Shows
   * for EVERY block, not just already-scored ones — an unscored block must
   * still be ratable (a real bug the OG's ValuationController history fixed:
   * gating the gutter behind a prior score meant unscored blocks could never
   * receive their first rating).
   */
  private _onEditorSalienceMouseMove(event: MouseEvent): void {
    const row = event.target instanceof Element
      ? event.target.closest<HTMLElement>('.value-marks')
      : null
    const blockId = row?.dataset.valueMarksFor ?? null
    if (!row || !blockId) {
      this._clearSalienceOverlayHoverTimer()
      this._startSalienceOverlayCloseTimer()
      return
    }
    if (this.salienceOverlayOpen && this.salienceOverlayBlockId === blockId) {
      this._clearSalienceOverlayCloseTimer()
      return
    }
    if (this._salienceOverlayHoverTimer) return
    // Anchor beside the row, centered on the block's first line, so the
    // controls open where the glyphs are rather than where the pointer was.
    this._salienceOverlayHoverTimer = setTimeout(() => {
      this._salienceOverlayHoverTimer = null
      if (!row.isConnected) return
      const rect = row.getBoundingClientRect()
      this._openSalienceOverlay(blockId, rect.right + 4, rect.top + rect.height / 2)
    }, 120)
  }

  private _onEditorMouseLeave(): void {
    this._clearWireOverlayHoverTimer()
    this._startWireOverlayCloseTimer(250)
    this._clearSalienceOverlayHoverTimer()
    this._startSalienceOverlayCloseTimer(250)
  }

  private _handleWireRadialNavigate(detail: WireRadialNavigateDetail | undefined): void {
    if (!detail?.graphId || !detail.documentId) return
    this._closeWireOverlay()
    this.dispatchEvent(
      new CustomEvent<OpenDocumentDetail>(OPEN_DOCUMENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          graphId: detail.graphId,
          documentId: detail.documentId,
          ...(detail.blockId ? { blockId: detail.blockId } : {}),
        },
      }),
    )
  }

  private _handleWireRadialSuggestion(detail: WireRadialSuggestionDetail | undefined): void {
    this._closeWireOverlay()
    if (!detail?.docId) return
    this.dispatchEvent(
      new CustomEvent('open-wire-picker-seeded', {
        bubbles: true,
        composed: true,
        detail,
      }),
    )
  }

  private _handleWireRadialPin(detail: WirePinWireRequestDetail | undefined): void {
    if (!detail?.wireId || !detail.graphId) return
    this.dispatchEvent(
      new CustomEvent<WirePinWireRequestDetail>(WIRE_PIN_WIRE_REQUEST_EVENT, {
        bubbles: true,
        composed: true,
        detail,
      }),
    )
  }

  private _setWireHighlight(blockId: string | null, mode: 'hover' | 'arrival' = 'hover'): void {
    this._highlightedWireBlockId = blockId
    this._wireHighlightMode = mode
    this._syncWireHighlight()
  }

  /**
   * DRIVES THE PLUGIN; DOES NOT TOUCH THE DOM. This method used to walk the
   * mount and setAttribute onto each block element, and that is precisely why
   * wire highlighting never worked: those elements belong to ProseMirror, and
   * it replaces them on redraw. Measured in the running app — the attribute
   * went 1 -> 0 across a 1.5s window while block-dnd's decoration-based drag
   * handles went 3 -> 3 through the same replacement.
   *
   * The decoration in editor-kernel/extensions/wire-decorations.ts emits the
   * SAME two attributes, so the stylesheet and its contract guard are unchanged
   * — ProseMirror is simply the one applying them now, on every render, which
   * is the only way they survive.
   *
   * Historical note worth keeping, because it is a second bug the first one was
   * hiding: the DOM writer previously used `toggleAttribute`, which cannot
   * write a value and produced `data-wire-highlighted=""` against a stylesheet
   * asking for `'true'`. So even before the redraw ate it, it painted nothing.
   * Four surfaces route through here — wires-panel hover, travelling a wire,
   * a block result from global search, and the graph panel's node focus — and
   * all four were dark for that one reason.
   */
  private _syncWireHighlight(): void {
    if (!this._editor) return
    setLiveWireHighlight(this._editor, this._highlightedWireBlockId, this._wireHighlightMode)
  }

  private _commentMarkMatches(mark: RawMark, commentId: string): boolean {
    return mark.type?.name === 'commentMark' && mark.attrs?.commentId === commentId
  }

  /**
   * Paints the active comment through the kernel's decoration (never by writing
   * onto ProseMirror's elements; see comment-active.ts), then finds its first
   * mark only to read it: for scrolling, and to report whether it exists.
   */
  private _syncActiveComment(options: { readonly scroll?: boolean } = {}): boolean {
    const editor = this._editor
    if (!editor) return false
    const activeId = this._activeCommentId
    setLiveActiveComment(editor, activeId)
    if (!activeId) return true
    const firstActive = this._firstCommentMark(activeId)
    if (firstActive && options.scroll) {
      firstActive.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    }
    return firstActive != null
  }

  private _firstCommentMark(commentId: string): HTMLElement | null {
    const mount = this.renderRoot?.querySelector('.editor-mount') as HTMLElement | null
    if (!mount) return null
    for (const node of Array.from(mount.querySelectorAll('.comment-mark[data-comment-id]'))) {
      if (node.getAttribute('data-comment-id') === commentId) return node as HTMLElement
    }
    return null
  }

  private _commentMarkFromEvent(event: Event): HTMLElement | null {
    const target = event.target
    if (!(target instanceof Element)) return null
    return target.closest('.comment-mark[data-comment-id]') as HTMLElement | null
  }

  private _emitCommentPointer(detail: EditorCommentPointerDetail): void {
    this.dispatchEvent(
      new CustomEvent<EditorCommentPointerDetail>(EDITOR_COMMENT_POINTER_EVENT, {
        bubbles: true,
        composed: true,
        detail,
      }),
    )
  }

  private _onCommentMouseOver(event: MouseEvent): void {
    const mark = this._commentMarkFromEvent(event)
    const commentId = mark?.getAttribute('data-comment-id') ?? null
    if (!mark || !commentId || commentId === this._hoveredCommentMarkId) return
    this._hoveredCommentMarkId = commentId
    const rect = mark.getBoundingClientRect()
    this._emitCommentPointer({ commentId, action: 'enter', anchor: { x: rect.left, y: rect.bottom + 6 } })
  }

  private _onCommentMouseOut(event: MouseEvent): void {
    const mark = this._commentMarkFromEvent(event)
    const commentId = mark?.getAttribute('data-comment-id') ?? null
    if (!mark || !commentId || commentId !== this._hoveredCommentMarkId) return
    // Moving onto another span inside the same comment (a bold run, the
    // active-comment decoration) is not leaving it.
    const related = event.relatedTarget
    const relatedMark = related instanceof Element ? related.closest('.comment-mark[data-comment-id]') : null
    if (relatedMark?.getAttribute('data-comment-id') === commentId) return
    this._hoveredCommentMarkId = null
    const rect = mark.getBoundingClientRect()
    this._emitCommentPointer({ commentId, action: 'leave', anchor: { x: rect.left, y: rect.bottom + 6 } })
  }

  private _onCommentClick(event: MouseEvent, action: 'click' | 'dblclick'): void {
    const mark = this._commentMarkFromEvent(event)
    const commentId = mark?.getAttribute('data-comment-id') ?? null
    if (!mark || !commentId) return
    // A click that ends a drag is selecting text, not opening the comment.
    // Measured by pointer travel: ProseMirror's selection is not updated yet
    // when the click event arrives (selectionchange is asynchronous).
    const down = this._commentMouseDownAt
    if (action === 'click' ? down != null : false) {
      if (Math.hypot(event.clientX - down!.x, event.clientY - down!.y) > 4) return
    }
    this._emitCommentPointer({ commentId, action, anchor: { x: event.clientX + 10, y: event.clientY + 10 } })
  }


  private _setActiveComment(
    commentId: string | null,
    options: { readonly scroll?: boolean } = {},
  ): boolean {
    const normalized = commentId?.trim() || null
    this._activeCommentId = normalized
    return this._syncActiveComment(options)
  }

  private _removeComment(commentId: string): boolean {
    const normalized = commentId.trim()
    const editor = this._editor
    const doc = editor?.state.doc
    const stateTr = editor?.state.tr
    if (!normalized || !editor || !doc || !stateTr || !editor.view) return false

    let removed = false
    let tr = stateTr
    doc.descendants((node, pos) => {
      const nodeSize = typeof node.nodeSize === 'number' ? node.nodeSize : 0
      if (nodeSize <= 0) return
      for (const mark of node.marks ?? []) {
        if (!this._commentMarkMatches(mark, normalized)) continue
        tr = tr.removeMark(pos, pos + nodeSize, mark)
        removed = true
      }
    })

    if (!removed) return false
    editor.view.dispatch(tr)
    if (this._activeCommentId === normalized) this._activeCommentId = null
    this._syncActiveComment()
    editor.commands.focus()
    return true
  }

  private _blockIdCandidates(blockId: string): string[] {
    const normalized = blockId.trim()
    if (!normalized) return []
    const candidates = new Set<string>([normalized])
    if (normalized.startsWith('block-')) {
      const short = normalized.slice('block-'.length)
      if (short) candidates.add(short)
    } else {
      candidates.add(`block-${normalized}`)
    }
    return Array.from(candidates)
  }

  private _findBlockElement(blockId: string): HTMLElement | null {
    const mount = this.renderRoot?.querySelector('.editor-mount') as HTMLElement | null
    if (!mount) return null
    const candidates = new Set(this._blockIdCandidates(blockId))
    for (const block of Array.from(mount.querySelectorAll('[data-block-id]'))) {
      const el = block as HTMLElement
      const id = el.getAttribute('data-block-id')
      if (id && candidates.has(id)) return el
    }
    return null
  }

  private _applyFocusRequest(): void {
    if (!this._editor) return
    const request = this.focusRequest
    const blockId = request?.blockId?.trim()
    if (!request || !blockId || this._lastFocusRequestToken === request.token) return
    this._lastFocusRequestToken = request.token
    this._focusBlockWithRetry(blockId, request.durationMs ?? 950)
  }

  private _focusBlockWithRetry(blockId: string, durationMs: number): void {
    const token = ++this._blockFocusRetryToken
    const maxAttempts = 14
    const retryDelayMs = 120
    const tryFocus = (attempt: number): void => {
      if (token !== this._blockFocusRetryToken) return
      const blockEl = this._findBlockElement(blockId)
      if (blockEl) {
        blockEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const focusedId = blockEl.getAttribute('data-block-id') ?? blockId
        this._setWireHighlight(focusedId, 'arrival')
        if (this._blockFocusHighlightTimer) clearTimeout(this._blockFocusHighlightTimer)
        this._blockFocusHighlightTimer = setTimeout(() => {
          if (this._highlightedWireBlockId === focusedId) this._setWireHighlight(null)
          this._blockFocusHighlightTimer = null
        }, Math.max(200, durationMs))
        return
      }
      if (attempt < maxAttempts) {
        setTimeout(() => tryFocus(attempt + 1), retryDelayMs)
      }
    }
    tryFocus(0)
  }

  /** Destroy the live editor (if any) and clear its provider marker. */
  private _teardownEditor(): void {
    this._pendingRatings.clear()
    this._blockFocusRetryToken += 1
    if (this._blockFocusHighlightTimer) {
      clearTimeout(this._blockFocusHighlightTimer)
      this._blockFocusHighlightTimer = null
    }
    this._clearImageHover()
    this._closeWireOverlay()
    this._closeSalienceOverlay()
    this._wireClickUnsub?.()
    this._wireClickUnsub = null
    this._zoomUnsub?.()
    this._zoomUnsub = null
    this._teardownHeadingObserver()
    // Revoke the claim before destroy: editor/plugin teardown can synchronously
    // settle provider testimony. Any re-entrant access sync must observe that
    // there is no longer a live Surface editor to mutate.
    const editor = this._editor
    this._editor = null
    this._editorEditable = null
    this._editorHandle = null
    this._editorProvider = null
    editor?.destroy()
    this._syncDocumentAccess()
    this._highlightedWireBlockId = null
    this._activeCommentId = null
    this._resetSearchState()
    this._resetFormatState()
    this._syncZoomSnapshot()
    // A body that goes away IS a content change (`json: null`) for anyone
    // watching. On a document/provider SWAP the remount's own trigger lands
    // inside the same debounce window and supersedes this one, so a swap
    // delivers one notification carrying the new document rather than a
    // null-then-content pair; on a real disconnect `disconnectedCallback`
    // cancels it outright.
    this._scheduleContentNotify('teardown')
  }

  /**
   * The SHIPPED public live-editor handle, or null when the body is a placeholder.
   * Returns the stable handle projected over the held raw Editor (built once in
   * _mountClaimed):
   *   - getText()/destroy() pass straight through;
   *   - insertWikiLink(attrs) delegates to the kernel's REAL `commands.insertWikiLink`
   *     (boolean = whether the command applied) — the public insert path the picker
   *     glue uses (L1: insert flows through this surface, not a private cast).
   * Identity tracks the EditorView's lifetime (same handle across same-editor
   * re-renders → the mount-once/undo-survival contract reads through `liveEditor`).
   */
  get liveEditor(): LiveEditorHandle | null {
    return this._editorHandle
  }

  /** Focus the pane's live ProseMirror view without exposing the raw editor. */
  focusEditor(): boolean {
    if (!this._editor) return false
    this._editor.commands.focus()
    return true
  }

  // ── W14.1 — LOSSLESS CONTENT EXPOSURE ON THE HOSTED PATH ────────────────────
  //
  // Before this pair, the only public read of a hosted document's content was
  // `liveEditor.getText()` — a flattening projection. Anything needing the
  // document ITSELF (the SEELe workbench's source projection is the first such
  // consumer, but "read the doc" is not workbench-specific) had to reach past
  // the public surface: either a private `_editor` cast, or re-deriving
  // ProseMirror JSON from the provider's shared CRDT document.
  //
  // WHY THE PAIR LIVES ON THE HOST, NOT ONLY ON `LiveEditorHandle`:
  // `LiveEditorHandle`'s identity tracks ONE EditorView. The view is destroyed
  // and rebuilt on every provider swap, every document switch, and every DOM
  // relocation (`persistent-relocatable` faces are re-parented, which runs
  // disconnectedCallback → `_teardownEditor` → connectedCallback → remount). A
  // controller that subscribed to a handle would silently go deaf at the first
  // reparent. The HOST element outlives all of that, so a consumer subscribes
  // once, at face-mount time, and keeps hearing.
  //
  // BOUNDARY DOCTRINE: both are reads. They dispatch nothing, mutate nothing,
  // touch no network, and hold no authority — the HOST (or whatever owns the
  // controller above it) keeps every side effect. Nothing in `packages/hoja`
  // changes; this is the hosted `<sh-editor-host>` path only.

  /**
   * The live document as TipTap JSON, or `null` when this pane has no live
   * editor body (placeholder / pre-mount / torn down). Lossless: fences, marks,
   * node attributes and wikilink targets all survive, which `getText()` does
   * not preserve.
   *
   * Pull-style. Pair it with `onDocumentContentChanged` when you need to know
   * WHEN to pull, or read the `json` the notification already carries.
   */
  getDocumentJSON(): LiveDocumentJSON | null {
    return this._editor ? this._editor.getJSON() : null
  }

  /**
   * Subscribe to document-content changes. Returns an unsubscribe function.
   *
   * Semantics, precisely:
   *   - the BASELINE is the content at subscribe time, so subscribing to a
   *     quiet editor and doing nothing yields zero callbacks;
   *   - a notification fires only when the document JSON actually DIFFERS from
   *     the last one delivered to THAT listener. Selection-only and focus-only
   *     transactions therefore produce nothing, and an edit that restores the
   *     previous bytes produces nothing (idempotent-edit coalescing);
   *   - delivery is trailing-debounced per listener (`debounceMs`, default 250),
   *     so a burst of keystrokes yields one callback carrying the settled
   *     document, not one per transaction;
   *   - remote (collaborative) updates count: they arrive as ProseMirror
   *     transactions like local ones, so a second client's edit notifies here;
   *   - subscriptions SURVIVE disconnect/reconnect (DOM relocation), because
   *     the whole point of the host-level seam is that a relocation is not a
   *     content change. Only the pending timer is cancelled on disconnect, so
   *     nothing fires at a subscriber while the host is detached; the next real
   *     change after reconnect delivers normally.
   *
   * The listener is called with the JSON as of the moment the notification was
   * computed. It runs inside a try/catch — a throwing subscriber cannot break
   * the editor or the other subscribers.
   */
  onDocumentContentChanged(
    listener: (change: EditorContentChange) => void,
    options?: EditorContentSubscribeOptions,
  ): () => void {
    const subscription: EditorContentSubscription = {
      listener,
      debounceMs: Math.max(0, options?.debounceMs ?? 250),
      timer: null,
      signature: this._contentSignature(),
      pendingReason: 'mounted',
    }
    this._contentSubscriptions.add(subscription)
    return () => {
      if (subscription.timer !== null) clearTimeout(subscription.timer)
      subscription.timer = null
      this._contentSubscriptions.delete(subscription)
    }
  }

  /**
   * Stable, cheap-to-compare stringification of the current document. `null`
   * (no live body) is a distinct signature from any real document, so a body
   * appearing or disappearing is itself a change.
   */
  private _contentSignature(): string {
    const json = this.getDocumentJSON()
    return json === null ? '\u0000none' : JSON.stringify(json)
  }

  /**
   * Arm each subscriber's trailing window. Called from `_emitStructureChange`
   * (mount / transaction / selection) — i.e. exactly the moments the editor
   * already tells the shell something structural happened — and from
   * `_teardownEditor`. Whether anything is actually DELIVERED is decided when
   * the window fires, by content comparison, not here.
   */
  private _scheduleContentNotify(reason: EditorContentChangeReason): void {
    for (const subscription of this._contentSubscriptions) {
      subscription.pendingReason = reason
      if (subscription.timer !== null) clearTimeout(subscription.timer)
      subscription.timer = setTimeout(() => {
        subscription.timer = null
        this._deliverContentChange(subscription)
      }, subscription.debounceMs)
    }
  }

  private _deliverContentChange(subscription: EditorContentSubscription): void {
    if (!this._contentSubscriptions.has(subscription)) return
    const signature = this._contentSignature()
    if (signature === subscription.signature) return
    subscription.signature = signature
    const change: EditorContentChange = {
      json: this.getDocumentJSON(),
      reason: subscription.pendingReason,
    }
    try {
      subscription.listener(change)
    } catch (error) {
      console.error('sh-editor-host: content-change subscriber threw', error)
    }
  }

  /** Cancel pending notifications without dropping the subscriptions themselves. */
  private _cancelPendingContentNotify(): void {
    for (const subscription of this._contentSubscriptions) {
      if (subscription.timer !== null) clearTimeout(subscription.timer)
      subscription.timer = null
    }
  }

  private _resetFormatState(): void {
    const next = defaultFormatState()
    if (!sameFormatState(this.formatState, next)) this.formatState = next
  }

  private _syncFormatState(): void {
    const editor = this._editor
    if (!editor) {
      this._resetFormatState()
      return
    }

    const headingLevel = (
      editor.isActive('heading', { level: 1 }) ? 1 :
      editor.isActive('heading', { level: 2 }) ? 2 :
      editor.isActive('heading', { level: 3 }) ? 3 :
      0
    ) as HeadingLevel

    const paragraphAlign = editor.getAttributes('paragraph').textAlign
    const headingAlign = editor.getAttributes('heading').textAlign
    const rawAlign = typeof paragraphAlign === 'string' ? paragraphAlign : headingAlign
    const textAlign: TextAlignment =
      rawAlign === 'center' || rawAlign === 'right' ? rawAlign : 'left'
    const textStyle = editor.getAttributes('textStyle')
    const fontFamily = typeof textStyle.fontFamily === 'string' ? textStyle.fontFamily : ''
    const fontSize = typeof textStyle.fontSize === 'string' ? textStyle.fontSize : ''

    let blockType: BlockToolbarValue = 'paragraph'
    if (editor.isActive('listItem', { listType: 'bullet' })) blockType = 'bulletList'
    else if (editor.isActive('listItem', { listType: 'ordered' })) blockType = 'orderedList'
    else if (editor.isActive('listItem', { listType: 'task' })) blockType = 'taskList'
    else if (headingLevel > 0) blockType = `heading${headingLevel}` as BlockToolbarValue
    else if (editor.isActive('blockquote')) blockType = 'blockquote'
    else if (editor.isActive('codeBlock')) blockType = 'codeBlock'

    const next: EditorFormatState = {
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      highlight: editor.isActive('highlight'),
      fontFamily,
      fontSize,
      textAlign,
      headingLevel,
      blockType,
      inTable: editor.isActive('table'),
    }

    if (!sameFormatState(this.formatState, next)) this.formatState = next
  }

  private _onToolbarFormat(event: CustomEvent<EditorToolbarFormatDetail>): void {
    this._toggleInlineFormat(event.detail.command)
  }

  private _toggleInlineFormat(format: 'bold' | 'italic' | 'strike' | 'code' | 'highlight'): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()
    if (format === 'bold') editor.commands.toggleBold()
    else if (format === 'italic') editor.commands.toggleItalic()
    else if (format === 'strike') editor.commands.toggleStrike()
    else if (format === 'code') editor.commands.toggleCode()
    else editor.commands.toggleHighlight()
    this._syncFormatState()
  }

  private _onFontFamilyChange(event: CustomEvent<EditorToolbarTextStyleDetail>): void {
    this._setFontFamily(event.detail.value)
  }

  private _setFontFamily(value: string): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()
    if (value) editor.commands.setFontFamily(value)
    else editor.commands.unsetFontFamily()
    this._syncFormatState()
  }

  private _onFontSizeChange(event: CustomEvent<EditorToolbarTextStyleDetail>): void {
    this._setFontSize(event.detail.value)
  }

  private _setFontSize(value: string): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()
    if (value) editor.commands.setFontSize(value)
    else editor.commands.unsetFontSize()
    this._syncFormatState()
  }

  private _onBlockTypeChange(event: CustomEvent<EditorToolbarBlockTypeDetail>): void {
    this._setBlockType(event.detail.blockType)
  }

  private _setBlockType(type: BlockToolbarValue): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()
    if (type === 'paragraph') {
      editor.commands.setParagraph()
      editor.commands.unsetAllMarks()
    } else if (type === 'heading1') {
      editor.commands.toggleHeading({ level: 1 })
    } else if (type === 'heading2') {
      editor.commands.toggleHeading({ level: 2 })
    } else if (type === 'heading3') {
      editor.commands.toggleHeading({ level: 3 })
    } else if (type === 'bulletList') {
      editor.commands.toggleBulletItem()
    } else if (type === 'orderedList') {
      editor.commands.toggleOrderedItem()
    } else if (type === 'taskList') {
      editor.commands.toggleTaskItem()
    } else if (type === 'blockquote') {
      editor.commands.toggleBlockquote()
    } else if (type === 'codeBlock') {
      editor.commands.toggleCodeBlock()
    }
    this._syncFormatState()
  }

  private _clearFormatting(): void {
    this._setBlockType('paragraph')
  }

  private _setTextAlign(alignment: TextAlignment): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()
    editor.commands.setTextAlign(alignment)
    this._syncFormatState()
  }

  private _onToolbarAlign(event: CustomEvent<EditorToolbarAlignDetail>): void {
    this._setTextAlign(event.detail.alignment)
  }

  /** The Table menu: rows and columns of the table the cursor is in. */
  private _onTableCommand(event: CustomEvent<{ command?: string }>): void {
    const editor = this._editor
    const command = event.detail?.command
    if (!editor || !command || !editor.isActive('table')) return
    editor.commands.focus()
    const commands = editor.commands
    const run: Record<string, () => boolean> = {
      addRowBefore: () => commands.addRowBefore(),
      addRowAfter: () => commands.addRowAfter(),
      addColumnBefore: () => commands.addColumnBefore(),
      addColumnAfter: () => commands.addColumnAfter(),
      deleteRow: () => commands.deleteRow(),
      deleteColumn: () => commands.deleteColumn(),
      deleteTable: () => commands.deleteTable(),
    }
    run[command]?.()
    this._syncFormatState()
  }

  private _toggleTable(): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()
    if (editor.isActive('table')) {
      editor.commands.deleteTable()
    } else {
      editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    }
    this._syncFormatState()
  }

  private _runOutlinerCommand(command: LiveOutlinerCommand): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()

    let applied = false
    if (command === 'toggleCollapse') applied = editor.commands.toggleCollapse()
    else if (command === 'collapseAll') applied = editor.commands.collapseAll()
    else if (command === 'expandAll') applied = editor.commands.expandAll()
    else if (command === 'moveUp') applied = editor.commands.moveBlockUp()
    else if (command === 'moveDown') applied = editor.commands.moveBlockDown()
    else if (command === 'selectParent') applied = editor.commands.selectParentBlock()
    else if (command === 'selectAll') applied = editor.commands.selectAllBlocks()
    else if (command === 'zoomIn') applied = editor.commands.zoomIntoCurrent()
    else applied = editor.commands.zoomOut()

    if (!applied) return
    this._syncZoomSnapshot()
    this._syncFormatState()
    this._syncWireIndicators()
    this._syncValueMarks()
  }

  private _openWikiLinkPicker(): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()
    this.ownerDocument.dispatchEvent(new CustomEvent('open-wikilink-picker'))
  }

  private _openCitationPicker(): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()
    this.ownerDocument.dispatchEvent(new CustomEvent('open-citation-picker'))
  }

  private _requestDocumentWire(event: CustomEvent<EditorToolbarModifierDetail>): void {
    const editor = this._editor
    if (!editor) return
    editor.commands.focus()
    this.ownerDocument.dispatchEvent(
      new CustomEvent<DocumentWireRequestDetail>(WIRE_DOCUMENT_REQUEST_EVENT, {
        detail: event.detail,
      }),
    )
  }

  private _onToolbarHistory(event: CustomEvent<EditorToolbarHistoryDetail>): void {
    const editor = this._editor
    if (!editor) return
    if (event.detail.command === 'undo') editor.commands.undo()
    else editor.commands.redo()
    this._syncFormatState()
    this._syncSearchState()
  }

  /**
   * The open document was deleted (from a folder, by an agent, or from the
   * sidebar). The shell closes it; the toolbar's conflict line is only the
   * fallback for a host that doesn't.
   */
  private _announceDocumentDeleted(): void {
    const state = this.hostState
    if (!state?.graphId || !state.documentId) return
    this.ownerDocument.dispatchEvent(
      new CustomEvent(EDITOR_DOCUMENT_DELETED_EVENT, {
        detail: { graphId: state.graphId, documentId: state.documentId },
      }),
    )
  }

  private _openDocumentHistory(event?: Event): void {
    event?.stopPropagation()
    const state = this.hostState
    if (!this._editor || !state?.graphId || !state.documentId) return
    this.ownerDocument.dispatchEvent(
      new CustomEvent('mn-editor-history-open', {
        detail: { graphId: state.graphId, documentId: state.documentId },
      }),
    )
  }

  private _inputDialogElement():
    | (HTMLElement & {
        title: string
        message: string
        value: string
        placeholder: string
        confirmText: string
        cancelText: string
        loading: boolean
        open: boolean
        show?: () => void
        hide?: () => void
      })
    | null {
    return this.renderRoot.querySelector('[data-editor-input-dialog]') as
      | (HTMLElement & {
          title: string
          message: string
          value: string
          placeholder: string
          confirmText: string
          cancelText: string
          loading: boolean
          open: boolean
          show?: () => void
          hide?: () => void
        })
      | null
  }

  private async _promptTextDialog(opts: EditorInputDialogOptions): Promise<string | null> {
    const previous = this.inputDialogResolve
    if (previous) previous(null)
    await this.updateComplete
    const dialog = this._inputDialogElement()
    if (!dialog) return null
    dialog.title = opts.title
    dialog.message = opts.message ?? ''
    dialog.value = opts.value ?? ''
    dialog.placeholder = opts.placeholder ?? ''
    dialog.confirmText = opts.confirmText ?? 'OK'
    dialog.cancelText = 'Cancel'
    dialog.loading = false
    return new Promise((resolve) => {
      this.inputDialogResolve = resolve
      if (dialog.show) dialog.show()
      else dialog.open = true
    })
  }

  private _closeInputDialog(value: string | null): void {
    const resolve = this.inputDialogResolve
    this.inputDialogResolve = null
    const dialog = this._inputDialogElement()
    if (dialog?.hide) dialog.hide()
    else if (dialog) dialog.open = false
    resolve?.(value)
    this._editor?.commands.focus()
  }

  private _onInputDialogConfirm(event: CustomEvent<EditorInputDialogConfirmDetail>): void {
    event.stopPropagation()
    this._closeInputDialog(event.detail.value.trim())
  }

  private _onInputDialogCancel(event: Event): void {
    event.stopPropagation()
    this._closeInputDialog(null)
  }

  private async _promptImageInsert(): Promise<EditorImageInsert | null> {
    const src = (await this._promptTextDialog({
      title: 'Insert Image',
      message: 'Paste an image URL to insert it into the document.',
      placeholder: 'https://example.com/image.png',
      confirmText: 'Continue',
    }))?.trim()
    if (!src) return null
    const alt = (await this._promptTextDialog({
      title: 'Image Alt Text',
      message: 'Describe the image for readers and agents.',
      placeholder: 'Alt text',
      confirmText: 'Insert',
    })) ?? ''
    return { src, alt }
  }

  private async _insertImageFromToolbar(): Promise<boolean> {
    const editor = this._editor
    if (!editor) return false
    const attrs = await (this.imageInserter ? this.imageInserter() : this._promptImageInsert())
    if (!attrs?.src.trim()) return false
    editor.commands.focus()
    const applied = editor.commands.insertImage({
      src: attrs.src.trim(),
      alt: attrs.alt ?? '',
      title: attrs.title,
      size: attrs.size ?? 'large',
    })
    this._syncFormatState()
    this._syncWireIndicators()
    this._syncValueMarks()
    return applied
  }

  private async _promptFootnoteContent(): Promise<string | null> {
    const value = await this._promptTextDialog({
      title: 'Insert Footnote',
      message: 'Enter the footnote content.',
      placeholder: 'Footnote content',
      confirmText: 'Insert',
    })
    return value?.trim() || null
  }

  private async _insertFootnoteFromToolbar(): Promise<void> {
    const editor = this._editor
    if (!editor) return
    const content = await (this.footnoteInserter ? this.footnoteInserter() : this._promptFootnoteContent())
    const normalized = content?.trim()
    if (!normalized) return
    editor.commands.focus()
    editor.commands.insertFootnote({ content: normalized })
    this._syncFormatState()
  }

  private _selectedTextRange(): EditorCommentInsertRequest | null {
    const state = this._editor?.state as
      | {
          selection?: { empty?: boolean; from?: number; to?: number }
          doc?: { textBetween?: (from: number, to: number, blockSeparator?: string, leafText?: string) => string }
        }
      | undefined
    const selection = state?.selection
    const from = typeof selection?.from === 'number' ? selection.from : null
    const to = typeof selection?.to === 'number' ? selection.to : null
    if (selection?.empty || from === null || to === null || from === to) return null
    const selectedText = state?.doc?.textBetween?.(from, to, ' ', ' ')?.trim() ?? ''
    return { selectedText, from, to }
  }

  private _fallbackCommentId(): string {
    const randomUUID = this.ownerDocument.defaultView?.crypto?.randomUUID
    return `comment-${randomUUID ? randomUUID.call(this.ownerDocument.defaultView.crypto) : Date.now().toString(36)}`
  }

  private async _insertCommentFromToolbar(): Promise<void> {
    const editor = this._editor
    if (!editor) return
    const request = this._selectedTextRange()
    if (!request) return
    const result = await (this.commentInserter ? this.commentInserter(request) : null)
    const commentId = (typeof result === 'string' ? result : result?.commentId) ?? this._fallbackCommentId()
    const normalized = commentId.trim()
    if (!normalized) return
    editor.commands.focus()
    editor.commands.setComment({ commentId: normalized })
    const rect = this._firstCommentMark(normalized)?.getBoundingClientRect() ?? null
    const anchor = rect ? { x: rect.left + 10, y: rect.bottom + 10 } : null
    this.dispatchEvent(
      new CustomEvent<EditorCommentInsertedDetail>('mn-editor-comment-inserted', {
        bubbles: true,
        composed: true,
        detail: { ...request, commentId: normalized, anchor },
      }),
    )
    this._syncFormatState()
  }

  private _resetSearchState(): void {
    this.searchOpen = false
    this.searchQuery = ''
    this.replaceQuery = ''
    this.searchResultCount = 0
    this.searchCurrentIndex = 0
  }

  private _syncSearchState(): void {
    const search = this._editor?.storage.search
    const results = Array.isArray(search?.results) ? search.results : []
    const index = typeof search?.currentIndex === 'number' ? search.currentIndex : -1
    this.searchResultCount = results.length
    this.searchCurrentIndex = results.length > 0 ? Math.max(0, index) : 0
  }

  /**
   * Open the find bar. For the app menu's Edit > Find: the menu owns Mod+F in
   * the desktop app, so the host's own keydown never sees it there.
   */
  openFind(): void {
    this._openSearch()
  }

  /** Comment on the selected text. For the app menu's Edit > Add Comment. */
  addComment(): void {
    if (this._effectiveReadOnly()) return
    void this._insertCommentFromToolbar()
  }

  /**
   * Select All as Mod+A does inside the editor: every block while a block
   * selection is active, otherwise all the text. For the app menu's Edit >
   * Select All, which owns Mod+A in the desktop app. Runs the editor's own
   * keymap, not WebKit's native select-all (which selected the whole page;
   * see garden app_menu.rs).
   */
  selectAll(): boolean {
    const editor = this._editor
    if (!editor) return false
    editor.commands.focus()
    return editor.commands.keyboardShortcut('Mod-a') || editor.commands.selectAll()
  }

  /**
   * Undo and Redo for the app menu's Edit items, which own Mod+Z and
   * Mod+Shift+Z in the desktop app. They run the room history (the editor's
   * own undo), never WebKit's native undo, which rewrote the DOM behind
   * ProseMirror's back and undid "everything except the first word"
   * (Eschaton, 2026-11-17). False when there is no live editor or nothing to undo.
   */
  undoFromMenu(): boolean {
    const editor = this._editor
    if (!editor) return false
    return editor.commands.undo()
  }

  redoFromMenu(): boolean {
    const editor = this._editor
    if (!editor) return false
    return editor.commands.redo()
  }

  private _openSearch(): void {
    if (!this._editor) return
    if (!this.searchOpen) {
      this.searchOpen = true
      this.searchQuery = ''
      this.replaceQuery = ''
      this._editor.commands.clearSearch()
      this._syncSearchState()
    }
    void this.updateComplete.then(() => {
      const toolbar = this.renderRoot.querySelector('mn-editor-toolbar') as
        | (HTMLElement & { focusSearchInput?: () => void })
        | null
      toolbar?.focusSearchInput?.()
    })
  }

  private _closeSearch(): void {
    if (this._editor) this._editor.commands.clearSearch()
    this._resetSearchState()
    this._editor?.commands.focus()
  }

  private _runSearch(): void {
    const editor = this._editor
    if (!editor) return
    if (this.searchQuery.length === 0) {
      editor.commands.clearSearch()
    } else {
      editor.commands.setSearchTerm(this.searchQuery, false)
    }
    this._syncSearchState()
  }

  private _onSearchInput(event: CustomEvent<EditorToolbarTextChangeDetail>): void {
    this.searchQuery = event.detail.value
    this._runSearch()
  }

  private _onReplaceInput(event: CustomEvent<EditorToolbarTextChangeDetail>): void {
    this.replaceQuery = event.detail.value
  }

  private _onToolbarSearchKeyDown(event: CustomEvent<EditorToolbarKeyboardDetail>): void {
    this._onSearchKeyDown(event.detail.keyboardEvent)
  }

  private _onToolbarReplaceKeyDown(event: CustomEvent<EditorToolbarKeyboardDetail>): void {
    this._onReplaceKeyDown(event.detail.keyboardEvent)
  }

  private _openShortcuts = (): void => {
    this.dispatchEvent(new CustomEvent('mn-open-shortcuts', { bubbles: true, composed: true }))
  }

  private _onSearchKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) {
        this._previousSearchResult()
      } else {
        this._nextSearchResult()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this._closeSearch()
    }
  }

  private _onReplaceKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.metaKey || event.ctrlKey) {
        this._replaceAllSearchResults()
      } else {
        this._replaceCurrentSearchResult()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this._closeSearch()
    }
  }

  private _nextSearchResult(): void {
    if (!this._editor || this.searchResultCount === 0) return
    this._editor.commands.nextSearchResult()
    this._syncSearchState()
  }

  private _previousSearchResult(): void {
    if (!this._editor || this.searchResultCount === 0) return
    this._editor.commands.prevSearchResult()
    this._syncSearchState()
  }

  private _replaceCurrentSearchResult(): void {
    if (!this._editor || this.searchQuery.length === 0 || this.searchResultCount === 0) return
    this._editor.commands.replaceCurrentSearchResult(this.replaceQuery)
    this._syncSearchState()
  }

  private _replaceAllSearchResults(): void {
    if (!this._editor || this.searchQuery.length === 0 || this.searchResultCount === 0) return
    this._editor.commands.replaceAllSearchResults(this.replaceQuery)
    this._syncSearchState()
  }

  private _paintImageResizeButton(): void {
    const layer = this.renderRoot?.querySelector('.image-resize-layer') as HTMLElement | null
    if (!layer) return
    layer.replaceChildren()

    const blockId = this.hoveredImageBlockId
    const rect = this.hoveredImageRect
    if (!blockId || !rect) return

    const imageBlock = this._findBlockElement(blockId)
    if (!imageBlock?.classList.contains('image-block')) return
    const currentSize = imageBlock.getAttribute('data-size') ?? 'large'
    const labels: Record<string, string> = { large: '100%', medium: '66%', small: '33%' }
    const label = labels[currentSize] ?? '100%'
    const right = Math.max(0, window.innerWidth - (rect.right - 4))
    const bottom = Math.max(0, window.innerHeight - (rect.bottom - 4))

    const doc = this.ownerDocument
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'image-resize-button'
    button.style.right = `${right}px`
    button.style.bottom = `${bottom}px`
    button.title = 'Cycle image size'
    button.setAttribute('aria-label', `Cycle image size, currently ${label}`)
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    button.addEventListener('mouseenter', () => this._clearImageHoverTimer())
    button.addEventListener('mouseleave', () => {
      this._clearImageHoverTimer()
      this._imageHoverLeaveTimer = setTimeout(() => this._clearImageHover(), 150)
    })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this._cycleImageSize(blockId)
    })

    const glyph = doc.createElement('span')
    glyph.className = 'image-resize-glyph'
    glyph.setAttribute('aria-hidden', 'true')
    const text = doc.createElement('span')
    text.textContent = label
    button.append(glyph, text)
    layer.appendChild(button)
  }

  /**
   * The LIVE body's mount target — a STABLE empty <div> the imperative TipTap
   * Editor is mounted INTO (in _reconcileEditor, after this render stamps it).
   * It must stay the SAME element across re-renders so the live EditorView is not
   * clobbered; because it is a single fixed branch (no keyed needed), Lit reuses
   * the same node as long as render() keeps returning this branch.
   *
   * data-mode='live' is the probe attribute (mirrors the placeholder's data-mode).
   */
  private renderLiveBody(): TemplateResult {
    const fs = this.formatState
    const original = this.originalFileView
    // The explicit three-state mode wins when the shell projects it; `active`
    // remains the binary fallback for shells on the older contract.
    const originalMode: EditorOriginalFileMode = original?.mode
      ?? (original?.active ? 'original' : 'document')
    const showOriginal = Boolean(original) && originalMode !== 'document'
    // The viewer reads the PDF surface mode off the reader state; the host
    // projects the document-level mode into it (original-first by default).
    const originalPdf = original?.pdf
      ? originalMode === 'annotations'
        ? { ...original.pdf, mode: 'annotations' as const }
        : original.pdf.mode === 'annotations'
          ? { ...original.pdf, mode: 'original' as const }
          : original.pdf
      : null
    return html`<mn-editor-toolbar
        .formatState=${fs}
        .fontFamily=${fs.fontFamily}
        .fontSize=${fs.fontSize}
        .blockType=${fs.blockType}
        .textAlign=${fs.textAlign}
        .inTable=${fs.inTable}
        .searchOpen=${this.searchOpen}
        .searchQuery=${this.searchQuery}
        .replaceQuery=${this.replaceQuery}
        .searchResultCount=${this.searchResultCount}
        .searchCurrentIndex=${this.searchCurrentIndex}
        .ttsStatus=${this.ttsStatus}
        .ttsAvailable=${this.ttsAvailable}
        .readOnly=${this._toolbarReadOnly()}
        .activationPending=${!this._activationSynced}
        .activationState=${this._activationPhase}
        .activationDurability=${this._activationDurability}
        .activationConflict=${this._activationConflict ?? ''}
        .makeEditableStatus=${this.documentAccess?.makeEditableStatus ?? 'idle'}
        .makeEditableError=${this.documentAccess?.makeEditableError ?? ''}
        .derived=${this.documentAccess?.derived ?? false}
        .derivedOwner=${this.documentAccess?.readOnlyOwner ?? ''}
        .originalViewAvailable=${original?.available ?? false}
        .originalViewActive=${showOriginal}
        .originalViewMode=${originalMode}
        .originalPdfBacked=${Boolean(original?.pdf)}
        @mn-editor-font-family=${this._onFontFamilyChange}
        @mn-editor-font-size=${this._onFontSizeChange}
        @mn-editor-format=${this._onToolbarFormat}
        @mn-editor-block-type=${this._onBlockTypeChange}
        @mn-editor-clear-formatting=${this._clearFormatting}
        @mn-editor-align=${this._onToolbarAlign}
        @mn-editor-table-toggle=${this._toggleTable}
        @mn-editor-table-command=${this._onTableCommand}
        @mn-editor-wikilink-open=${this._openWikiLinkPicker}
        @mn-editor-document-wire-request=${this._requestDocumentWire}
        @mn-editor-history=${this._onToolbarHistory}
        @mn-editor-history-open=${this._openDocumentHistory}
        @mn-editor-footnote-insert=${this._insertFootnoteFromToolbar}
        @mn-editor-citation-open=${this._openCitationPicker}
        @mn-editor-comment-insert=${this._insertCommentFromToolbar}
        @mn-editor-image-insert=${this._insertImageFromToolbar}
        @mn-editor-search-open=${this._openSearch}
        @mn-editor-search-close=${this._closeSearch}
        @mn-editor-search-input=${this._onSearchInput}
        @mn-editor-search-keydown=${this._onToolbarSearchKeyDown}
        @mn-editor-search-prev=${this._previousSearchResult}
        @mn-editor-search-next=${this._nextSearchResult}
        @mn-editor-replace-input=${this._onReplaceInput}
        @mn-editor-replace-keydown=${this._onToolbarReplaceKeyDown}
        @mn-editor-replace-current=${this._replaceCurrentSearchResult}
        @mn-editor-replace-all=${this._replaceAllSearchResults}
        @mn-editor-shortcuts-open=${this._openShortcuts}
      ></mn-editor-toolbar>
      <div
        class="original-file-view"
        ?hidden=${!showOriginal}
        role="region"
        aria-label="Original document view"
      >
        ${showOriginal && original
          ? html`<mn-original-viewer
              .graphId=${original.graphId}
              .documentId=${original.documentId}
              .status=${original.status}
              .kind=${'auto'}
              .title=${original.title}
              .filename=${original.filename}
              .fileType=${original.fileType}
              .mimeType=${original.mimeType}
              .src=${original.src}
              .srcdoc=${original.srcdoc}
              .text=${original.text}
              .error=${original.error}
              .selectedChapterId=${original.selectedChapterId}
              .downloadable=${original.downloadable}
              .externalOpenable=${original.externalOpenable}
              .chapters=${original.chapters}
              .annotations=${original.annotations}
              .pdf=${originalPdf}
            ></mn-original-viewer>`
          : nothing}
      </div>
      <mn-salience-config
        ?hidden=${this.hostState?.documentId !== IMPORTANCE_VIEW_DOCUMENT_ID || showOriginal}
        .writable=${this._canRateSalience()}
        write-reason=${this.documentAccess?.salienceWriteReason?.trim() ?? ''}
        graph-key=${this.hostState?.graphId ?? ''}
      ></mn-salience-config>
      <nav
        class="zoom-breadcrumb"
        aria-label="Zoom trail"
        ?hidden=${showOriginal || this.zoomSnapshot.breadcrumb.length === 0}
      ></nav>
      <div
        class="editor-mount"
        data-mode="live"
        ?hidden=${showOriginal}
        ?inert=${showOriginal}
        aria-hidden=${showOriginal ? 'true' : 'false'}
      ></div>
      <div class="image-resize-layer" ?hidden=${showOriginal}></div>
      <mn-input-dialog
        data-editor-input-dialog
        @mn-confirm=${this._onInputDialogConfirm}
        @mn-cancel=${this._onInputDialogCancel}
      ></mn-input-dialog>
      <div class="wire-radial-layer">${this.renderWireRadialOverlay()}</div>
      <div class="salience-gutter-layer">${this.renderSalienceGutter()}</div>`
  }

  private _canRateSalience(): boolean {
    return this.documentAccess?.salienceWritable ?? !(this.documentAccess?.readOnly ?? false)
  }

  /**
   * In the importance view, draw value controls on every entry's source line,
   * for the source block; anywhere else, draw none. Runs on mount, when the view's content
   * changes, and when the shell sets new source scores.
   */
  private _syncImportanceView(): void {
    const editor = this._editor as unknown as Parameters<typeof liveImportanceViewTargets>[0] | null
    if (!editor) return
    if (this.hostState?.documentId !== IMPORTANCE_VIEW_DOCUMENT_ID) {
      if (this._importanceTargets.size > 0) {
        this._importanceTargets = new Map()
        this._importanceTargetsKey = ''
        setLiveBlockControls(this._editor, new Map())
      }
      return
    }
    const targets = liveImportanceViewTargets(editor)
    const key = Array.from(targets.values(), t => sourceScoreKey(t.documentId, t.blockId)).join('|')
    this._importanceTargets = targets
    if (key !== this._importanceTargetsKey) {
      this._importanceTargetsKey = key
      this.dispatchEvent(
        new CustomEvent<ImportanceViewSourcesDetail>(IMPORTANCE_VIEW_SOURCES_EVENT, {
          bubbles: true,
          composed: true,
          detail: { targets: Array.from(targets.values()) },
        }),
      )
    }
    const canRate = this._canRateSalience()
    const writeReason = this.documentAccess?.salienceWriteReason?.trim()
      || 'Rating requires writable graph access and an online cell.'
    const controls = new Map<string, LiveBlockControlButton[]>()
    for (const [lineId, target] of targets) {
      const score = this.sourceSalienceScores?.get(sourceScoreKey(target.documentId, target.blockId))
      const flagSvg = salienceIconSvg(importanceIcon(score))
      controls.set(lineId, [
        {
          action: 'importance',
          label: canRate ? `${importanceLabel(score)} — your rating of the source block` : writeReason,
          // Very important is the flag twice, as in the value gutter.
          iconSvg: isVeryImportant(score) ? flagSvg + flagSvg : flagSvg,
          active: hasUserImportance(score),
          disabled: !canRate,
        },
        {
          action: 'valence',
          label: canRate ? `${valenceLabel(score)} — your rating of the source block` : writeReason,
          iconSvg: salienceIconSvg(valenceIcon(score)),
          active: (score?.userValence ?? null) !== null,
          disabled: !canRate,
        },
        {
          action: 'renew',
          label: canRate ? renewLabel(score) : writeReason,
          iconSvg: salienceIconSvg('refresh-cw'),
          disabled: !canRate || !canRenewFreshness(score),
        },
      ])
    }
    setLiveBlockControls(this._editor, controls)
  }

  /** A click on an entry's value control: rate or renew its source block. */
  private _onImportanceControl(lineId: string, action: string): void {
    const target = this._importanceTargets.get(lineId)
    if (!target || !this._canRateSalience()) return
    const score = this.sourceSalienceScores?.get(sourceScoreKey(target.documentId, target.blockId))
    if (action === 'renew') {
      if (!canRenewFreshness(score)) return
      this.dispatchEvent(
        new CustomEvent<SalienceRenewRequestDetail>(SALIENCE_RENEW_REQUEST_EVENT, {
          bubbles: true,
          composed: true,
          detail: { blockId: target.blockId, documentId: target.documentId },
        }),
      )
      return
    }
    const importance = action === 'importance' ? nextImportance(score) : score?.userImportance ?? null
    const valence = action === 'valence' ? nextValence(score) : score?.userValence ?? null
    if (action !== 'importance' && action !== 'valence') return
    this.dispatchEvent(
      new CustomEvent<SalienceRateRequestDetail>(SALIENCE_RATE_REQUEST_EVENT, {
        bubbles: true,
        composed: true,
        detail: { blockId: target.blockId, documentId: target.documentId, importance, valence },
      }),
    )
  }

  private renderSalienceGutter(): TemplateResult | typeof nothing {
    if (this.originalFileView?.active || !this.salienceOverlayOpen || !this.salienceOverlayBlockId) return nothing
    const blockId = this.salienceOverlayBlockId
    // A rating she just made counts at once: the bundle catches up later, and
    // a second click computed from the old bundle would undo the first (flag,
    // then valence, used to drop the flag).
    const bundled = this.salienceBundle?.scores.get(blockId)
    const pending = this._pendingRatings.get(blockId)
    const score: BlockScore | undefined = pending
      ? { ...(bundled ?? emptyBlockScore(blockId)), userImportance: pending.importance, userValence: pending.valence }
      : bundled
    const canRate = this.documentAccess?.salienceWritable ?? !(this.documentAccess?.readOnly ?? false)
    const writeReason = this.documentAccess?.salienceWriteReason?.trim()
      || 'Rating requires writable graph access and an online cell.'
    const rate = (importance: number | null, valence: number | null): void => {
      if (!canRate) return
      this._pendingRatings.set(blockId, { importance, valence })
      this.requestUpdate()
      this.dispatchEvent(
        new CustomEvent<SalienceRateRequestDetail>(SALIENCE_RATE_REQUEST_EVENT, {
          bubbles: true,
          composed: true,
          detail: { blockId, importance, valence },
        }),
      )
    }
    const renew = (): void => {
      if (!canRate || !canRenewFreshness(score)) return
      this.dispatchEvent(
        new CustomEvent<SalienceRenewRequestDetail>(SALIENCE_RENEW_REQUEST_EVENT, {
          bubbles: true,
          composed: true,
          detail: { blockId },
        }),
      )
    }
    return html`<div
      class="salience-gutter"
      style="left: ${this.salienceOverlayAnchor.x}px; top: ${this.salienceOverlayAnchor.y}px"
      @mouseenter=${this._handleSalienceOverlayMouseEnter}
      @mouseleave=${this._handleSalienceOverlayMouseLeave}
    >
      <button
        type="button"
        class=${classMap({ 'salience-gutter-icon': true, 'salience-gutter-icon--scored': !!score })}
        title="Composite score"
        aria-label="Composite score"
        aria-expanded=${this.salienceOverlayExpanded ? 'true' : 'false'}
        @click=${() => { this.salienceOverlayExpanded = !this.salienceOverlayExpanded }}
      >${salienceIcon(signalIcon(score))}</button>
      <button
        type="button"
        class=${classMap({ 'salience-gutter-icon': true, 'salience-gutter-icon--active': hasUserImportance(score) })}
        title=${canRate ? `Importance: ${importanceLabel(score)} — click to change your rating; ⌥-click to mark it as not mattering` : writeReason}
        aria-label=${canRate ? `Importance: ${importanceLabel(score)}, your rating` : writeReason}
        ?disabled=${!canRate}
        @click=${(event: MouseEvent) => rate(event.altKey ? FORGET_IMPORTANCE : nextImportance(score), score?.userValence ?? null)}
      >${salienceIcon(importanceIcon(score))}${isVeryImportant(score) ? salienceIcon(importanceIcon(score)) : nothing}</button>
      <button
        type="button"
        class=${classMap({ 'salience-gutter-icon': true, 'salience-gutter-icon--active': (score?.userValence ?? null) !== null })}
        title=${canRate ? `Valence: ${valenceLabel(score)} — click to change your rating` : writeReason}
        aria-label=${canRate ? `Valence: ${valenceLabel(score)}, your rating` : writeReason}
        ?disabled=${!canRate}
        @click=${() => rate(score?.userImportance ?? null, nextValence(score))}
      >${salienceIcon(valenceIcon(score))}</button>
      <button
        type="button"
        class="salience-gutter-icon salience-gutter-renew"
        data-salience-renew
        title=${canRate ? renewLabel(score) : writeReason}
        aria-label=${canRate ? renewLabel(score) : writeReason}
        ?disabled=${!canRate || !canRenewFreshness(score)}
        @click=${renew}
      >${salienceIcon('refresh-cw')}</button>
      ${this.salienceOverlayExpanded
        ? html`<div class="salience-gutter-numbers">
            <div>composite ${(score?.compositeScore ?? 0).toFixed(2)}</div>
            <div>importance ${combinedImportance(score) === 0 ? '–' : combinedImportance(score).toFixed(2)}</div>
            <div>valence ${combinedValence(score) === 0 ? '–' : combinedValence(score).toFixed(2)}</div>
            <div>valued ${lastValuedLabel(score) ?? '–'}</div>
          </div>`
        : nothing}
    </div>`
  }

  private renderWireRadialOverlay(): TemplateResult | typeof nothing {
    // A null wireOverlayBlockId is the DOCUMENT level, not "closed" — the open
    // flag is the gate. Reading the id as the gate is what would have kept the
    // doc-level fan unreachable even once every other piece of it existed.
    if (this.originalFileView?.active || !this.wireOverlayOpen) return nothing
    const graphId = this.hostState?.graphId ?? ''
    const documentId = this.hostState?.documentId ?? ''
    const wires = this._wiresForBlock(this.wireOverlayBlockId)
    if (wires.length === 0) return nothing
    return html`<mn-wire-radial-overlay
      .anchorX=${this.wireOverlayAnchor.x}
      .anchorY=${this.wireOverlayAnchor.y}
      .wires=${wires}
      .outgoingWireIds=${new Set((this.wireBundle?.outgoingWires ?? []).map((wire) => wire.id))}
      .suggestions=${[]}
      .contexts=${this.wireRadialContexts}
      .graphId=${graphId}
      .localGraphId=${graphId}
      .localDocumentId=${documentId}
      .localTitle=${documentId || 'Untitled'}
      @overlay-mouse-enter=${this._handleWireOverlayMouseEnter}
      @overlay-mouse-leave=${this._handleWireOverlayMouseLeave}
      @overlay-navigate=${() => this._closeWireOverlay()}
      @mn-wire-radial-navigate=${(event: CustomEvent<WireRadialNavigateDetail>) => this._handleWireRadialNavigate(event.detail)}
      @mn-wire-radial-suggestion=${(event: CustomEvent<WireRadialSuggestionDetail>) => this._handleWireRadialSuggestion(event.detail)}
      @mn-wire-radial-pin=${(event: CustomEvent<WirePinWireRequestDetail>) => this._handleWireRadialPin(event.detail)}
    ></mn-wire-radial-overlay>`
  }

  /**
   * The honest labelled placeholder body — reflects the REAL binding state
   * verbatim, never faked editor content. Strings ARE the no-mock contract made
   * literal; the live ProseMirror/CRDT body is a deferred real-infra iteration.
   */
  private renderPlaceholder(): TemplateResult {
    const s = this.hostState
    if (!s) {
      return html`<div class="placeholder" data-inert data-mode="no-binding">
        editor host mounted — no binding (ProseMirror body not yet lifted)
      </div>`
    }
    if (s.status === 'error') {
      return html`<div class="placeholder" data-inert data-mode="error">
        editor host — error: ${s.error ?? ''}
      </div>`
    }
    if (s.status === 'loading') {
      return html`<div class="placeholder" data-inert data-mode="loading">
        editor host — loading ${s.documentId ?? ''}…
      </div>`
    }
    // idle or ready
    const ref =
      s.centerMode === 'document' && (s.graphId || s.documentId)
        ? html`<span class="doc-ref" data-graph=${s.graphId ?? ''} data-document=${s.documentId ?? ''}
            >${s.graphId ?? ''} / ${s.documentId ?? ''}</span
          >`
        : nothing
    return html`<div class="placeholder" data-inert data-mode=${s.status} data-center=${s.centerMode}>
      editor host ready — ProseMirror body not yet lifted${ref}
    </div>`
  }

  private _onZoomCrumbClick(blockId: string | null, index: number): void {
    if (!this._editorHandle) return
    if (index === 0) {
      this._editorHandle.zoomOut()
    } else if (blockId) {
      this._editorHandle.zoomToAncestor(blockId)
    } else {
      return
    }
    this._editor?.commands.focus()
  }

  private _paintZoomBreadcrumb(): void {
    const nav = this.renderRoot?.querySelector('.zoom-breadcrumb') as HTMLElement | null
    if (!nav) return
    if (this.originalFileView?.active) {
      nav.hidden = true
      nav.replaceChildren()
      return
    }
    const crumbs = this.zoomSnapshot.breadcrumb
    nav.replaceChildren()
    nav.hidden = crumbs.length === 0
    if (crumbs.length === 0) return

    const doc = this.ownerDocument
    crumbs.forEach((crumb, index) => {
      if (index > 0) {
        const sep = doc.createElement('span')
        sep.className = 'zoom-breadcrumb-sep'
        sep.setAttribute('aria-hidden', 'true')
        sep.textContent = '>'
        nav.appendChild(sep)
      }

      const isLast = index === crumbs.length - 1
      if (isLast) {
        const current = doc.createElement('span')
        current.className = 'zoom-breadcrumb-current'
        current.setAttribute('aria-current', 'page')
        current.textContent = crumb.text
        nav.appendChild(current)
      } else {
        const button = doc.createElement('button')
        button.type = 'button'
        button.className = 'zoom-breadcrumb-crumb'
        button.title = `Zoom to ${crumb.text}`
        button.textContent = crumb.text
        button.addEventListener('click', () => this._onZoomCrumbClick(crumb.blockId, index))
        nav.appendChild(button)
      }
    })
  }

  private _topLevelGutterBlockForEvent(event: MouseEvent): HTMLElement | null {
    const target =
      event.target instanceof HTMLElement
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null
    const editorRoot = this.renderRoot?.querySelector('.editor-mount .ProseMirror') as HTMLElement | null
    if (!target || !editorRoot || !this.renderRoot.contains(target)) return null

    let block = target.closest('[data-block-id]') as HTMLElement | null
    while (block && block.parentElement !== editorRoot) {
      const parentBlock = block.parentElement?.closest('[data-block-id]') as HTMLElement | null
      if (!parentBlock || !editorRoot.contains(parentBlock)) break
      block = parentBlock
    }

    if (!block || block.parentElement !== editorRoot) return null
    if (!block.matches('p, h1, h2, h3, li, .image-block, mn-calendar-event, blockquote, .code-block-wrapper')) return null
    return block
  }

  private _gutterHitForEvent(event: MouseEvent): { readonly block: HTMLElement; readonly zone: 'fold' | 'wire' } | null {
    const block = this._topLevelGutterBlockForEvent(event)
    if (!block) return null

    const rect = block.getBoundingClientRect()
    const clickX = event.clientX - rect.left
    // Numbered items and bullets sit in from the paragraph gutter, so their
    // bubble is further right and the hotspot reaches it.
    const hotspotWidth = block.matches('li[data-list-type="ordered"], li[data-list-type="bullet"]') ? 40 : 28
    if (clickX < 0 || clickX >= hotspotWidth) return null

    const isParent =
      block.classList.contains('outliner-has-children') ||
      block.classList.contains('outliner-collapsed') ||
      block.getAttribute('data-collapsed') === 'true'
    const foldWidth = 18
    if (isParent && clickX < foldWidth) return { block, zone: 'fold' }

    return { block, zone: 'wire' }
  }

  /**
   * The value gutter's own hit-test — the RIGHT edge, independent of
   * `_gutterHitForEvent`'s left-edge fold/wire zones (per the Valuation UI
   * design doc: "wires are on the left"). Same 24px hotspot width and same
   * top-level-block resolution the OG's ValuationController used.
   */

  private _blockPosForId(blockId: string): number | null {
    const doc = this._editor?.state.doc
    if (!doc) return null
    let found: number | null = null
    doc.descendants((node, pos) => {
      if (found !== null) return false
      const id = node.attrs?.['data-block-id']
      if (id === blockId) {
        found = pos
        return false
      }
      return undefined
    })
    return found
  }

  private _imageBlockFromEvent(event: MouseEvent): HTMLElement | null {
    const target =
      event.target instanceof HTMLElement
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null
    if (!target || !this.renderRoot.contains(target)) return null
    return target.closest('.image-block[data-block-id]') as HTMLElement | null
  }

  private _clearImageHoverTimer(): void {
    if (!this._imageHoverLeaveTimer) return
    clearTimeout(this._imageHoverLeaveTimer)
    this._imageHoverLeaveTimer = null
  }

  private _clearImageHover(): void {
    this._clearImageHoverTimer()
    this.hoveredImageBlockId = null
    this.hoveredImageRect = null
    this._paintImageResizeButton()
  }

  private _onImageMouseOver(event: MouseEvent): void {
    const imageBlock = this._imageBlockFromEvent(event)
    if (!imageBlock) return
    this._clearImageHoverTimer()
    const blockId = imageBlock.getAttribute('data-block-id')
    if (!blockId) return
    this.hoveredImageBlockId = blockId
    this.hoveredImageRect = imageBlock.getBoundingClientRect()
    this._paintImageResizeButton()
  }

  private _onImageMouseOut(event: MouseEvent): void {
    const imageBlock = this._imageBlockFromEvent(event)
    if (!imageBlock) return
    const related = event.relatedTarget
    if (related instanceof Node && imageBlock.contains(related)) return
    this._clearImageHoverTimer()
    this._imageHoverLeaveTimer = setTimeout(() => this._clearImageHover(), 300)
  }

  private _cycleImageSize(blockId: string): void {
    const editor = this._editor
    const doc = editor?.state.doc
    const tr = editor?.state.tr
    if (!editor || !doc || !tr || !editor.view) return

    const matches: Array<{ readonly pos: number; readonly node: RawDocNode }> = []
    doc.descendants((node, pos) => {
      if (node.attrs?.['data-block-id'] === blockId) {
        matches.push({ pos, node })
        return false
      }
      return undefined
    })
    const match = matches[0]
    if (!match) return

    const sizes: readonly EditorImageSize[] = ['large', 'small', 'medium']
    const current = typeof match.node.attrs?.size === 'string' ? match.node.attrs.size : 'large'
    const idx = sizes.indexOf(current as EditorImageSize)
    const next = sizes[(idx + 1) % sizes.length]
    editor.view.dispatch(tr.setNodeMarkup(match.pos, null, { ...(match.node.attrs ?? {}), size: next }))
    editor.commands.focus()

    requestAnimationFrame(() => {
      if (this.hoveredImageBlockId !== blockId) return
      const imageBlock = this._findBlockElement(blockId)
      if (imageBlock?.classList.contains('image-block')) {
        this.hoveredImageRect = imageBlock.getBoundingClientRect()
        this._paintImageResizeButton()
      }
    })
  }

  private _toggleFoldFromGutter(block: HTMLElement, event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    const blockId = block.getAttribute('data-block-id')
    if (!blockId) return
    const pos = this._blockPosForId(blockId)
    if (pos === null) return
    if (this._editor?.commands.toggleCollapseAt(pos)) {
      this._editor.commands.focus()
    }
  }

  private _zoomFromGutter(block: HTMLElement, event: MouseEvent): void {
    const blockId = block.getAttribute('data-block-id')
    if (!blockId) return
    event.preventDefault()
    event.stopPropagation()
    this._editorHandle?.zoomIntoBlock(blockId)
    this._editor?.commands.focus()
  }

  private _onEditorGutterMouseDown(event: MouseEvent): void {
    if (!event.shiftKey) return
    const hit = this._gutterHitForEvent(event)
    if (!hit || hit.zone !== 'wire') return
    this._zoomFromGutter(hit.block, event)
  }

  /**
   * ProseMirror resolves pointer carets through `document.caret*FromPoint`.
   * In Chromium that lookup stops at this shadow host unless the shadow root is
   * passed explicitly, so a click in a later paragraph can leave the selection
   * in the heading. The mature Platform editor avoided the issue by rendering
   * in light DOM; Shrubbery keeps encapsulation and repairs the browser boundary
   * after ProseMirror's own click handler has run.
   *
   * Only an unmodified, primary, single click with a collapsed selection is
   * corrected. Drag selection, double-click word selection, gutter controls and
   * node-view controls remain owned by ProseMirror/their dedicated handlers.
   */
  private _onEditorTextClick(event: MouseEvent): void {
    if (
      event.button !== 0 ||
      event.detail !== 1 ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      this.originalFileView?.active ||
      this._effectiveReadOnly()
    ) return

    const editor = this._editor
    const view = editor?.view
    const editorRoot = view?.dom
    const shadowRoot = this.shadowRoot
    if (!editor || !view || !editorRoot || !shadowRoot || editor.state.selection.empty === false) return
    if (editorRoot.getAttribute('contenteditable') === 'false') return
    if (this._gutterHitForEvent(event)) return

    if (event.composedPath().some(
      node => node instanceof Element && node.matches(EDITOR_CARET_BLOCKED_SELECTOR),
    )) return

    if (this._caretToBlockEndForClick(event, editorRoot)) {
      editor.commands.focus()
      return
    }

    const caret = this._shadowCaretFromPoint(event.clientX, event.clientY, shadowRoot, editorRoot)
    if (!caret || !editorRoot.contains(caret.offsetNode)) return

    try {
      const position = view.posAtDOM(caret.offsetNode, caret.offset, -1)
      if (!Number.isFinite(position)) return
      if (editor.commands.setTextSelection(position)) editor.commands.focus()
    } catch {
      // A transient node-view rerender can detach the caret node between lookup
      // and mapping. ProseMirror's original click result remains the safe fallback.
    }
  }

  /**
   * A click in the empty space to the right of a text block's last line puts
   * the caret at the block's end (Eschaton, 2026-10-14). The caret lookup
   * below cannot be trusted for it: on a wrapped block in WebKit, a point in
   * the line gap or the block's bottom padding resolves to another line, or to
   * nothing. "Right of the last line" means: right of where the block's text
   * ends, at or below that line's top, and inside the block.
   *
   * Returns true when it placed the caret.
   */
  private _caretToBlockEndForClick(event: MouseEvent, editorRoot: HTMLElement): boolean {
    const editor = this._editor
    const view = editor?.view
    if (!editor || !view?.coordsAtPos) return false
    const target = event.composedPath()[0]
    if (!(target instanceof Element) || !editorRoot.contains(target)) return false
    // The click lands on the text block itself, or on a list item's padding
    // around its paragraph.
    const block = target.closest(TEXT_BLOCK_SELECTOR)
      ?? (target.matches('li') ? target.querySelector(':scope > p') : null)
    if (!(block instanceof HTMLElement) || !editorRoot.contains(block)) return false
    const rect = block.getBoundingClientRect()
    const { clientX: x, clientY: y } = event
    const container = target.matches('li') ? target.getBoundingClientRect() : rect
    if (x < rect.left || x > container.right || y < container.top || y > container.bottom) return false
    let end: number
    try {
      end = view.posAtDOM(block, block.childNodes.length)
    } catch {
      return false
    }
    const lastLine = view.coordsAtPos(end)
    if (y < lastLine.top - 1 || x <= lastLine.right) return false
    return editor.commands.setTextSelection(end)
  }

  private _shadowCaretFromPoint(
    x: number,
    y: number,
    shadowRoot: ShadowRoot,
    editorRoot: HTMLElement,
  ): ShadowCaretPoint | null {
    const caretDocument = this.ownerDocument as unknown as ShadowCaretDocument

    if (typeof caretDocument.caretPositionFromPoint === 'function') {
      try {
        const caret = caretDocument.caretPositionFromPoint(x, y, { shadowRoots: [shadowRoot] })
        if (caret && editorRoot.contains(caret.offsetNode)) return caret
      } catch {
        // Older engines expose the two-argument signature only.
      }
      try {
        const caret = caretDocument.caretPositionFromPoint(x, y)
        if (caret && editorRoot.contains(caret.offsetNode)) return caret
      } catch {
        // Continue to WebKit and geometry fallbacks.
      }
    }

    if (typeof caretDocument.caretRangeFromPoint === 'function') {
      try {
        const range = caretDocument.caretRangeFromPoint(x, y)
        if (range && editorRoot.contains(range.startContainer)) {
          return { offsetNode: range.startContainer, offset: range.startOffset }
        }
      } catch {
        // Continue to the engine-independent text geometry fallback.
      }
    }

    const pointElement = shadowRoot.elementFromPoint?.(x, y)
    if (!pointElement || !editorRoot.contains(pointElement)) return null
    const textContainer = pointElement.closest(
      'p, h1, h2, h3, blockquote, li, pre, td, th, [data-block-id]',
    ) ?? pointElement
    if (!editorRoot.contains(textContainer) || textContainer.matches(EDITOR_CARET_BLOCKED_SELECTOR)) return null
    return this._caretFromTextGeometry(textContainer, x, y)
  }

  private _caretFromTextGeometry(container: Element, x: number, y: number): ShadowCaretPoint | null {
    const win = this.ownerDocument.defaultView
    if (!win) return null
    const walker = this.ownerDocument.createTreeWalker(container, win.NodeFilter.SHOW_TEXT)
    let best: { readonly point: ShadowCaretPoint; readonly distance: number } | null = null
    let node = walker.nextNode()
    while (node) {
      const text = node.textContent ?? ''
      const parent = node.parentElement
      if (text && parent && !parent.closest('[contenteditable="false"]')) {
        const rtl = win.getComputedStyle(parent).direction === 'rtl'
        for (let offset = 0; offset < text.length; offset += 1) {
          const range = this.ownerDocument.createRange()
          range.setStart(node, offset)
          range.setEnd(node, offset + 1)
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width === 0 && rect.height === 0) continue
            const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
            const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
            const distance = (dy * dy * 4) + (dx * dx)
            const midpoint = rect.left + (rect.width / 2)
            const caretOffset = rtl
              ? (x > midpoint ? offset : offset + 1)
              : (x < midpoint ? offset : offset + 1)
            if (!best || distance < best.distance) {
              best = { point: { offsetNode: node, offset: caretOffset }, distance }
            }
          }
        }
      }
      node = walker.nextNode()
    }
    return best?.point ?? null
  }

  private _onEditorWireClick(event: MouseEvent): void {
    const hit = this._gutterHitForEvent(event)
    if (!hit) return

    if (hit.zone === 'fold') {
      this._toggleFoldFromGutter(hit.block, event)
      return
    }

    const { block } = hit
    const blockId = block.getAttribute('data-block-id')
    if (!blockId) return

    if (event.shiftKey) {
      this._zoomFromGutter(block, event)
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const baseDetail = {
      graphId: this.hostState?.graphId ?? null,
      documentId: this.hostState?.documentId ?? null,
      blockId,
      clientX: event.clientX,
      clientY: event.clientY,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    }
    // The block's existing wires are browsed in the hover fan; a click is
    // for acting on the block.
    this.dispatchEvent(
      new CustomEvent<BlockBubbleRequestDetail>(BLOCK_BUBBLE_REQUEST_EVENT, {
        bubbles: true,
        composed: true,
        detail: baseDetail,
      }),
    )
  }

  override render(): TemplateResult {
    // Graduate from the honest placeholder to a live body ONLY when an open
    // provider is present on a ready document center. Every other state stays the
    // honest labelled placeholder (no-binding/error/loading/idle-no-provider).
    return this._wantsLiveBody ? this.renderLiveBody() : this.renderPlaceholder()
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sh-editor-host': ShEditorHost
  }
}
