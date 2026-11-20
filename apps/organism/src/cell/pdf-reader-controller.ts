/**
 * Shell-owned PDF reading and shared-annotation controller.
 *
 * The controlled <mn-pdf-reader> never fetches bytes, opens pdf.js, or creates
 * object URLs. This controller owns exactly that, for two scopes:
 *
 *   - artifact-only:   /artifacts/{graph}/{artifact}/download?inline=true
 *   - document-backed: /artifacts/{graph}/documents/{doc}/download-original?inline=true
 *                      falling back to the persisted artifact route exactly as
 *                      original-file-controller.ts does (browser-parsed imports
 *                      keep their bytes only at the artifact link).
 *
 * It projects a controlled snapshot (pages with dimensions + page-space text
 * items, lazily rasterized page images, zoom/page state, shared annotations)
 * and answers the component's intents. Contracts without MCP retain the
 * read-only Phase 2 behavior.
 */

import type { MnPdfAnnotation, MnPdfAnnotateDetail, MnPdfPage, MnPdfSurfaceMode } from '@shrubbery/components'
import type { ShrubberyContract } from '@shrubbery/nucleus'
import { openPdf, type OpenPdfOptions, type OrganismPdfDocument, type PdfEmbeddedAnnotation } from './pdf-service.js'
import {
  artifactOriginalDownloadUrl,
  ORIGINAL_REMOVED_MESSAGE,
  documentOriginalDownloadUrl,
  type OriginalFileSourceMetadata,
} from './original-file-controller.js'
import {
  OrganismPdfAnnotationStore,
  type PdfAnnotationMcp,
  type PdfAnnotationStore,
} from './pdf-annotation-service.js'

export type PdfReaderContract = Pick<ShrubberyContract, 'auth' | 'runtime'>
  & Partial<Pick<ShrubberyContract, 'ui'>>
  & { readonly mcp?: PdfAnnotationMcp }

export type PdfReaderScope =
  | {
      readonly kind: 'artifact'
      readonly graphId: string
      readonly artifactId: string
      readonly ingestedDocumentId?: string | null
    }
  | {
      readonly kind: 'document'
      readonly graphId: string
      readonly documentId: string
      readonly sourceFile: OriginalFileSourceMetadata
    }

export type PdfReaderStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface PdfReaderSnapshot {
  readonly status: PdfReaderStatus
  readonly error: string
  readonly annotationError: string
  readonly title: string
  readonly filename: string
  readonly mimeType: string
  /**
   * Original vs annotations surface. Mode changes never reload bytes or touch
   * the annotation store — both surfaces read the same loaded state.
   */
  readonly mode: MnPdfSurfaceMode
  readonly pages: readonly MnPdfPage[]
  readonly annotations: readonly MnPdfAnnotation[]
  readonly activeAnnotationId: string
  readonly canAnnotate: boolean
  readonly downloadable: boolean
  readonly externalOpenable: boolean
  readonly zoom: number
  readonly pageNumber: number
}

export interface PdfReaderUrlApi {
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
}

export type PdfDocumentOpener = (bytes: Uint8Array, options?: OpenPdfOptions) => Promise<OrganismPdfDocument>

export interface PdfReaderControllerOptions {
  readonly requestRender: () => void
  readonly fetch?: typeof fetch
  readonly url?: PdfReaderUrlApi
  readonly download?: (url: string, filename: string) => void
  readonly openExternal?: (url: string) => void
  /** Engine seam: tests inject a fake; production uses the shared pdf.js service. */
  readonly openPdfDocument?: PdfDocumentOpener
  readonly annotationStore?: PdfAnnotationStore
  /** Rasterization scale for page images (CSS zoom rescales on top). */
  readonly renderScale?: number
}

const PDF_MIN_ZOOM = 0.25
const PDF_MAX_ZOOM = 5

function clampReaderZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, Math.round(zoom * 1000) / 1000))
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function artifactIdForScope(scope: PdfReaderScope): string {
  if (scope.kind === 'artifact') return scope.artifactId
  const match = /^local:\/\/artifacts\/([^/]+)\/original\//.exec(scope.sourceFile.storageKey?.trim() ?? '')
  if (!match?.[1]) return ''
  try { return decodeURIComponent(match[1]) } catch { return match[1] }
}

function scopeFingerprint(scope: PdfReaderScope): string {
  if (scope.kind === 'artifact') {
    return ['artifact', scope.graphId, scope.artifactId, scope.ingestedDocumentId ?? ''].join('\x1f')
  }
  const source = scope.sourceFile
  return [
    'document',
    scope.graphId,
    scope.documentId,
    source.storageKey ?? '',
    source.originalFilename ?? '',
    source.mimeType ?? '',
  ].join('\x1f')
}

function filenameFromDisposition(value: string | null): string {
  if (!value) return ''
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value)?.[1]?.trim()
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, '')).split('/').pop() ?? ''
    } catch {
      // Fall through to the ordinary filename parameter.
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(value)?.[1]
  if (quoted) return quoted.split('/').pop() ?? quoted
  const plain = /filename\s*=\s*([^;]+)/i.exec(value)?.[1]
  return plain?.trim().replace(/^"|"$/g, '').split('/').pop() ?? ''
}

function responseError(status: number): string {
  if (status === 404) return 'No PDF is attached here.'
  if (status === 401 || status === 403) return 'You do not have access to this PDF.'
  return `The PDF could not be loaded (HTTP ${status}).`
}

