/**
 * mn-pdf-reader — controlled PDF reading and annotation surface.
 *
 * Rulings baked into the contract: ONE shared annotation layer per PDF, an
 * original-first reader (the shell renders page images; this component never
 * rasterizes), and v1 annotation kinds = highlight + anchored note.
 *
 * BACKEND-FREE / CONTROLLED, like every mn-* component: the caller (the organism
 * shell) owns the bytes, the page model, the annotation store, and all writes.
 * This component NEVER fetches, never writes, never imports a PDF engine, and
 * knows nothing about MCP. It receives all state as props and emits intents:
 *
 *   mn-pdf-page-visible      { pageNumber }           — a page scrolled into view (lazy render hook)
 *   mn-pdf-page-change       { pageNumber }           — scroll-driven current-page changes
 *   mn-pdf-selection         MnPdfSelectionDetail|null — text selected in the text layer (null = cleared)
 *   mn-pdf-highlight         MnPdfAnnotateDetail       — Highlight clicked with a live selection
 *   mn-pdf-note              MnPdfAnnotateDetail       — Note clicked with a live selection
 *   mn-pdf-annotation-select { annotationId, annotation }
 *   mn-pdf-zoom-change       { zoom, mode }            — zoom in / out / fit-width
 *   mn-pdf-reload            { filename }
 *   mn-pdf-download          { filename }
 *   mn-pdf-open-external     { filename }
 *
 * It does NOT create annotations itself: Highlight/Note only fire while a valid
 * selection exists and canAnnotate is set; the shell turns the intent into a
 * stored annotation and feeds it back through the `annotations` prop.
 *
 * The geometry math (DOM client rects → page-space quads, scroll → page number,
 * fit-width scale) lives in the small PURE helpers exported below so the unit
 * tests can exercise them without a layout engine.
 */

import { LitElement, css, html, nothing, unsafeCSS, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { repeat } from 'lit/directives/repeat.js'
import { SkinAware } from './skin-aware.js'
import { icon, iconStyles } from './icons.js'
import './mn-empty-state.js'
import './mn-loading.js'

/* ------------------------------------------------------------------ model */

export type MnPdfReaderStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Which surface a PDF source shows: the rendered original (mn-pdf-reader) or
 * the shared annotation list (mn-pdf-annotation-view). Host surfaces read
 * this off the controlled view state; absent means 'original'.
 */
export type MnPdfSurfaceMode = 'original' | 'annotations'

/**
 * Grouped controlled view state, for host surfaces (mn-original-viewer,
 * mn-artifact-view) that pass a shell controller's snapshot straight through
 * to an embedded <mn-pdf-reader>. Mirrors the component's props one-to-one.
 */
export interface MnPdfReaderView {
  readonly status: MnPdfReaderStatus
  readonly mode?: MnPdfSurfaceMode
  readonly error?: string
  readonly annotationError?: string
  readonly title?: string
  readonly filename?: string
  readonly mimeType?: string
  readonly pages: readonly MnPdfPage[]
  readonly annotations: readonly MnPdfAnnotation[]
  readonly activeAnnotationId?: string
  readonly canAnnotate: boolean
  readonly downloadable: boolean
  readonly externalOpenable: boolean
  readonly zoom: number
  readonly pageNumber: number
}

/** One text run of a page, in PAGE-SPACE units (unscaled PDF coordinates). */
export interface MnPdfTextItem {
  readonly id: string
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * One PDF page. `width`/`height` are page-space units; the reader scales them
 * by `zoom` and sizes every page box immediately (aspect-correct placeholder)
 * whether or not the shell has handed over `imageUrl` yet.
 */
export interface MnPdfPage {
  readonly pageNumber: number
  readonly label?: string
  readonly width: number
  readonly height: number
  readonly imageUrl?: string
  readonly textItems: readonly MnPdfTextItem[]
}

/** A page-space rectangle: [x, y, width, height]. */
export type MnPdfRect = [number, number, number, number]

/** One annotation in the shared layer. `rects` are page-space. */
export interface MnPdfAnnotation {
  readonly id: string
  readonly pageNumber: number
  readonly label?: string
  readonly quote: string
  readonly note?: string
  readonly color?: string
  readonly kind?: 'highlight' | 'note'
  readonly source?: 'reader' | 'embedded'
  readonly rects: readonly MnPdfRect[]
}

/* ------------------------------------------------------------------ intents */

export interface MnPdfPageVisibleDetail {
  readonly pageNumber: number
}

export interface MnPdfPageChangeDetail {
  readonly pageNumber: number
}

/** A live text selection anchored to a page, with page-space quad geometry. */
export interface MnPdfSelectionDetail {
  readonly pageNumber: number
  readonly exact: string
  readonly prefix: string
  readonly suffix: string
  readonly quads: readonly MnPdfRect[]
}

export type MnPdfAnnotateMode = 'highlight' | 'note'

export interface MnPdfAnnotateDetail extends MnPdfSelectionDetail {
  readonly mode: MnPdfAnnotateMode
}

export interface MnPdfAnnotationSelectDetail {
  readonly annotationId: string
  readonly annotation: MnPdfAnnotation
}

export type MnPdfZoomMode = 'in' | 'out' | 'fit-width'

export interface MnPdfZoomChangeDetail {
  readonly zoom: number
  readonly mode: MnPdfZoomMode
}

export interface MnPdfFileIntentDetail {
  readonly filename: string
}

/* --------------------------------------------------------- pure geometry */

/** A DOM-side rectangle (DOMRect / DOMRectReadOnly both fit this shape). */
export interface MnPdfBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export const PDF_MIN_ZOOM = 0.25
export const PDF_MAX_ZOOM = 5
export const PDF_ZOOM_STEP = 1.2
/** Vertical gap between page boxes (kept in sync with the .pdf-pages CSS). */
export const PDF_PAGE_GAP = 18
/** Top padding of the pages column (kept in sync with the .pdf-pages CSS). */
export const PDF_PAGE_PADDING = 24
/** Horizontal padding of the pages column (both sides) for fit-width math. */
export const PDF_PAGE_PADDING_X = 36

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Clamp a zoom factor into the supported range; non-positive/non-finite → 1. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return round3(Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom)))
}

