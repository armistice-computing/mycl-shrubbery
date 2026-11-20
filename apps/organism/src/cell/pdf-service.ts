/**
 * Shared organism cell PDF service.
 *
 * The pdf.js loader used to live privately inside document-transfer.ts (the
 * browser-side import parser). The controlled PDF reader (Phase 2) needs the
 * same lazy engine load plus page enumeration, text and embedded-annotation
 * extraction, and page rasterization, so the loader moves here and document-transfer imports
 * it back — one module-level singleton, identical lazy import behavior.
 *
 * This module is the ONLY cell module that talks to pdf.js. Everything above
 * it (controllers, surfaces) works against the small structural interfaces
 * below, which keeps both harnesses and unit tests free of the real engine.
 */

import type { MnPdfRect, MnPdfTextItem } from '@shrubbery/components'

export function pdfWasmBaseUrl(): string {
  return typeof document === 'undefined' ? '/pdfjs-wasm/' : new URL('/pdfjs-wasm/', document.baseURI).href
}

/* ------------------------------------------------------------- pdf.js seam */

/** The real engine module type (legacy build, matching document-transfer). */
export type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let pdfJsPromise: Promise<PdfJsModule> | null = null

/**
 * Lazily import pdf.js + its worker exactly once per app lifetime. Moved here
 * verbatim from document-transfer.ts; both the import parser and the PDF
 * reader share the singleton.
 */
export async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs?url'),
    ]).then(([pdfjs, worker]) => {
      const maybeProcess = (globalThis as { process?: { versions?: { node?: string } } }).process
      if (worker.default) {
        const workerSrc = maybeProcess?.versions?.node && worker.default.startsWith('/@fs/')
          ? `file://${worker.default.slice('/@fs'.length)}`
          : worker.default
        if (!(maybeProcess?.versions?.node && workerSrc.startsWith('/node_modules/'))) {
          pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
        }
      }
      return pdfjs
    })
  }
  return pdfJsPromise
}

/* ------------------------------------------- structural engine interfaces */

/**
 * The narrow pdf.js surface this service uses, structural so tests can inject
 * a fake engine and callers never name pdf.js types.
 */
export interface PdfJsViewportLike {
  readonly width: number
  readonly height: number
  readonly transform?: readonly number[]
}

export interface PdfJsTextContentLike {
  readonly items: readonly unknown[]
  readonly styles?: Record<string, unknown>
  readonly lang?: string | null
}

export interface PdfJsRenderTaskLike {
  readonly promise: Promise<unknown>
}

/** An embedded highlight or sticky note, normalized for the shared reader. */
export interface PdfEmbeddedAnnotation {
  readonly id: string
  readonly kind: 'highlight' | 'note'
  readonly pageNumber: number
  readonly label?: string
  readonly note?: string
  readonly quote: string
  readonly prefix: string
  readonly suffix: string
  readonly rects: readonly MnPdfRect[]
  readonly color?: string
}

export interface PdfJsPageLike {
  getViewport(input: { readonly scale: number }): PdfJsViewportLike
  getTextContent(): Promise<PdfJsTextContentLike>
  getAnnotations?(input: { readonly intent: 'display' }): Promise<readonly unknown[]>
  streamTextContent?(): {
    getReader(): {
      read(): Promise<{ readonly done: boolean, readonly value: unknown }>
    }
  }
  render(input: {
    readonly canvasContext?: unknown
    /** pdfjs-dist ≥5 names the target `canvas`; older builds use canvasContext. */
    readonly canvas?: unknown
    readonly viewport: PdfJsViewportLike
  }): PdfJsRenderTaskLike
  cleanup?(): void
}

export interface PdfJsDocumentLike {
  readonly numPages: number
  getPage(pageNumber: number): Promise<PdfJsPageLike>
}

export interface PdfJsLoadingTaskLike {
  readonly promise: Promise<PdfJsDocumentLike>
  destroy(): Promise<void>
}

export interface PdfJsModuleLike {
  getDocument(config: Record<string, unknown>): PdfJsLoadingTaskLike
  Util?: { transform(a: readonly number[], b: readonly number[]): number[] }
}

/** Minimal canvas surface for rasterizing a page (injectable for tests). */
export interface PdfCanvasLike {
  width: number
  height: number
  getContext(contextId: '2d'): unknown
  toDataURL(type?: string): string
}

/* --------------------------------------------------------- text extraction */

interface PdfTextItemLike {
  readonly str?: unknown
  readonly transform?: unknown
  readonly width?: unknown
}