function defaultDownload(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename || 'document.pdf'
  anchor.rel = 'noopener'
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function defaultOpenExternal(url: string): void {
  globalThis.open?.(url, '_blank', 'noopener,noreferrer')
}

function defaultUrlApi(): PdfReaderUrlApi {
  return {
    createObjectURL: blob => URL.createObjectURL(blob),
    revokeObjectURL: url => URL.revokeObjectURL(url),
  }
}

interface ActiveScope {
  readonly contract: PdfReaderContract
  readonly scope: PdfReaderScope
  readonly fingerprint: string
}

export class OrganismPdfReaderController {
  private readonly fetchImpl: typeof fetch
  private readonly urlApi: PdfReaderUrlApi
  private readonly downloadEffect: (url: string, filename: string) => void
  private readonly openExternalEffect: (url: string) => void
  private readonly openPdfDocument: PdfDocumentOpener
  private readonly renderScale: number
  private active: ActiveScope | null = null
  private status: PdfReaderStatus = 'idle'
  private error = ''
  private annotationError = ''
  private filename = ''
  private mimeType = ''
  private pages: readonly MnPdfPage[] = []
  private annotations: readonly MnPdfAnnotation[] = []
  private activeAnnotationId = ''
  private mode: MnPdfSurfaceMode = 'original'
  private annotationStore: PdfAnnotationStore | null = null
  private annotationWriteQueue: Promise<void> = Promise.resolve()
  private zoom = 1
  private pageNumber = 0
  private objectUrl = ''
  private pdf: OrganismPdfDocument | null = null
  private readonly pageRenderState = new Map<number, 'pending' | 'done'>()
  private abort: AbortController | null = null
  private sequence = 0
  private destroyed = false

  constructor(private readonly options: PdfReaderControllerOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') throw new Error('PDF reader controller requires fetch')
    this.fetchImpl = fetchImpl.bind(globalThis)
    this.urlApi = options.url ?? defaultUrlApi()
    this.downloadEffect = options.download ?? defaultDownload
    this.openExternalEffect = options.openExternal ?? defaultOpenExternal
    this.openPdfDocument = options.openPdfDocument ?? openPdf
    this.renderScale = Math.max(0.5, options.renderScale ?? 2)
  }

  private render(): void {
    if (!this.destroyed) this.options.requestRender()
  }

  private cancelLoad(): void {
    this.sequence += 1
    this.abort?.abort()
    this.abort = null
  }

  private revokeObjectUrl(): void {
    if (!this.objectUrl) return
    this.urlApi.revokeObjectURL(this.objectUrl)
    this.objectUrl = ''
  }

  private async destroyPdf(): Promise<void> {
    const pdf = this.pdf
    this.pdf = null
    if (pdf) await pdf.destroy().catch(() => undefined)
  }

  private clearLoaded(): void {
    this.revokeObjectUrl()
    void this.destroyPdf()
    this.pageRenderState.clear()
    this.status = 'idle'
    this.error = ''
    this.annotationError = ''
    this.filename = ''
    this.mimeType = ''
    this.pages = []
    this.annotations = []
    this.activeAnnotationId = ''
    this.mode = 'original'
    this.annotationStore = null
    this.zoom = 1
    this.pageNumber = 0
  }

  setScope(contract: PdfReaderContract | null, scope: PdfReaderScope | null): void {
    if (this.destroyed) return
    const next = contract && scope ? { contract, scope, fingerprint: scopeFingerprint(scope) } : null
    if (
      this.active === null
        ? next === null
        : next !== null && this.active.contract === next.contract && this.active.fingerprint === next.fingerprint
    ) return
    this.cancelLoad()
    this.clearLoaded()
    this.active = next
    if (!next) {
      this.render()
      return
    }
    this.status = 'loading'
    this.render()
    void this.load(next, this.sequence)
  }

  releaseScope(fingerprintOwner: PdfReaderScope | null): void {
    if (!this.active || !fingerprintOwner) return
    if (this.active.fingerprint !== scopeFingerprint(fingerprintOwner)) return
    this.setScope(null, null)
  }

  /** Whether this controller currently owns a live scope. */
  hasScope(): boolean {
    return this.active !== null
  }

  snapshot(): PdfReaderSnapshot {
    const scope = this.active?.scope
    const source = scope?.kind === 'document' ? scope.sourceFile : null
    return Object.freeze({
      status: this.status,
      error: this.error,
      annotationError: this.annotationError,
      title: '',
      filename: this.filename || source?.originalFilename?.trim() || '',
      mimeType: this.mimeType || source?.mimeType?.trim() || (scope ? 'application/pdf' : ''),
      mode: this.mode,
      pages: this.pages,
      annotations: this.annotations,
      activeAnnotationId: this.activeAnnotationId,
      canAnnotate: this.status === 'ready' && this.annotationStore !== null,
      downloadable: this.status === 'ready' && Boolean(this.objectUrl),
      externalOpenable: this.status === 'ready' && Boolean(this.objectUrl),
      zoom: this.zoom,
      pageNumber: this.pageNumber,
    })
  }

  /** mn-pdf-page-visible: rasterize a page exactly once per scope. */
  handlePageVisible(pageNumber: number): void {
    const active = this.active
    const pdf = this.pdf
    if (!active || !pdf || this.status !== 'ready') return
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) return
    if (this.pageRenderState.has(pageNumber)) return
    this.pageRenderState.set(pageNumber, 'pending')
    const sequence = this.sequence
    void pdf
      .renderPage(pageNumber, this.renderScale)
      .then((dataUrl) => {
        if (sequence !== this.sequence || this.active !== active || this.destroyed) return
        this.pageRenderState.set(pageNumber, 'done')
        this.pages = this.pages.map(page =>
          page.pageNumber === pageNumber ? { ...page, imageUrl: dataUrl } : page,
        )
        this.render()
      })
      .catch((error: unknown) => {
        if (sequence !== this.sequence || this.active !== active || this.destroyed) return
        this.pageRenderState.delete(pageNumber)
        this.error = error instanceof Error ? error.message : String(error)
        this.render()
      })
  }

  /** mn-pdf-zoom-change: the component rescales page boxes; images stay as rendered. */
  setZoom(zoom: number): void {
    const next = clampReaderZoom(zoom)
    if (next === this.zoom || !this.active) return
    this.zoom = next
    this.render()
  }

  /** mn-pdf-page-change: reflect the reader's scroll-driven current page. */
  setPageNumber(pageNumber: number): void {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pages.length) return
    if (pageNumber === this.pageNumber) return
    this.pageNumber = pageNumber
    this.render()
  }

  async highlight(detail: MnPdfAnnotateDetail): Promise<void> {
    await this.writeAnnotation(detail)
  }

  async note(detail: MnPdfAnnotateDetail): Promise<void> {
    const active = this.active
    if (!active || !this.annotationStore || this.status !== 'ready') return
    const ui = active.contract.ui
    const value = ui?.prompt
      ? await ui.prompt({
          title: 'Add PDF note',
          message: detail.exact,
          placeholder: 'Write a note',
          confirmLabel: 'Add note',
        })
      : globalThis.prompt?.('Add PDF note', '')
    if (!value?.trim() || this.active !== active) return
    const userId = active.contract.auth.userId()
    await this.writeAnnotation(detail, {
      text: value,
      author: userId === 'local-organism' ? 'You' : userId || 'You',
    })
  }

  selectAnnotation(annotationId: string): void {
    const annotation = this.annotations.find(candidate => candidate.id === annotationId)
    if (!annotation) return
    this.activeAnnotationId = annotation.id
    this.pageNumber = annotation.pageNumber
    this.render()
  }

  /**
   * Original ↔ annotations surface. Pure view state: no reload, no store
   * traffic, and no companion creation — the annotation list renders from the
   * already-loaded snapshot.
   */
  setMode(mode: MnPdfSurfaceMode): void {
    if (!this.active || mode === this.mode) return
    this.mode = mode
    this.render()
  }

  /** mn-pdf-annotation-open-original: back to the original, at the annotation's page. */
  openAnnotation(annotationId: string): void {
    this.selectAnnotation(annotationId)
    this.setMode('original')
  }

  private async writeAnnotation(
    detail: MnPdfAnnotateDetail,
    note?: { readonly text: string; readonly author: string },
  ): Promise<void> {
    const operation = this.annotationWriteQueue.then(async () => {
      const active = this.active
      const store = this.annotationStore
      if (!active || !store || this.status !== 'ready') return
      const sequence = this.sequence
      this.annotationError = ''
      try {
        const result = await store.add(detail, note)
        if (sequence !== this.sequence || active !== this.active || this.destroyed) return
        this.annotations = result.annotations
        this.activeAnnotationId = result.annotationId
        this.pageNumber = detail.pageNumber
      } catch (error) {
        if (sequence !== this.sequence || active !== this.active || this.destroyed) return
        this.annotationError = error instanceof Error ? error.message : String(error)
      }
      this.render()
    })
    this.annotationWriteQueue = operation.catch(() => undefined)
    await operation
  }

  download(): void {
    if (!this.objectUrl || this.status !== 'ready') return
    this.downloadEffect(this.objectUrl, this.filename || 'document.pdf')
  }

  openExternal(): void {
    if (!this.objectUrl || this.status !== 'ready') return
    this.openExternalEffect(this.objectUrl)
  }

  async reload(): Promise<void> {
    const active = this.active
    if (!active || this.destroyed) return
    this.cancelLoad()
    this.clearLoaded()
    this.status = 'loading'
    this.render()
    await this.load(active, this.sequence)
  }

  private sourceUrls(active: ActiveScope): readonly string[] {
    const { contract, scope } = active
    if (scope.kind === 'artifact') {
      const base = trimSlash(contract.runtime.graphBaseUrl(scope.graphId))
      if (!base) throw new Error(`No API base is available for graph ${scope.graphId}`)
      return [
        `${base}/artifacts/${encodeURIComponent(scope.graphId)}/${encodeURIComponent(scope.artifactId)}/download?inline=true`,
      ]
    }
    const documentUrl = documentOriginalDownloadUrl(contract, scope.graphId, scope.documentId)
    const artifactUrl = artifactOriginalDownloadUrl(contract, scope.graphId, scope.sourceFile)
    return artifactUrl ? [documentUrl, artifactUrl] : [documentUrl]
  }

  private makeAnnotationStore(active: ActiveScope, filename: string): PdfAnnotationStore | null {
    if (this.options.annotationStore) return this.options.annotationStore
    const mcp = active.contract.mcp
    const artifactId = artifactIdForScope(active.scope)
    if (!mcp || !artifactId) return null
    const scope = active.scope
    return new OrganismPdfAnnotationStore(mcp, {
      graphId: scope.graphId,
      artifactId,
      ingestedDocumentId: scope.kind === 'artifact' ? scope.ingestedDocumentId : scope.documentId,
      filename,
    })
  }

  private async load(active: ActiveScope, sequence: number): Promise<void> {
    const abort = new AbortController()
    this.abort = abort
    const stale = (): boolean => sequence !== this.sequence || abort.signal.aborted || this.destroyed
    try {
      await active.contract.auth.whenReady()
      if (stale()) return
      const headers = new Headers({ Accept: '*/*' })
      const token = active.contract.auth.token()
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const userId = active.contract.auth.userId()
      if (userId) headers.set('X-User-ID', userId)
      const request: RequestInit = {
        method: 'GET',
        headers,
        signal: abort.signal,
        credentials: 'same-origin',
      }
      const urls = this.sourceUrls(active)
      let response = await this.fetchImpl(urls[0]!, request)
      // Document scope: gardend does not duplicate browser-parsed source bytes
      // into documents/:id/original, so follow the persisted artifact link on
      // an honest 404 — the same fallback original-file-controller.ts runs.
      const followedLink = response.status === 404 && urls.length > 1
      if (followedLink) {
        response = await this.fetchImpl(urls[1]!, request)
      }
      if (stale()) return
      if (!response.ok) {
        this.status = 'error'
        this.error = followedLink && response.status === 404 ? ORIGINAL_REMOVED_MESSAGE : responseError(response.status)
        this.render()
        return
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (stale()) return
      const mimeType = (response.headers.get('content-type')?.split(';', 1)[0]?.trim()
        || 'application/pdf').toLocaleLowerCase()
      const dispositionName = filenameFromDisposition(response.headers.get('content-disposition'))
      const scope = active.scope
      const fallbackName = scope.kind === 'artifact'
        ? `${scope.artifactId}.pdf`
        : scope.sourceFile.originalFilename?.trim() || `${scope.documentId}-original.pdf`
      const filename = dispositionName || fallbackName
      const blobBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const objectUrl = this.urlApi.createObjectURL(new Blob([blobBytes], { type: mimeType }))
      if (stale()) {
        this.urlApi.revokeObjectURL(objectUrl)
        return
      }
      this.objectUrl = objectUrl
      const pdf = await this.openPdfDocument(bytes, { signal: abort.signal })
      if (stale()) {
        await pdf.destroy().catch(() => undefined)
        return
      }
      this.pdf = pdf
      const pages: MnPdfPage[] = []
      const embeddedAnnotations: PdfEmbeddedAnnotation[] = []
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (stale()) return
        const meta = await pdf.pageMeta(pageNumber)
        embeddedAnnotations.push(...meta.embeddedAnnotations)
        pages.push({
          pageNumber,
          width: meta.width,
          height: meta.height,
          textItems: meta.textItems,
        })
      }
      if (stale()) return
      this.pages = pages
      this.filename = filename
      this.mimeType = mimeType
      this.pageNumber = pages[0]?.pageNumber ?? 0
      this.annotationStore = this.makeAnnotationStore(active, filename)
      if (this.annotationStore) {
        try {
          this.annotations = await this.annotationStore.load(embeddedAnnotations)
          this.annotationError = this.annotationStore.warnings?.join('\n') ?? ''
        } catch (error) {
          if (stale()) return
          this.annotationStore = null
          this.annotationError = error instanceof Error ? error.message : String(error)
        }
      }
      if (stale()) return
      this.status = 'ready'
      this.error = ''
      this.render()
    } catch (error) {
      if (stale()) return
      this.status = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      this.render()
    } finally {
      if (this.abort === abort) this.abort = null
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.cancelLoad()
    this.clearLoaded()
    this.active = null
    this.destroyed = true
  }
}
