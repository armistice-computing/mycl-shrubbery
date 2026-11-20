/**
 * OrganismPdfReaderController — shell-owned bytes/pages/renders behind the
 * controlled <mn-pdf-reader>. Tests use an injected fetch and an injected fake
 * PDF engine (openPdfDocument); no real pdf.js, no real network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MnPdfAnnotation, MnPdfAnnotateDetail } from '@shrubbery/components'
import type { ShrubberyContract } from '@shrubbery/nucleus'
import {
  OrganismPdfReaderController,
  type PdfReaderContract,
  type PdfReaderUrlApi,
} from '../pdf-reader-controller.js'
import type { PdfAnnotationStore } from '../pdf-annotation-service.js'
import type { OrganismPdfDocument, PdfPageMeta } from '../pdf-service.js'

function contract(base = 'https://gateway.test/g/graph%20one'): Pick<ShrubberyContract, 'auth' | 'runtime'> {
  return {
    auth: {
      token: () => 'fresh-id-token',
      userId: () => 'reader-user',
      isAuthenticated: () => true,
      whenReady: () => Promise.resolve(),
      onChange: () => () => undefined,
    },
    runtime: {
      mode: () => 'hosted',
      isGateway: () => true,
      graphBaseUrl: () => base,
    },
  }
}

function urlHarness() {
  const created: Blob[] = []
  const revoked: string[] = []
  const api: PdfReaderUrlApi = {
    createObjectURL(blob) {
      created.push(blob)
      return `blob:pdf-${created.length}`
    },
    revokeObjectURL(url) { revoked.push(url) },
  }
  return { api, created, revoked }
}

function binaryResponse(body: BlobPart, filename: string, status = 200, mimeType = 'application/pdf'): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': mimeType,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  })
}

interface FakePageSpec {
  readonly width: number
  readonly height: number
  readonly text: string
}

function fakePdfOpener(pageSpecs: readonly FakePageSpec[], log?: { renders: number[]; destroyed: boolean }) {
  return async (_bytes: Uint8Array): Promise<OrganismPdfDocument> => {
    const pdf: OrganismPdfDocument = {
      numPages: pageSpecs.length,
      pageMeta: (pageNumber): Promise<PdfPageMeta> => {
        const spec = pageSpecs[pageNumber - 1]
        if (!spec) return Promise.reject(new Error(`no page ${pageNumber}`))
        return Promise.resolve({
          pageNumber,
          width: spec.width,
          height: spec.height,
          textItems: spec.text
            ? [{ id: `p${pageNumber}-t0`, text: spec.text, x: 10, y: 20, width: 50, height: 12 }]
            : [],
          embeddedAnnotations: [],
        })
      },
      renderPage: (pageNumber, scale) => {
        if (log) log.renders.push(pageNumber)
        return Promise.resolve(`data:image/png;base64,p${pageNumber}@${scale}`)
      },
      destroy: () => {
        if (log) log.destroyed = true
        return Promise.resolve()
      },
    }
    return pdf
  }
}

const PDF_SOURCE = {
  storageKey: 'local://artifacts/artifact%2Fpdf/original/paper.pdf',
  originalFilename: 'paper.pdf',
  mimeType: 'application/pdf',
  fileType: 'pdf',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OrganismPdfReaderController', () => {
  it('loads an artifact scope, projects pages, and rasterizes visible pages lazily', async () => {
    const urls = urlHarness()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return binaryResponse('%PDF-1.7 bytes', 'paper.pdf')
    }) as unknown as typeof globalThis.fetch
    const renders = { renders: [] as number[], destroyed: false }
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch,
      url: urls.api,
      openPdfDocument: fakePdfOpener([
        { width: 612, height: 792, text: 'hello world' },
        { width: 612, height: 792, text: '' },
      ], renders),
    })

    controller.setScope(contract(), { kind: 'artifact', graphId: 'graph one', artifactId: 'art/1' })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      'https://gateway.test/g/graph%20one/artifacts/graph%20one/art%2F1/download?inline=true',
    )
    const headers = calls[0]?.init?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer fresh-id-token')
    expect(headers.get('X-User-ID')).toBe('reader-user')

    const snapshot = controller.snapshot()
    expect(snapshot.filename).toBe('paper.pdf')
    expect(snapshot.mimeType).toBe('application/pdf')
    expect(snapshot.downloadable).toBe(true)
    expect(snapshot.externalOpenable).toBe(true)
    expect(snapshot.canAnnotate).toBe(false)
    expect(snapshot.annotations).toEqual([])
    expect(snapshot.pageNumber).toBe(1)
    expect(snapshot.pages).toHaveLength(2)
    expect(snapshot.pages[0]).toMatchObject({ pageNumber: 1, width: 612, height: 792 })
    expect(snapshot.pages[0]?.textItems[0]).toMatchObject({ text: 'hello world', x: 10, y: 20 })
    // Nothing rasterized until the reader reports a page visible.
    expect(snapshot.pages[0]?.imageUrl).toBeUndefined()
    expect(renders.renders).toEqual([])

    controller.handlePageVisible(1)
    await vi.waitFor(() => expect(controller.snapshot().pages[0]?.imageUrl).toBe('data:image/png;base64,p1@2'))
    expect(renders.renders).toEqual([1])
    // Repeated visibility never re-renders.
    controller.handlePageVisible(1)
    controller.handlePageVisible(2)
    await vi.waitFor(() => expect(controller.snapshot().pages[1]?.imageUrl).toBe('data:image/png;base64,p2@2'))
    expect(renders.renders).toEqual([1, 2])
  })

  it('falls back to the persisted artifact bytes when the document-original route 404s', async () => {
    const calls: string[] = []
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        if (calls.length === 1) return new Response('No document original', { status: 404 })
        return binaryResponse('%PDF bytes', 'paper.pdf')
      }) as unknown as typeof globalThis.fetch,
      url: urlHarness().api,
      openPdfDocument: fakePdfOpener([{ width: 612, height: 792, text: 'body' }]),
    })

    controller.setScope(contract('/cell'), {
      kind: 'document',
      graphId: 'graph a',
      documentId: 'doc-a',
      sourceFile: PDF_SOURCE,
    })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))

    expect(calls).toEqual([
      '/cell/artifacts/graph%20a/documents/doc-a/download-original?inline=true',
      '/cell/artifacts/graph%20a/artifact%2Fpdf/download?inline=true',
    ])
    expect(controller.snapshot().filename).toBe('paper.pdf')
  })

  it('says the original was removed when neither document-original nor its linked file answers', async () => {
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch: (async () => new Response('', { status: 404 })) as unknown as typeof globalThis.fetch,
      url: urlHarness().api,
      openPdfDocument: fakePdfOpener([{ width: 612, height: 792, text: '' }]),
    })
    controller.setScope(contract('/cell'), {
      kind: 'document',
      graphId: 'g',
      documentId: 'doc-missing',
      sourceFile: PDF_SOURCE,
    })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('error'))
    expect(controller.snapshot().error).toBe('The original file was removed. This document stays.')
  })

  it('revokes the object URL and destroys the engine handle on scope change and destroy', async () => {
    const urls = urlHarness()
    const renders = { renders: [] as number[], destroyed: false }
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch: (async () => binaryResponse('%PDF bytes', 'paper.pdf')) as unknown as typeof globalThis.fetch,
      url: urls.api,
      openPdfDocument: fakePdfOpener([{ width: 612, height: 792, text: 'x' }], renders),
    })

    controller.setScope(contract('/cell'), { kind: 'artifact', graphId: 'g', artifactId: 'a1' })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    expect(urls.created).toHaveLength(1)

    controller.setScope(contract('/cell'), { kind: 'artifact', graphId: 'g', artifactId: 'a2' })
    expect(urls.revoked).toEqual(['blob:pdf-1'])
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    await vi.waitFor(() => expect(renders.destroyed).toBe(true))

    controller.setScope(null, null)
    expect(controller.snapshot().status).toBe('idle')
    expect(urls.revoked).toEqual(['blob:pdf-1', 'blob:pdf-2'])

    controller.setScope(contract('/cell'), { kind: 'artifact', graphId: 'g', artifactId: 'a3' })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    controller.destroy()
    expect(urls.revoked).toContain('blob:pdf-3')
  })

  it('ignores a stale load resolving after the scope moved on', async () => {
    const urls = urlHarness()
    let resolveFirst!: (response: Response) => void
    let calls = 0
    const fetch = vi.fn(() => {
      calls += 1
      if (calls === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve })
      return Promise.resolve(binaryResponse('%PDF second', 'second.pdf'))
    }) as unknown as typeof globalThis.fetch
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch,
      url: urls.api,
      openPdfDocument: fakePdfOpener([{ width: 612, height: 792, text: 'x' }]),
    })

    const stable = contract('/cell')
    controller.setScope(stable, { kind: 'artifact', graphId: 'g', artifactId: 'stale' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    controller.setScope(stable, { kind: 'artifact', graphId: 'g', artifactId: 'fresh' })

    resolveFirst(binaryResponse('%PDF late', 'late.pdf'))
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    expect(controller.snapshot().filename).toBe('second.pdf')
    // The stale load was detected before manufacturing an object URL: exactly
    // one blob exists (the fresh scope's), nothing leaked to revoke later.
    expect(urls.created).toHaveLength(1)
  })

  it('tracks zoom/page intents and delegates download + open-external', async () => {
    const downloads: Array<{ url: string; filename: string }> = []
    const opened: string[] = []
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch: (async () => binaryResponse('%PDF bytes', 'paper.pdf')) as unknown as typeof globalThis.fetch,
      url: urlHarness().api,
      download: (url, filename) => downloads.push({ url, filename }),
      openExternal: (url) => opened.push(url),
      openPdfDocument: fakePdfOpener([
        { width: 612, height: 792, text: 'a' },
        { width: 612, height: 792, text: 'b' },
      ]),
    })

    controller.setScope(contract('/cell'), { kind: 'artifact', graphId: 'g', artifactId: 'a1' })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))

    controller.setZoom(1.6)
    expect(controller.snapshot().zoom).toBe(1.6)
    controller.setZoom(99)
    expect(controller.snapshot().zoom).toBe(5)
    controller.setPageNumber(2)
    expect(controller.snapshot().pageNumber).toBe(2)
    controller.setPageNumber(99)
    expect(controller.snapshot().pageNumber).toBe(2)

    controller.download()
    controller.openExternal()
    expect(downloads).toEqual([{ url: 'blob:pdf-1', filename: 'paper.pdf' }])
    expect(opened).toEqual(['blob:pdf-1'])
  })

  it('is idempotent for repeated identical scopes (no render loop, no refetch)', async () => {
    const fetch = vi.fn(async () => binaryResponse('%PDF bytes', 'paper.pdf')) as unknown as typeof globalThis.fetch
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch,
      url: urlHarness().api,
      openPdfDocument: fakePdfOpener([{ width: 612, height: 792, text: 'x' }]),
    })
    const stable = contract('/cell')
    const scope = { kind: 'artifact' as const, graphId: 'g', artifactId: 'a1' }
    controller.setScope(stable, scope)
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    controller.setScope(stable, { ...scope })
    controller.setScope(stable, scope)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(controller.snapshot().status).toBe('ready')
    controller.setScope(null, null)
    controller.setScope(null, null)
    expect(controller.snapshot().status).toBe('idle')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('loads the shared companion and writes highlight, note, and selection intents', async () => {
    const existing: MnPdfAnnotation = { id: 'block-existing', pageNumber: 1, quote: 'existing', rects: [[1, 2, 3, 4]] }
    const added: MnPdfAnnotation = { id: 'block-added', pageNumber: 2, quote: 'world', note: 'shared note', rects: [[5, 6, 7, 8]] }
    const store: PdfAnnotationStore = {
      load: vi.fn(async () => [existing]),
      add: vi.fn(async () => ({ annotationId: added.id, annotations: [existing, added] })),
    }
    const prompt = vi.fn(async () => 'shared note')
    const annotatedContract: PdfReaderContract = {
      ...contract('/cell'),
      ui: {
        prompt,
        confirm: async () => true,
        icon: () => ({}) as never,
        presenceColors: [],
      },
    }
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch: (async () => binaryResponse('%PDF bytes', 'paper.pdf')) as unknown as typeof globalThis.fetch,
      url: urlHarness().api,
      openPdfDocument: fakePdfOpener([
        { width: 612, height: 792, text: 'hello' },
        { width: 612, height: 792, text: 'world' },
      ]),
      annotationStore: store,
    })
    controller.setScope(annotatedContract, {
      kind: 'artifact', graphId: 'g', artifactId: 'a1', ingestedDocumentId: 'doc-a',
    })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    expect(store.load).toHaveBeenCalledOnce()
    expect(controller.snapshot().canAnnotate).toBe(true)
    expect(controller.snapshot().annotations).toEqual([existing])

    const detail: MnPdfAnnotateDetail = {
      pageNumber: 2, exact: 'world', prefix: '', suffix: '', quads: [[5, 6, 7, 8]], mode: 'highlight',
    }
    await controller.highlight(detail)
    expect(store.add).toHaveBeenNthCalledWith(1, detail, undefined)
    expect(controller.snapshot().activeAnnotationId).toBe('block-added')
    expect(controller.snapshot().pageNumber).toBe(2)

    await controller.note({ ...detail, mode: 'note' })
    expect(prompt).toHaveBeenCalledOnce()
    expect(store.add).toHaveBeenNthCalledWith(2, { ...detail, mode: 'note' }, {
      text: 'shared note', author: 'reader-user',
    })
    controller.selectAnnotation('block-existing')
    expect(controller.snapshot().activeAnnotationId).toBe('block-existing')
    expect(controller.snapshot().pageNumber).toBe(1)
  })

  it('calls a class-based prompt service with its own this binding', async () => {
    class PromptUi {
      private readonly answer = 'class note'
      confirm = async () => true
      icon = () => ({}) as never
      readonly presenceColors = []
      async prompt(): Promise<string | null> {
        return this.answer
      }
    }
    const added: MnPdfAnnotation = { id: 'block-note', pageNumber: 1, quote: 'hello', note: 'class note', rects: [] }
    const add = vi.fn(async () => ({ annotationId: added.id, annotations: [added] }))
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch: (async () => binaryResponse('%PDF bytes', 'paper.pdf')) as unknown as typeof globalThis.fetch,
      url: urlHarness().api,
      openPdfDocument: fakePdfOpener([{ width: 612, height: 792, text: 'hello' }]),
      annotationStore: { load: async () => [], add },
    })
    controller.setScope({
      ...contract('/cell'),
      auth: { ...contract('/cell').auth, userId: () => 'local-organism' },
      ui: new PromptUi(),
    }, {
      kind: 'artifact', graphId: 'g', artifactId: 'a1',
    })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    const detail: MnPdfAnnotateDetail = { pageNumber: 1, exact: 'hello', prefix: '', suffix: '', quads: [], mode: 'note' }
    await controller.note(detail)
    expect(add).toHaveBeenCalledWith(detail, { text: 'class note', author: 'You' })
  })

  it('serializes concurrent annotation writes', async () => {
    const first: MnPdfAnnotation = { id: 'first', pageNumber: 1, quote: 'first', rects: [] }
    const second: MnPdfAnnotation = { id: 'second', pageNumber: 1, quote: 'second', rects: [] }
    let resolveFirst!: (value: { annotationId: string; annotations: readonly MnPdfAnnotation[] }) => void
    const add = vi.fn((detail: MnPdfAnnotateDetail) => {
      if (detail.exact === 'first') {
        return new Promise<{ annotationId: string; annotations: readonly MnPdfAnnotation[] }>(resolve => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({ annotationId: 'second', annotations: [first, second] })
    })
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch: (async () => binaryResponse('%PDF bytes', 'paper.pdf')) as unknown as typeof globalThis.fetch,
      url: urlHarness().api,
      openPdfDocument: fakePdfOpener([{ width: 612, height: 792, text: 'hello' }]),
      annotationStore: { load: async () => [], add },
    })
    controller.setScope(contract('/cell'), { kind: 'artifact', graphId: 'g', artifactId: 'a1' })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    const firstDetail: MnPdfAnnotateDetail = { pageNumber: 1, exact: 'first', prefix: '', suffix: '', quads: [], mode: 'highlight' }
    const secondDetail: MnPdfAnnotateDetail = { ...firstDetail, exact: 'second' }
    const firstWrite = controller.highlight(firstDetail)
    const secondWrite = controller.highlight(secondDetail)
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1))
    resolveFirst({ annotationId: 'first', annotations: [first] })
    await firstWrite
    await secondWrite
    expect(add).toHaveBeenCalledTimes(2)
    expect(controller.snapshot().annotations).toEqual([first, second])
  })

  it('switches between Original and Annotations without reloading, and open-original jumps to the page', async () => {
    const fetch = vi.fn(async () => binaryResponse('%PDF bytes', 'paper.pdf')) as unknown as typeof globalThis.fetch
    const existing: MnPdfAnnotation = { id: 'block-existing', pageNumber: 2, quote: 'hello', rects: [] }
    const store: PdfAnnotationStore = {
      load: vi.fn(async () => [existing]),
      add: vi.fn(async () => ({ annotationId: '', annotations: [existing] })),
    }
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch,
      url: urlHarness().api,
      openPdfDocument: fakePdfOpener([
        { width: 612, height: 792, text: 'hello' },
        { width: 612, height: 792, text: 'world' },
      ]),
      annotationStore: store,
    })
    controller.setScope(contract('/cell'), { kind: 'artifact', graphId: 'g', artifactId: 'a1' })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    expect(controller.snapshot().mode).toBe('original')

    // Mode is pure view state: no fetch, no store traffic, no reload.
    controller.setMode('annotations')
    expect(controller.snapshot().mode).toBe('annotations')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.load).toHaveBeenCalledOnce()
    expect(store.add).not.toHaveBeenCalled()
    controller.setMode('annotations')
    expect(controller.snapshot().mode).toBe('annotations')

    // open-original returns to Original with the annotation active at its page.
    controller.openAnnotation('block-existing')
    const snapshot = controller.snapshot()
    expect(snapshot.mode).toBe('original')
    expect(snapshot.activeAnnotationId).toBe('block-existing')
    expect(snapshot.pageNumber).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(1)

    // A scope change resets to Original.
    controller.setMode('annotations')
    controller.setScope(contract('/cell'), { kind: 'artifact', graphId: 'g', artifactId: 'a2' })
    expect(controller.snapshot().mode).toBe('original')
  })

  it('keeps the PDF readable when the companion cannot be loaded', async () => {
    const controller = new OrganismPdfReaderController({
      requestRender: vi.fn(),
      fetch: (async () => binaryResponse('%PDF bytes', 'paper.pdf')) as unknown as typeof globalThis.fetch,
      url: urlHarness().api,
      openPdfDocument: fakePdfOpener([{ width: 612, height: 792, text: 'hello' }]),
      annotationStore: {
        load: async () => { throw new Error('companion unavailable') },
        add: async () => { throw new Error('must not write') },
      },
    })
    controller.setScope(contract('/cell'), { kind: 'artifact', graphId: 'g', artifactId: 'a1' })
    await vi.waitFor(() => expect(controller.snapshot().status).toBe('ready'))
    expect(controller.snapshot().canAnnotate).toBe(false)
    expect(controller.snapshot().annotationError).toBe('companion unavailable')
    expect(controller.snapshot().pages).toHaveLength(1)
  })
})