/** pdf.js Util.transform semantics: 2D affine matrix multiply (a ∘ b). */
export function transform2d(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[0] ?? 0) * (b[0] ?? 0) + (a[2] ?? 0) * (b[1] ?? 0),
    (a[1] ?? 0) * (b[0] ?? 0) + (a[3] ?? 0) * (b[1] ?? 0),
    (a[0] ?? 0) * (b[2] ?? 0) + (a[2] ?? 0) * (b[3] ?? 0),
    (a[1] ?? 0) * (b[2] ?? 0) + (a[3] ?? 0) * (b[3] ?? 0),
    (a[0] ?? 0) * (b[4] ?? 0) + (a[2] ?? 0) * (b[5] ?? 0) + (a[4] ?? 0),
    (a[1] ?? 0) * (b[4] ?? 0) + (a[3] ?? 0) * (b[5] ?? 0) + (a[5] ?? 0),
  ]
}

function numberArray(value: unknown): readonly number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : []
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Convert one page's pdf.js text content into page-space MnPdfTextItems with a
 * TOP-LEFT origin (what the DOM text layer expects): pdf.js item transforms
 * are in the page's y-up user space, so they are combined with the scale-1
 * viewport transform, and the span's top is baseline minus the scaled font
 * height. pdf.js item widths are already total page-unit widths, so only the
 * font height comes from the transform. Blank runs are dropped (same rule as
 * the import parser).
 */
export function pdfPageTextItems(
  content: PdfJsTextContentLike,
  viewport: PdfJsViewportLike,
  pageNumber: number,
  transform: (a: readonly number[], b: readonly number[]) => number[] = transform2d,
): MnPdfTextItem[] {
  const viewportTransform = viewport.transform ?? [1, 0, 0, -1, 0, viewport.height]
  const items: MnPdfTextItem[] = []
  let index = 0
  for (const candidate of content.items) {
    if (!candidate || typeof candidate !== 'object') continue
    const item = candidate as PdfTextItemLike
    if (typeof item.str !== 'string' || !item.str.trim()) continue
    const tx = transform(viewportTransform, numberArray(item.transform))
    const fontHeight = Math.hypot(tx[2] ?? 0, tx[3] ?? 0)
    const width = typeof item.width === 'number' && Number.isFinite(item.width)
      ? item.width
      : 0
    items.push({
      id: `p${pageNumber}-t${index}`,
      text: item.str,
      x: round2(tx[4] ?? 0),
      y: round2((tx[5] ?? 0) - fontHeight),
      width: round2(Math.max(0, width)),
      height: round2(fontHeight),
    })
    index += 1
  }
  return items
}

/* ---------------------------------------------------- embedded annotations */

interface PdfJsAnnotationLike {
  readonly id?: unknown
  readonly annotationType?: unknown
  readonly quadPoints?: unknown
  readonly rect?: unknown
  readonly titleObj?: unknown
  readonly contentsObj?: unknown
  readonly color?: unknown
}

type PdfAffineTransform = (a: readonly number[], b: readonly number[]) => number[]
type PdfPoint = readonly [number, number]

const PDF_QUOTE_CONTEXT_LENGTH = 40

function finiteNumberArray(value: unknown): number[] {
  if (!value || typeof value !== 'object') return []
  const length = (value as { readonly length?: unknown }).length
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) return []
  const numbers: number[] = []
  for (let index = 0; index < length; index += 1) {
    const entry = (value as { readonly [index: number]: unknown })[index]
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return []
    numbers.push(entry)
  }
  return numbers
}

function annotationString(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const str = (value as { readonly str?: unknown }).str
  if (typeof str !== 'string' || !str.trim()) return undefined
  return str.trim()
}