/**
 * Convert DOM client rects (e.g. from Range.getClientRects()) into page-space
 * quads, relative to the page element's own client box and the current scale.
 * Zero-area rects (collapsed carets, trailing line-end artifacts) are dropped.
 */
export function clientRectsToPageQuads(
  rects: ArrayLike<MnPdfBox>,
  pageBox: MnPdfBox,
  scale: number,
): MnPdfRect[] {
  const s = scale > 0 ? scale : 1
  const out: MnPdfRect[] = []
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (!r || r.width <= 0 || r.height <= 0) continue
    out.push([
      round3((r.left - pageBox.left) / s),
      round3((r.top - pageBox.top) / s),
      round3(r.width / s),
      round3(r.height / s),
    ])
  }
  return out
}

/**
 * Which page owns the viewport middle for a continuous scroll column. Pure
 * function of the page model (heights × scale, gap, top padding) — no DOM
 * measurement, so it holds in any layout engine.
 */
export function pageNumberAtScroll(
  pages: ReadonlyArray<Pick<MnPdfPage, 'pageNumber' | 'height'>>,
  scale: number,
  scrollTop: number,
  viewportHeight: number,
  gap: number = PDF_PAGE_GAP,
  padding: number = PDF_PAGE_PADDING,
): number | null {
  if (pages.length === 0) return null
  const s = scale > 0 ? scale : 1
  const target = Math.max(0, scrollTop) + Math.max(0, viewportHeight) / 2
  let top = padding
  for (const page of pages) {
    const bottom = top + page.height * s
    if (bottom >= target) return page.pageNumber
    top = bottom + gap
  }
  return pages[pages.length - 1]?.pageNumber ?? null
}

/** scrollTop that brings a page's top edge to the top of the scroll column. */
export function pageScrollTop(
  pages: ReadonlyArray<Pick<MnPdfPage, 'pageNumber' | 'height'>>,
  scale: number,
  pageNumber: number,
  gap: number = PDF_PAGE_GAP,
  padding: number = PDF_PAGE_PADDING,
): number {
  const s = scale > 0 ? scale : 1
  let top = padding
  for (const page of pages) {
    if (page.pageNumber === pageNumber) return top
    top += page.height * s + gap
  }
  return 0
}

/**
 * Scale that fits the widest page to the scroll viewport's content width.
 * Returns null when it cannot be computed yet (no pages, zero-width viewport —
 * e.g. a headless environment), in which case no fit-width intent is emitted.
 */
export function fitWidthScale(
  maxPageWidth: number,
  containerWidth: number,
  paddingX: number = PDF_PAGE_PADDING_X,
): number | null {
  const available = containerWidth - paddingX
  if (maxPageWidth <= 0 || !Number.isFinite(available) || available <= 0) return null
  return clampZoom(available / maxPageWidth)
}

/** How much context the selection intent carries on each side of the quote. */
const CONTEXT_CHARS = 40

let nextPdfReaderSelectionId = 0

/* --------------------------------------------------------------- component */

@customElement('mn-pdf-reader')
export class MnPdfReader extends SkinAware(LitElement) {
  static styles = css`
    ${unsafeCSS(iconStyles)}

    :host {
      display: flex;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      color: var(--mn-color-text-primary, #111827);
      background: var(--mn-color-surface-base, #fff);
      font-family: var(--mn-font-chrome, system-ui, sans-serif);
      font-size: var(--mn-text-sm, 13px);
    }

    .root {
      display: flex;
      width: 100%;
      min-width: 0;
      min-height: 0;
      flex-direction: column;
      container-type: inline-size;
    }

    .toolbar {
      display: flex;
      min-height: 54px;
      flex: 0 0 auto;
      align-items: center;
      gap: var(--mn-space-3, 12px);
      padding: var(--mn-space-3, 12px) var(--mn-space-4, 16px);
      border-bottom: 1px solid var(--mn-color-border-default, #d1d5db);
      background: var(--mn-color-panel-bg, rgba(255, 255, 255, 0.94));
      box-sizing: border-box;
    }

    .title-wrap {
      min-width: 0;
      flex: 1 1 auto;
    }

    /* The title and meta are spans: an ellipsis needs a block box, or a long
       imported file name runs under the controls (Eschaton, 2026-11-18). */
    .title,
    .meta,
    .annotation-error {
      display: block;
    }

    .title {
      overflow: hidden;
      color: var(--mn-color-text-primary, #111827);
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta {
      margin-top: 2px;
      overflow: hidden;
      color: var(--mn-color-text-tertiary, #6b7280);
      font-size: var(--mn-text-xs, 12px);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .annotation-error {
      margin-top: 2px;
      overflow: hidden;
      color: var(--mn-color-text-danger, #b91c1c);
      font-size: var(--mn-text-xs, 12px);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .page-indicator {
      flex: 0 0 auto;
      color: var(--mn-color-text-secondary, #374151);
      font-size: var(--mn-text-xs, 12px);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .actions {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      gap: var(--mn-space-2, 8px);
    }

    .zoom-label {
      min-width: 44px;
      color: var(--mn-color-text-secondary, #374151);
      font-size: var(--mn-text-xs, 12px);
      font-variant-numeric: tabular-nums;
      text-align: center;
    }

    button {
      display: inline-flex;
      min-height: 30px;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 0 10px;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-control, 6px);
      background: var(--mn-color-surface-base, #fff);
      color: var(--mn-color-text-secondary, #374151);
      cursor: pointer;
      font: inherit;
      font-size: var(--mn-text-xs, 12px);
      box-sizing: border-box;
    }

    button:hover:not(:disabled) {
      color: var(--mn-color-text-primary, #111827);
      background: var(--mn-color-surface-hover, #f3f4f6);
    }

    button:disabled {
      cursor: default;
      opacity: 0.48;
    }

    button:focus-visible {
      outline: 2px solid var(--mn-color-focus-ring, #2563eb);
      outline-offset: 1px;
    }

    .annotate-button:not(:disabled) {
      color: var(--mn-color-text-accent, #1d4ed8);
      border-color: var(--mn-color-border-accent, #93c5fd);
      background: var(--mn-color-surface-accent, #eff6ff);
    }

    .stage {
      position: relative;
      display: flex;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    .pdf-scroll {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      overflow: auto;
      background: var(--mn-color-surface-sunken, #f8fafc);
      scroll-behavior: smooth;
    }

    .pdf-pages {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: ${unsafeCSS(String(PDF_PAGE_GAP))}px;
      padding: ${unsafeCSS(String(PDF_PAGE_PADDING))}px ${unsafeCSS(String(PDF_PAGE_PADDING_X / 2))}px 36px;
      box-sizing: border-box;
    }

    .pdf-page {
      position: relative;
      flex: 0 0 auto;
      margin: 0;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      background: var(--mn-color-surface-base, #fff);
      box-shadow: var(--mn-shadow-md, 0 12px 30px rgba(31, 41, 51, 0.16));
      box-sizing: border-box;
    }

    .pdf-image {
      display: block;
      width: 100%;
      height: 100%;
    }

    .pdf-placeholder {
      display: grid;
      width: 100%;
      height: 100%;
      align-content: center;
      justify-content: center;
      gap: 8px;
      color: var(--mn-color-text-tertiary, #6b7280);
      font-size: var(--mn-text-xs, 12px);
      place-items: center;
    }

    /* The transparent text layer: real selectable spans over the page image.
       aria-hidden because the <img> alt + the annotation rail already speak;
       a screen reader must not hear the raw run dump twice. */
    .pdf-text-layer {
      position: absolute;
      inset: 0;
      overflow: hidden;
    }

    .pdf-text-layer span {
      position: absolute;
      color: transparent;
      line-height: 1;
      white-space: pre;
      transform-origin: left top;
      user-select: text;
    }

    .pdf-text-layer span::selection {
      background: var(--mn-color-selection-bg, rgba(37, 99, 235, 0.28));
      color: transparent;
    }

    .pdf-annotation-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .anno-rect {
      position: absolute;
      min-height: 0;
      padding: 0;
      border: 0;
      border-radius: 2px;
      background: var(--mn-pdf-annotation-bg, rgba(250, 204, 21, 0.38));
      cursor: pointer;
      pointer-events: auto;
      transition: background 120ms ease, box-shadow 120ms ease;
    }

    .anno-rect:hover,
    .anno-rect:focus-visible {
      background: var(--mn-pdf-annotation-bg-hover, rgba(250, 204, 21, 0.6));
    }

    .anno-rect[data-active='true'] {
      background: var(--mn-pdf-annotation-bg-active, rgba(234, 179, 8, 0.72));
      box-shadow: 0 0 0 2px var(--mn-color-focus-ring, #2563eb);
    }

    .annotation-rail {
      width: min(280px, 32vw);
      min-width: 220px;
      flex: 0 0 auto;
      overflow: auto;
      border-left: 1px solid var(--mn-color-border-default, #d1d5db);
      background: var(--mn-color-surface-raised, #fff);
      box-sizing: border-box;
    }

    .annotation-head {
      position: sticky;
      top: 0;
      padding: 10px 12px;
      border-bottom: 1px solid var(--mn-color-border-subtle, #e5e7eb);
      background: var(--mn-color-panel-bg, rgba(255, 255, 255, 0.94));
      color: var(--mn-color-text-tertiary, #6b7280);
      font-size: var(--mn-text-xs, 12px);
      font-weight: 700;
    }

    .annotation-item {
      display: flex;
      width: 100%;
      min-height: 0;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      gap: 3px;
      padding: 10px 12px;
      border: 0;
      border-bottom: 1px solid var(--mn-color-border-subtle, #e5e7eb);
      border-radius: 0;
      background: transparent;
      color: var(--mn-color-text-primary, #111827);
      text-align: left;
    }

    .annotation-item:hover {
      background: var(--mn-color-surface-hover, #f3f4f6);
    }

    .annotation-item[aria-current='true'] {
      background: var(--mn-color-surface-accent, #eff6ff);
    }

    .annotation-label {
      color: var(--mn-color-text-tertiary, #6b7280);
      font-size: var(--mn-text-xs, 12px);
      font-weight: 700;
    }

    .annotation-quote {
      color: var(--mn-color-text-primary, #111827);
      line-height: 1.35;
    }

    .annotation-note {
      color: var(--mn-color-text-secondary, #4b5563);
      font-size: var(--mn-text-xs, 12px);
      font-style: italic;
      line-height: 1.35;
    }

    .state {
      display: grid;
      flex: 1 1 auto;
      min-height: 220px;
      align-content: center;
      padding: var(--mn-space-6, 24px);
      box-sizing: border-box;
    }

    @media (prefers-reduced-motion: reduce) {
      .pdf-scroll {
        scroll-behavior: auto;
      }

      .anno-rect,
      button {
        transition: none;
      }
    }

    @container (max-width: 760px) {
      .toolbar {
        gap: var(--mn-space-2, 8px);
      }

      .meta {
        display: none;
      }

      .page-indicator {
        margin-left: auto;
      }
    }

    @media (max-width: 760px) {
      .toolbar {
        align-items: flex-start;
        flex-wrap: wrap;
      }

      .actions {
        flex-wrap: wrap;
      }

      .stage {
        flex-direction: column;
      }

      .annotation-rail {
        width: 100%;
        min-width: 0;
        max-height: 180px;
        border-left: 0;
        border-top: 1px solid var(--mn-color-border-default, #d1d5db);
      }
    }
  `