function annotationColor(value: unknown): string | undefined {
  const rgb = finiteNumberArray(value)
  if (rgb.length < 3) return undefined
  const channels = rgb.slice(0, 3).map((channel) => Math.round(Math.min(255, Math.max(0, channel))))
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, 0.35)`
}

function transformedBounds(
  points: readonly PdfPoint[],
  viewportTransform: readonly number[],
  transform: PdfAffineTransform,
): MnPdfRect | null {
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of points) {
    const tx = transform(viewportTransform, [1, 0, 0, 1, x, y])
    const transformedX = tx[4] ?? Number.NaN
    const transformedY = tx[5] ?? Number.NaN
    if (!Number.isFinite(transformedX) || !Number.isFinite(transformedY)) return null
    xs.push(transformedX)
    ys.push(transformedY)
  }
  if (!xs.length) return null
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  if (maxX <= minX || maxY <= minY) return null
  return [round2(minX), round2(minY), round2(maxX - minX), round2(maxY - minY)]
}

function pdfQuadRects(
  value: unknown,
  viewportTransform: readonly number[],
  transform: PdfAffineTransform,
): MnPdfRect[] {
  const quadPoints = finiteNumberArray(value)
  if (!quadPoints.length || quadPoints.length % 8 !== 0) return []
  const rects: MnPdfRect[] = []
  for (let index = 0; index < quadPoints.length; index += 8) {
    const points: PdfPoint[] = []
    for (let point = 0; point < 8; point += 2) {
      points.push([quadPoints[index + point] ?? 0, quadPoints[index + point + 1] ?? 0])
    }
    const rect = transformedBounds(points, viewportTransform, transform)
    if (rect) rects.push(rect)
  }
  return rects
}

function pdfNoteRects(
  value: unknown,
  viewportTransform: readonly number[],
  transform: PdfAffineTransform,
): MnPdfRect[] {
  const rect = finiteNumberArray(value)
  if (rect.length !== 4) return []
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = rect
  const bounds = transformedBounds(
    [[x0, y0], [x1, y0], [x0, y1], [x1, y1]],
    viewportTransform,
    transform,
  )
  return bounds ? [bounds] : []
}

function rectIntersectsText(rect: MnPdfRect, item: MnPdfTextItem): boolean {
  const [x, y, width, height] = rect
  return width > 0 && height > 0 && item.width > 0 && item.height > 0
    && x < item.x + item.width && x + width > item.x
    && y < item.y + item.height && y + height > item.y
}

function rectCoversText(rect: MnPdfRect, item: MnPdfTextItem): boolean {
  const [x, y, width, height] = rect
  const centerY = item.y + item.height / 2
  return x <= item.x + 0.5 && x + width >= item.x + item.width - 0.5
    && y <= centerY && y + height >= centerY
}

interface PdfTextSpan {
  readonly start: number
  readonly end: number
}

/** Partial items stay empty: their character widths are not recoverable here. */
function recoverHighlightText(
  rects: readonly MnPdfRect[],
  textItems: readonly MnPdfTextItem[],
): Pick<PdfEmbeddedAnnotation, 'quote' | 'prefix' | 'suffix'> {
  const empty = { quote: '', prefix: '', suffix: '' }
  if (!rects.length || !textItems.length) return empty

  let pageText = ''
  const spans: PdfTextSpan[] = []
  for (const item of textItems) {
    if (pageText && !/\s$/.test(pageText) && !/^\s/.test(item.text)) pageText += ' '
    const start = pageText.length
    pageText += item.text
    spans.push({ start, end: pageText.length })
  }

  const selected: number[] = []
  for (let index = 0; index < textItems.length; index += 1) {
    const item = textItems[index]
    if (!item || !rects.some((rect) => rectIntersectsText(rect, item))) continue
    if (!rects.some((rect) => rectCoversText(rect, item))) return empty
    selected.push(index)
  }
  if (!selected.length) return empty
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index] !== (selected[index - 1] ?? 0) + 1) return empty
  }

  const first = spans[selected[0] ?? 0]
  const last = spans[selected[selected.length - 1] ?? 0]
  if (!first || !last) return empty
  const quote = pageText.slice(first.start, last.end)
  if (!quote.trim()) return empty
  return {
    quote,
    prefix: pageText.slice(Math.max(0, first.start - PDF_QUOTE_CONTEXT_LENGTH), first.start),
    suffix: pageText.slice(last.end, last.end + PDF_QUOTE_CONTEXT_LENGTH),
  }
}

function pdfEmbeddedAnnotations(
  annotations: readonly unknown[],
  textItems: readonly MnPdfTextItem[],
  viewport: PdfJsViewportLike,
  pageNumber: number,
  transform: PdfAffineTransform,
): PdfEmbeddedAnnotation[] {
  const viewportTransform = viewport.transform ?? [1, 0, 0, -1, 0, viewport.height]
  const normalized: PdfEmbeddedAnnotation[] = []
  for (const candidate of annotations) {
    if (!candidate || typeof candidate !== 'object') continue
    const annotation = candidate as PdfJsAnnotationLike
    const kind = annotation.annotationType === 9
      ? 'highlight'
      : annotation.annotationType === 1 ? 'note' : null
    if (!kind || typeof annotation.id !== 'string') continue

    const rects = kind === 'highlight'
      ? pdfQuadRects(annotation.quadPoints, viewportTransform, transform)
      : pdfNoteRects(annotation.rect, viewportTransform, transform)
    const text = kind === 'highlight'
      ? recoverHighlightText(rects, textItems)
      : { quote: '', prefix: '', suffix: '' }
    const label = annotationString(annotation.titleObj)
    const note = annotationString(annotation.contentsObj)
    const color = annotationColor(annotation.color)
    normalized.push({
      id: annotation.id,
      kind,
      pageNumber,
      ...(label ? { label } : {}),
      ...(note ? { note } : {}),
      ...text,
      rects,
      ...(color ? { color } : {}),
    })
  }
  return normalized
}

/* ---------------------------------------------------------- document handle */

export interface PdfPageMeta {
  readonly pageNumber: number
  readonly width: number
  readonly height: number
  readonly textItems: readonly MnPdfTextItem[]
  readonly embeddedAnnotations: readonly PdfEmbeddedAnnotation[]
}

export interface OrganismPdfDocument {
  readonly numPages: number
  /** Scale-1 page dimensions plus page-space text items. */
  pageMeta(pageNumber: number): Promise<PdfPageMeta>
  /** Rasterize one page to a PNG data URL at the given scale. */
  renderPage(pageNumber: number, scale: number): Promise<string>
  destroy(): Promise<void>
}

export interface OpenPdfOptions {
  /** Engine override for tests/harnesses; defaults to the shared lazy loader. */
  readonly pdfJs?: PdfJsModuleLike
  readonly signal?: AbortSignal
  /** Canvas factory override; defaults to a real DOM canvas. */
  readonly createCanvas?: () => PdfCanvasLike
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('PDF read cancelled', 'AbortError')
}

function defaultCanvas(): PdfCanvasLike {
  if (typeof document === 'undefined') throw new Error('PDF rendering requires a DOM canvas')
  return document.createElement('canvas')
}

/**
 * Open one PDF from bytes behind the small OrganismPdfDocument surface.
 * Engine config matches the import parser's browser path (no font face
 * injection, no worker fetch, no WASM, tolerant of page errors).
 */
async function readPdfTextContent(page: PdfJsPageLike): Promise<PdfJsTextContentLike> {
  if (typeof page.streamTextContent !== 'function') return page.getTextContent()
  const stream = page.streamTextContent()
  const reader = stream.getReader()
  const items: unknown[] = []
  const styles: Record<string, unknown> = Object.create(null)
  let lang: string | null = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = value as { lang?: string, styles?: Record<string, unknown>, items: unknown[] }
    lang ??= chunk.lang ?? null
    Object.assign(styles, chunk.styles)
    items.push(...chunk.items)
  }
  return { items, styles, lang }
}

export async function openPdf(bytes: Uint8Array, options: OpenPdfOptions = {}): Promise<OrganismPdfDocument> {
  throwIfAborted(options.signal)
  const pdfjs = options.pdfJs ?? await loadPdfJs()
  throwIfAborted(options.signal)
  const createCanvas = options.createCanvas ?? defaultCanvas
  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: true,
    useWorkerFetch: false,
    useWasm: true,
    wasmUrl: pdfWasmBaseUrl(),
    stopAtErrors: false,
  })
  const document = await task.promise
  throwIfAborted(options.signal)
  const transform = pdfjs.Util?.transform ?? transform2d
  let destroyed = false

  const pageAt = (pageNumber: number): Promise<PdfJsPageLike> => {
    if (destroyed) return Promise.reject(new Error('PDF document is closed'))
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
      return Promise.reject(new Error(`PDF page ${pageNumber} is out of range`))
    }
    return document.getPage(pageNumber)
  }

  return {
    numPages: document.numPages,
    async pageMeta(pageNumber) {
      const page = await pageAt(pageNumber)
      throwIfAborted(options.signal)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const content = await readPdfTextContent(page)
        throwIfAborted(options.signal)
        const textItems = pdfPageTextItems(content, viewport, pageNumber, transform)
        const annotations = typeof page.getAnnotations === 'function'
          ? await page.getAnnotations({ intent: 'display' })
          : []
        throwIfAborted(options.signal)
        return {
          pageNumber,
          width: round2(viewport.width),
          height: round2(viewport.height),
          textItems,
          embeddedAnnotations: pdfEmbeddedAnnotations(annotations, textItems, viewport, pageNumber, transform),
        }
      } finally {
        page.cleanup?.()
      }
    },
    async renderPage(pageNumber, scale) {
      const page = await pageAt(pageNumber)
      throwIfAborted(options.signal)
      const viewport = page.getViewport({ scale: Math.max(0.1, scale) })
      const canvas = createCanvas()
      canvas.width = Math.max(1, Math.ceil(viewport.width))
      canvas.height = Math.max(1, Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('PDF rendering requires a 2d canvas context')
      await page.render({ canvas, canvasContext: context, viewport }).promise
      throwIfAborted(options.signal)
      return canvas.toDataURL('image/png')
    },
    async destroy() {
      if (destroyed) return
      destroyed = true
      await task.destroy().catch(() => undefined)
    },
  }
}