  @property({ type: String }) title = ''
  @property({ type: String }) filename = ''
  @property({ type: String }) mimeType = ''
  @property({ type: String }) status: MnPdfReaderStatus = 'idle'
  @property({ type: String }) error = ''
  @property({ type: String }) annotationError = ''
  @property({ attribute: false }) pages: readonly MnPdfPage[] = []
  @property({ attribute: false }) annotations: readonly MnPdfAnnotation[] = []
  @property({ type: String }) activeAnnotationId = ''
  @property({ type: Boolean }) canAnnotate = false
  @property({ type: Boolean }) downloadable = false
  @property({ type: Boolean }) externalOpenable = false
  @property({ type: Number }) zoom = 1
  @property({ type: Number }) pageNumber = 0

  /** Scroll-driven current page (0 = unset; falls back to the prop / page 1). */
  @state() private _currentPage = 0
  /** The live selection anchor, kept only to gate the annotate buttons. */
  @state() private _selection: MnPdfSelectionDetail | null = null

  private _observer: IntersectionObserver | null = null
  private _pendingScrollToPage = false
  private readonly _selectionId = `pdf-reader-${++nextPdfReaderSelectionId}`
  private _lightSelectionRoot: HTMLDivElement | null = null
  private _lightSelectionResizeObserver: ResizeObserver | null = null
  private _lightSelectionFrame = 0
  private _lightSelectionPages: readonly MnPdfPage[] = []
  private _lightSelectionScale = 1
  private readonly _lightSelectionListener = (): void => {
    if (this._usesLightDomSelection()) this._readSelection()
  }
  private readonly _lightPositionListener = (): void => {
    if (this._usesLightDomSelection()) this._scheduleLightSelectionSync()
  }

  /* ------------------------------------------------------------ lifecycle */

  connectedCallback(): void {
    super.connectedCallback()
    this.ownerDocument.addEventListener('mouseup', this._lightSelectionListener)
    this.ownerDocument.addEventListener('keyup', this._lightSelectionListener)
    this.ownerDocument.addEventListener('scroll', this._lightPositionListener, true)
    this.ownerDocument.defaultView?.addEventListener('resize', this._lightPositionListener)
  }

  protected willUpdate(changed: Map<string, unknown>): void {
    if (this._currentPage === 0) {
      this._currentPage = this.pageNumber || this.pages[0]?.pageNumber || 0
      this._pendingScrollToPage = this.pageNumber > 0
    }
    // Controlled current page: when the shell moves the prop somewhere the
    // scroll position hasn't reported yet, follow it (same value = our own
    // echo from mn-pdf-page-change, so no feedback loop). Done in willUpdate
    // so the indicator re-renders in the same cycle; the scroll itself waits
    // for the DOM in updated().
    if (changed.has('pageNumber') && this.pageNumber > 0 && this.pageNumber !== this._currentPage) {
      this._currentPage = this.pageNumber
      this._pendingScrollToPage = true
    }
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('pages')) this._syncObserver()
    if (this._pendingScrollToPage) {
      this._pendingScrollToPage = false
      this._scrollToPage(this.pageNumber)
    }
    if (this._usesLightDomSelection() && this.status === 'ready') {
      if (changed.has('pages') || changed.has('zoom') || changed.has('status')) {
        this._rebuildLightSelectionLayer()
      }
      this._scheduleLightSelectionSync()
    } else {
      this._removeLightSelectionLayer()
    }
  }

  disconnectedCallback(): void {
    this._observer?.disconnect()
    this._observer = null
    this.ownerDocument.removeEventListener('mouseup', this._lightSelectionListener)
    this.ownerDocument.removeEventListener('keyup', this._lightSelectionListener)
    this.ownerDocument.removeEventListener('scroll', this._lightPositionListener, true)
    this.ownerDocument.defaultView?.removeEventListener('resize', this._lightPositionListener)
    this._removeLightSelectionLayer()
    super.disconnectedCallback()
  }

  /* --------------------------------------------------------------- intents */

  private _emit<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail, bubbles: true, composed: true }))
  }

  private _reload(): void {
    this._emit<MnPdfFileIntentDetail>('mn-pdf-reload', { filename: this.filename })
  }

  private _download(): void {
    if (!this.downloadable) return
    this._emit<MnPdfFileIntentDetail>('mn-pdf-download', { filename: this.filename })
  }

  private _openExternal(): void {
    if (!this.externalOpenable) return
    this._emit<MnPdfFileIntentDetail>('mn-pdf-open-external', { filename: this.filename })
  }

  private _zoomIn(): void {
    const next = clampZoom(this._scale() * PDF_ZOOM_STEP)
    if (next !== this._scale()) this._emit<MnPdfZoomChangeDetail>('mn-pdf-zoom-change', { zoom: next, mode: 'in' })
  }

  private _zoomOut(): void {
    const next = clampZoom(this._scale() / PDF_ZOOM_STEP)
    if (next !== this._scale()) this._emit<MnPdfZoomChangeDetail>('mn-pdf-zoom-change', { zoom: next, mode: 'out' })
  }

  private _fitWidth(): void {
    const maxPageWidth = this.pages.reduce((max, page) => Math.max(max, page.width), 0)
    const fit = fitWidthScale(maxPageWidth, this._scroller()?.clientWidth ?? 0)
    if (fit != null) this._emit<MnPdfZoomChangeDetail>('mn-pdf-zoom-change', { zoom: fit, mode: 'fit-width' })
  }

  private _annotate(mode: MnPdfAnnotateMode): void {
    if (!this.canAnnotate || !this._selection) return
    this._emit<MnPdfAnnotateDetail>(mode === 'highlight' ? 'mn-pdf-highlight' : 'mn-pdf-note', {
      ...this._selection,
      mode,
    })
  }

  private _selectAnnotation(annotation: MnPdfAnnotation): void {
    this._emit<MnPdfAnnotationSelectDetail>('mn-pdf-annotation-select', {
      annotationId: annotation.id,
      annotation,
    })
  }

  /* ---------------------------------------------------- visibility + paging */

  private _scroller(): HTMLElement | null {
    return this.renderRoot?.querySelector('.pdf-scroll') ?? null
  }

  private _syncObserver(): void {
    this._observer?.disconnect()
    this._observer = null
    if (typeof IntersectionObserver === 'undefined') return
    const root = this._scroller()
    const pageEls = Array.from(this.renderRoot?.querySelectorAll('.pdf-page') ?? [])
    if (!root || pageEls.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber ?? '')
          if (Number.isFinite(pageNumber) && pageNumber > 0) {
            this._emit<MnPdfPageVisibleDetail>('mn-pdf-page-visible', { pageNumber })
          }
        }
      },
      { root, threshold: 0.05 },
    )
    for (const pageEl of pageEls) observer.observe(pageEl)
    this._observer = observer
  }

  private _onScroll(): void {
    const scroller = this._scroller()
    if (!scroller || this.pages.length === 0) return
    this._scheduleLightSelectionSync()
    const pageNumber = pageNumberAtScroll(this.pages, this._scale(), scroller.scrollTop, scroller.clientHeight)
    if (pageNumber != null && pageNumber !== this._currentPage) {
      this._currentPage = pageNumber
      this._emit<MnPdfPageChangeDetail>('mn-pdf-page-change', { pageNumber })
    }
  }

  private _scrollToPage(pageNumber: number): void {
    const scroller = this._scroller()
    if (!scroller) return
    scroller.scrollTop = pageScrollTop(this.pages, this._scale(), pageNumber)
  }

  /* -------------------------------------------------------------- selection */

  private _scale(): number {
    return this.zoom > 0 ? this.zoom : 1
  }

  private _usesLightDomSelection(): boolean {
    const root = this.shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null
    const getSelection = root?.getSelection
    return typeof getSelection !== 'function' || !getSelection.toString().includes('[native code]')
  }

  private _scheduleLightSelectionSync(): void {
    if (this._lightSelectionFrame || !this._lightSelectionRoot) return
    const view = this.ownerDocument.defaultView
    if (!view?.requestAnimationFrame) {
      this._syncLightSelectionPositions()
      return
    }
    this._lightSelectionFrame = view.requestAnimationFrame(() => {
      this._lightSelectionFrame = 0
      this._syncLightSelectionPositions()
    })
  }

  private _removeLightSelectionLayer(): void {
    const view = this.ownerDocument.defaultView
    if (this._lightSelectionFrame && view?.cancelAnimationFrame) {
      view.cancelAnimationFrame(this._lightSelectionFrame)
    }
    this._lightSelectionFrame = 0
    this._lightSelectionResizeObserver?.disconnect()
    this._lightSelectionResizeObserver = null
    this._lightSelectionRoot?.remove()
    this._lightSelectionRoot = null
    this._lightSelectionPages = []
  }

  private _rebuildLightSelectionLayer(): void {
    if (!this._usesLightDomSelection() || this.status !== 'ready') {
      this._removeLightSelectionLayer()
      return
    }
    const scale = this._scale()
    const structureUnchanged = this._lightSelectionRoot !== null
      && this._lightSelectionScale === scale
      && this._lightSelectionPages.length === this.pages.length
      && this._lightSelectionPages.every((page, index) =>
        page.pageNumber === this.pages[index]?.pageNumber && page.textItems === this.pages[index]?.textItems,
      )
    if (structureUnchanged) {
      this._syncLightSelectionPositions()
      return
    }
    const doc = this.ownerDocument
    let root = this._lightSelectionRoot
    if (!root) {
      root = doc.createElement('div')
      root.className = 'pdf-light-selection-root'
      root.dataset.pdfSelectionOwner = this._selectionId
      root.setAttribute('aria-hidden', 'true')
      root.style.cssText = 'position:fixed;overflow:hidden;pointer-events:none;z-index:1000;'
      root.addEventListener('click', (event) => {
        const selection = doc.getSelection()
        if (selection && !selection.isCollapsed) return
        const target = event.target as Element | null
        const pageEl = target?.closest('.pdf-page') as HTMLElement | null
        if (!pageEl) return
        const pageNumber = Number(pageEl.dataset.pageNumber ?? '')
        const pageBox = pageEl.getBoundingClientRect()
        const scale = this._scale()
        const x = (event.clientX - pageBox.left) / scale
        const y = (event.clientY - pageBox.top) / scale
        const annotation = this.annotations.find(candidate =>
          candidate.pageNumber === pageNumber && candidate.rects.some(rect =>
            x >= rect[0] && x <= rect[0] + rect[2] && y >= rect[1] && y <= rect[1] + rect[3],
          ),
        )
        if (annotation) {
          event.preventDefault()
          this._selectAnnotation(annotation)
        }
      })
      root.addEventListener('wheel', (event) => {
        const scroller = this._scroller()
        if (!scroller) return
        event.preventDefault()
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1
        if (typeof scroller.scrollBy === 'function') {
          scroller.scrollBy({
            top: event.deltaY * unit,
            left: event.deltaX * unit,
            behavior: 'instant',
          })
        } else {
          scroller.scrollTop += event.deltaY * unit
          scroller.scrollLeft += event.deltaX * unit
        }
        this._scheduleLightSelectionSync()
      }, { passive: false })
      doc.body.appendChild(root)
      this._lightSelectionRoot = root
      if (typeof ResizeObserver !== 'undefined') {
        this._lightSelectionResizeObserver = new ResizeObserver(() => this._scheduleLightSelectionSync())
        this._lightSelectionResizeObserver.observe(this)
        const scroller = this._scroller()
        if (scroller) this._lightSelectionResizeObserver.observe(scroller)
      }
    }
    root.replaceChildren()
    for (const page of this.pages) {
      const pageEl = doc.createElement('div')
      pageEl.className = 'pdf-page pdf-text-layer'
      pageEl.dataset.pageNumber = String(page.pageNumber)
      pageEl.dataset.pdfSelectionOwner = this._selectionId
      pageEl.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none;'
      for (const item of page.textItems) {
        const span = doc.createElement('span')
        span.dataset.textItemId = item.id
        span.textContent = item.text
        span.style.cssText = `position:absolute;left:${round3(item.x * scale)}px;top:${round3(item.y * scale)}px;font-size:${round3(item.height * scale)}px;color:transparent;line-height:1;white-space:pre;transform-origin:left top;user-select:text;pointer-events:auto;`
        pageEl.appendChild(span)
      }
      root.appendChild(pageEl)
    }
    this._lightSelectionPages = this.pages
    this._lightSelectionScale = scale
    this._syncLightSelectionPositions()
  }

  private _syncLightSelectionPositions(): void {
    const root = this._lightSelectionRoot
    const scroller = this._scroller()
    if (!root || !scroller) {
      if (root) root.style.display = 'none'
      return
    }
    const scrollerBox = scroller.getBoundingClientRect()
    root.style.display = scrollerBox.width > 0 && scrollerBox.height > 0 && scroller.isConnected && this.isConnected
      ? ''
      : 'none'
    root.style.left = `${scrollerBox.left}px`
    root.style.top = `${scrollerBox.top}px`
    root.style.width = `${scrollerBox.width}px`
    root.style.height = `${scrollerBox.height}px`
    const pageEls = this.renderRoot?.querySelectorAll('.pdf-page') ?? []
    for (const shadowPage of pageEls) {
      const pageNumber = (shadowPage as HTMLElement).dataset.pageNumber ?? ''
      const lightPage = root.querySelector(`[data-page-number="${pageNumber}"]`) as HTMLElement | null
      if (!lightPage) continue
      const pageBox = shadowPage.getBoundingClientRect()
      lightPage.style.left = `${pageBox.left - scrollerBox.left}px`
      lightPage.style.top = `${pageBox.top - scrollerBox.top}px`
      lightPage.style.width = `${pageBox.width}px`
      lightPage.style.height = `${pageBox.height}px`
    }
  }

  /** Prefer the shadow root's own selection (Chrome), fall back to document. */
  private _activeSelection(): Selection | null {
    const root = this.shadowRoot as (ShadowRoot & { getSelection?: () => Selection | null }) | null
    return root?.getSelection?.() ?? this.ownerDocument?.getSelection?.() ?? null
  }

  /** mouseup/keyup on the pages column: read whatever selection now exists. */
  private _readSelection(): void {
    const selection = this._activeSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this._clearSelection()
      return
    }
    const range = selection.getRangeAt(0)
    let node: Node | null = range.commonAncestorContainer
    if (node.nodeType === 3) node = node.parentNode
    const element = node as Element | null
    const layerEl = element?.closest?.('.pdf-text-layer')
    const pageEl = element?.closest?.('.pdf-page') as HTMLElement | null
    // Selections outside our text layer (rail, toolbar, other surfaces) are
    // not ours: leave the current state untouched.
    const ownsPage = this.renderRoot?.contains(pageEl) === true
      || pageEl?.dataset.pdfSelectionOwner === this._selectionId
    if (!layerEl || !pageEl || !ownsPage) return

    const exact = range.toString()
    if (exact.trim() === '') {
      this._clearSelection()
      return
    }
    const pageNumber = Number(pageEl.dataset.pageNumber ?? '')
    if (!Number.isFinite(pageNumber) || pageNumber <= 0) return

    const ownerDocument = this.ownerDocument
    const before = ownerDocument.createRange()
    before.selectNodeContents(layerEl)
    before.setEnd(range.startContainer, range.startOffset)
    const after = ownerDocument.createRange()
    after.selectNodeContents(layerEl)
    after.setStart(range.endContainer, range.endOffset)

    const detail: MnPdfSelectionDetail = {
      pageNumber,
      exact,
      prefix: before.toString().slice(-CONTEXT_CHARS),
      suffix: after.toString().slice(0, CONTEXT_CHARS),
      quads: clientRectsToPageQuads(range.getClientRects(), pageEl.getBoundingClientRect(), this._scale()),
    }
    this._selection = detail
    this._emit<MnPdfSelectionDetail>('mn-pdf-selection', detail)
  }

  private _clearSelection(): void {
    if (this._selection === null) return
    this._selection = null
    this._emit<MnPdfSelectionDetail | null>('mn-pdf-selection', null)
  }

  /* --------------------------------------------------------------- rendering */

  private _heading(): string {
    return this.title.trim() || this.filename.trim() || 'PDF'
  }

  private _meta(): string {
    const parts = [this.filename.trim(), this.mimeType.trim()]
    if (this.pages.length > 0) parts.push(`${this.pages.length} page${this.pages.length === 1 ? '' : 's'}`)
    return parts.filter(Boolean).join(' · ')
  }

  private _displayPage(): number {
    return this._currentPage || this.pageNumber || this.pages[0]?.pageNumber || 0
  }

  private _state(iconName: string, title: string, description: string, mood: 'neutral' | 'danger' = 'neutral'): TemplateResult {
    return html`
      <div class="state">
        <mn-empty-state
          icon=${iconName}
          title=${title}
          description=${description}
          mood=${mood}
          variant="compact"
        ></mn-empty-state>
      </div>
    `
  }

  private _renderAnnotationRects(page: MnPdfPage): TemplateResult | typeof nothing {
    const annotations = this.annotations.filter((annotation) => annotation.pageNumber === page.pageNumber)
    if (annotations.length === 0) return nothing
    const scale = this._scale()
    return html`
      <div class="pdf-annotation-layer">
        ${repeat(annotations, (annotation) => annotation.id, (annotation) => {
          const active = annotation.id === this.activeAnnotationId
          const ariaLabel = `Annotation: ${annotation.label || annotation.quote || annotation.id}`
          return annotation.rects.map(
            (rect) => html`
              <button
                type="button"
                class="anno-rect"
                data-annotation-id=${annotation.id}
                data-active=${active ? 'true' : 'false'}
                style="left:${round3(rect[0] * scale)}px;top:${round3(rect[1] * scale)}px;width:${round3(rect[2] * scale)}px;height:${round3(rect[3] * scale)}px;${annotation.color ? `background:${annotation.color};` : ''}"
                aria-label=${ariaLabel}
                @click=${() => this._selectAnnotation(annotation)}
              ></button>
            `,
          )
        })}
      </div>
    `
  }

  private _renderPage(page: MnPdfPage): TemplateResult {
    const scale = this._scale()
    const label = page.label?.trim() || `Page ${page.pageNumber}`
    const width = round3(page.width * scale)
    const height = round3(page.height * scale)
    return html`
      <figure
        class="pdf-page"
        data-page-number=${page.pageNumber}
        style="width:${width}px;height:${height}px;"
        aria-label=${label}
      >
        ${page.imageUrl
          ? html`<img class="pdf-image" src=${page.imageUrl} alt=${label} />`
          : html`<div class="pdf-placeholder">${icon('file-text', { size: 28 })}<span>${label}</span></div>`}
        ${page.textItems.length > 0
          // The layer markup stays whitespace-free between spans on purpose:
          // stray template text nodes would pollute selection prefix/suffix.
          ? html`<div class="pdf-text-layer" aria-hidden="true">${repeat(page.textItems, (item) => item.id, (item) => html`<span style="left:${round3(item.x * scale)}px;top:${round3(item.y * scale)}px;font-size:${round3(item.height * scale)}px;">${item.text}</span>`)}</div>`
          : nothing}
        ${this._renderAnnotationRects(page)}
      </figure>
    `
  }

  private _renderBody(): TemplateResult {
    if (this.status === 'loading') {
      return html`<div class="state"><mn-loading size="sm" text="Loading PDF"></mn-loading></div>`
    }
    if (this.status === 'error') {
      return this._state('alert-circle', 'PDF failed to load', this.error || 'The PDF could not be loaded.', 'danger')
    }
    if (this.status !== 'ready') {
      return this._state('file-text', 'No PDF loaded', 'No PDF is loaded in this reader yet.')
    }
    if (this.pages.length === 0) {
      return this._state('file-text', 'No pages', 'This PDF has no pages to show yet.')
    }
    return html`
      <div class="pdf-scroll" @scroll=${() => this._onScroll()} @mouseup=${() => this._readSelection()} @keyup=${() => this._readSelection()}>
        <div class="pdf-pages">
          ${repeat(this.pages, (page) => page.pageNumber, (page) => this._renderPage(page))}
        </div>
      </div>
    `
  }

  private _renderRail(): TemplateResult | typeof nothing {
    if (this.annotations.length === 0) return nothing
    return html`
      <aside class="annotation-rail" aria-label="PDF annotations">
        <div class="annotation-head">Annotations · ${this.annotations.length}</div>
        ${repeat(this.annotations, (annotation) => annotation.id, (annotation) => html`
          <button
            type="button"
            class="annotation-item"
            data-annotation-id=${annotation.id}
            aria-current=${annotation.id === this.activeAnnotationId ? 'true' : 'false'}
            @click=${() => this._selectAnnotation(annotation)}
          >
            <span class="annotation-label">${annotation.label?.trim() || `Page ${annotation.pageNumber}`}</span>
            <span class="annotation-quote">${annotation.quote}</span>
            ${annotation.note?.trim() ? html`<span class="annotation-note">${annotation.note}</span>` : nothing}
          </button>
        `)}
      </aside>
    `
  }

  render(): TemplateResult {
    const canAnnotateSelection = this.canAnnotate && this._selection !== null
    return html`
      <section class="root" role="region" aria-label="PDF reader">
        <header class="toolbar" role="toolbar" aria-label="PDF reader controls">
          ${icon('file-text', { size: 18 })}
          <span class="title-wrap">
            <span class="title" title=${this._heading()}>${this._heading()}</span>
            <span class="meta" title=${this._meta()}>${this._meta()}</span>
            ${this.annotationError.trim()
              ? html`<span class="annotation-error" role="alert" title=${this.annotationError}>${this.annotationError}</span>`
              : nothing}
          </span>
          <span class="page-indicator" aria-live="polite" aria-label="Current page">
            ${this._displayPage()} / ${this.pages.length}
          </span>
          <span class="actions">
            <button type="button" aria-label="Zoom out" @click=${() => this._zoomOut()}>
              ${icon('zoom-out', { size: 13 })}
            </button>
            <span class="zoom-label">${Math.round(this._scale() * 100)}%</span>
            <button type="button" aria-label="Zoom in" @click=${() => this._zoomIn()}>
              ${icon('zoom-in', { size: 13 })}
            </button>
            <button type="button" aria-label="Fit width" @click=${() => this._fitWidth()}>
              ${icon('maximize', { size: 13 })}
            </button>
            ${this.canAnnotate
              ? html`
                <button
                  type="button"
                  class="annotate-button"
                  aria-label="Highlight selection"
                  ?disabled=${!canAnnotateSelection}
                  @click=${() => this._annotate('highlight')}
                >
                  ${icon('highlighter', { size: 13 })} Highlight
                </button>
                <button
                  type="button"
                  class="annotate-button"
                  aria-label="Add note to selection"
                  ?disabled=${!canAnnotateSelection}
                  @click=${() => this._annotate('note')}
                >
                  ${icon('message-square', { size: 13 })} Note
                </button>
              `
              : nothing}
            <button type="button" aria-label="Reload PDF" @click=${() => this._reload()}>
              ${icon('refresh', { size: 13 })}
            </button>
            <button
              type="button"
              aria-label="Download PDF"
              ?disabled=${!this.downloadable}
              @click=${() => this._download()}
            >
              ${icon('download', { size: 13 })} Download
            </button>
            <button
              type="button"
              aria-label="Open PDF externally"
              ?disabled=${!this.externalOpenable}
              @click=${() => this._openExternal()}
            >
              ${icon('external-link', { size: 13 })}
            </button>
          </span>
        </header>
        <div class="stage">
          ${this._renderBody()}
          ${this._renderRail()}
        </div>
      </section>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-pdf-reader': MnPdfReader
  }
}
