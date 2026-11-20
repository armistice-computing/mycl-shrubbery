/**
 * pdf-service — the organism cell's single pdf.js seam.
 *
 * Tests run against a FAKE engine implementing the structural PdfJsModuleLike
 * interface (no real pdf.js, no worker), proving page-meta enumeration, the
 * y-up → top-left coordinate math, embedded-annotation normalization and quote
 * recovery, canvas rasterization plumbing, abort behavior, and cleanup.
 */
import { describe, expect, it } from 'vitest'
import {
  openPdf,
  pdfPageTextItems,
  pdfWasmBaseUrl,
  transform2d,
  type PdfJsDocumentLike,
  type PdfJsModuleLike,
  type PdfJsPageLike,
} from '../pdf-service.js'

interface FakePageSpec {
  readonly width: number
  readonly height: number
  readonly items: readonly unknown[]
  readonly annotations?: readonly unknown[]
  readonly annotationError?: Error
}

function fakeEngine(pageSpecs: readonly FakePageSpec[]): {
  readonly module: PdfJsModuleLike
  readonly calls: {
    getDocument: number
    destroyed: boolean
    renderScales: number[]
    annotationIntents: string[]
    cleanups: number
    config?: Record<string, unknown>
  }
} {
  const calls = {
    getDocument: 0,
    destroyed: false,
    renderScales: [] as number[],
    annotationIntents: [] as string[],
    cleanups: 0,
    config: undefined as Record<string, unknown> | undefined,
  }
  const pages: PdfJsPageLike[] = pageSpecs.map((spec) => ({
    getViewport: ({ scale }) => ({
      width: spec.width * scale,
      height: spec.height * scale,
      // Standard y-up → y-down flip viewport transform.
      transform: [scale, 0, 0, -scale, 0, spec.height * scale],
    }),
    getTextContent: () => Promise.resolve({ items: spec.items }),
    ...(spec.annotations !== undefined || spec.annotationError ? {
      getAnnotations: ({ intent }: { readonly intent: 'display' }) => {
        calls.annotationIntents.push(intent)
        return spec.annotationError
          ? Promise.reject(spec.annotationError)
          : Promise.resolve(spec.annotations ?? [])
      },
    } : {}),
    render: ({ viewport }) => {
      calls.renderScales.push(viewport.width / spec.width)
      return { promise: Promise.resolve() }
    },
    cleanup: () => {
      calls.cleanups += 1
    },
  }))
  const document: PdfJsDocumentLike = {
    numPages: pages.length,
    getPage: (pageNumber) => {
      const page = pages[pageNumber - 1]
      return page ? Promise.resolve(page) : Promise.reject(new Error(`no page ${pageNumber}`))
    },
  }
  const module: PdfJsModuleLike = {
    getDocument: config => {
      calls.getDocument += 1
      calls.config = config
      return {
        promise: Promise.resolve(document),
        destroy: () => {
          calls.destroyed = true
          return Promise.resolve()
        },
      }
    },
  }
  return { module, calls }
}

function fakeCanvas(): () => { width: number; height: number; getContext: () => object; toDataURL: () => string } {
  return () => ({
    width: 0,
    height: 0,
    getContext: () => ({ fake: true }),
    toDataURL: () => 'data:image/png;base64,fakepng',
  })
}

describe('pdf-service', () => {
  it('transform2d multiplies affine matrices with pdf.js Util.transform semantics', () => {
    // Viewport flip (scale 1, height 792) ∘ item transform [12,0,0,12,50,700].
    const tx = transform2d([1, 0, 0, -1, 0, 792], [12, 0, 0, 12, 50, 700])
    expect(tx).toEqual([12, 0, 0, -12, 50, 92])
  })

  it('converts text items to top-left-origin page-space items and drops blanks', () => {
    const items = pdfPageTextItems(
      {
        items: [
          // Font 12pt at user-space (50, 700) on a 792-tall page.
          { str: 'hello', transform: [12, 0, 0, 12, 50, 700], width: 60 },
          { str: '   ', transform: [12, 0, 0, 12, 100, 700], width: 12 },
          'not-an-item',
          { str: 'world', transform: [12, 0, 0, 12, 110, 700], width: 60 },
        ],
      },
      { width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] },
      1,
    )
    expect(items).toEqual([
      // y = (792 - 700) - 12 = 80: top-left origin, span top above the baseline.
      { id: 'p1-t0', text: 'hello', x: 50, y: 80, width: 60, height: 12 },
      { id: 'p1-t1', text: 'world', x: 110, y: 80, width: 60, height: 12 },
    ])
  })

  it('supplies the packaged WASM decoders needed by scanned PDF images', async () => {
    const { module, calls } = fakeEngine([{ width: 612, height: 792, items: [] }])
    const pdf = await openPdf(new Uint8Array([1]), { pdfJs: module })

    expect(calls.config).toMatchObject({ useWasm: true, wasmUrl: pdfWasmBaseUrl() })
    expect(pdfWasmBaseUrl()).toMatch(/pdfjs-wasm\/$/)
    await pdf.destroy()
  })

  it('enumerates page dimensions and text items per page', async () => {
    const { module } = fakeEngine([
      { width: 612, height: 792, items: [{ str: 'a', transform: [10, 0, 0, 10, 20, 770], width: 10 }] },
      { width: 612, height: 396, items: [] },
    ])
    const pdf = await openPdf(new Uint8Array([1, 2, 3]), { pdfJs: module })
    expect(pdf.numPages).toBe(2)

    const first = await pdf.pageMeta(1)
    expect(first.width).toBe(612)
    expect(first.height).toBe(792)
    expect(first.textItems).toHaveLength(1)
    expect(first.textItems[0]).toMatchObject({ text: 'a', x: 20, y: 12, width: 10, height: 10 })

    const second = await pdf.pageMeta(2)
    expect(second.height).toBe(396)
    expect(second.textItems).toEqual([])

    await expect(pdf.pageMeta(3)).rejects.toThrow('out of range')
    await pdf.destroy()
  })

  it('normalizes highlight quads and Text note rects, skipping popups and other types', async () => {
    const { module, calls } = fakeEngine([{
      width: 300,
      height: 200,
      items: [
        { str: 'alpha', transform: [10, 0, 0, 10, 20, 100], width: 50 },
        { str: 'beta', transform: [10, 0, 0, 10, 80, 100], width: 40 },
      ],
      annotations: [
        {
          id: 'raw-highlight-id',
          annotationType: 9,
          quadPoints: new Float32Array([
            20, 110, 70, 110, 20, 100, 70, 100,
            80, 110, 120, 110, 80, 100, 120, 100,
          ]),
          titleObj: { str: '  Alice  ' },
          contentsObj: { str: '  Highlight note  ' },
          color: new Uint8ClampedArray([255, 128, 0]),
        },
        {
          id: 'raw-note-id',
          annotationType: 1,
          rect: [150, 20, 170, 40],
          titleObj: { str: 'Bob' },
          contentsObj: { str: 'Standalone thought' },
          color: [0, 128, 255],
        },
        { id: 'popup-id', annotationType: 16, contentsObj: { str: 'Popup duplicate' } },
        { id: 'underline-id', annotationType: 10, contentsObj: { str: 'Unsupported' } },
        null,
      ],
    }])
    const pdf = await openPdf(new Uint8Array([1]), { pdfJs: module })
    const meta = await pdf.pageMeta(1)

    expect(calls.annotationIntents).toEqual(['display'])
    expect(meta.embeddedAnnotations).toEqual([
      {
        id: 'raw-highlight-id',
        kind: 'highlight',
        pageNumber: 1,
        label: 'Alice',
        note: 'Highlight note',
        quote: 'alpha beta',
        prefix: '',
        suffix: '',
        rects: [[20, 90, 50, 10], [80, 90, 40, 10]],
        color: 'rgba(255, 128, 0, 0.35)',
      },
      {
        id: 'raw-note-id',
        kind: 'note',
        pageNumber: 1,
        label: 'Bob',
        note: 'Standalone thought',
        quote: '',
        prefix: '',
        suffix: '',
        rects: [[150, 160, 20, 20]],
        color: 'rgba(0, 128, 255, 0.35)',
      },
    ])
    await pdf.destroy()
  })

  it('recovers the exact highlighted item and forty characters of context', async () => {
    const before = '1234567890'.repeat(5)
    const after = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const { module } = fakeEngine([{
      width: 1400,
      height: 200,
      items: [
        { str: before, transform: [10, 0, 0, 10, 10, 100], width: 500 },
        { str: 'HIGHLIGHT', transform: [10, 0, 0, 10, 520, 100], width: 90 },
        { str: after, transform: [10, 0, 0, 10, 620, 100], width: 620 },
      ],
      annotations: [{
        id: 'context-highlight',
        annotationType: 9,
        quadPoints: [520, 110, 610, 110, 520, 100, 610, 100],
        contentsObj: { str: 'This is the note, not the quote' },
      }],
    }])
    const pdf = await openPdf(new Uint8Array([1]), { pdfJs: module })
    const meta = await pdf.pageMeta(1)
    const annotation = meta.embeddedAnnotations[0]

    expect(annotation).toMatchObject({
      quote: 'HIGHLIGHT',
      note: 'This is the note, not the quote',
    })
    expect(annotation?.prefix).toBe(`${before.slice(-39)} `)
    expect(annotation?.suffix).toBe(` ${after.slice(0, 39)}`)
    expect(annotation?.prefix).toHaveLength(40)
    expect(annotation?.suffix).toHaveLength(40)
    await pdf.destroy()
  })

  it('recovers the 18pt Harness quote without rescaling its page-unit width', async () => {
    const { module } = fakeEngine([{
      width: 612,
      height: 792,
      items: [
        { str: 'Harness Oracle', transform: [18, 0, 0, 18, 72, 720], width: 125.028 },
      ],
      annotations: [{
        id: 'harness-highlight',
        annotationType: 9,
        quadPoints: [72, 738, 250, 738, 72, 720, 250, 720],
      }],
    }])
    const pdf = await openPdf(new Uint8Array([1]), { pdfJs: module })
    const meta = await pdf.pageMeta(1)

    expect(meta.textItems).toEqual([
      { id: 'p1-t0', text: 'Harness Oracle', x: 72, y: 54, width: 125.03, height: 18 },
    ])
    expect(meta.embeddedAnnotations[0]).toMatchObject({
      id: 'harness-highlight',
      quote: 'Harness Oracle',
      prefix: '',
      suffix: '',
      rects: [[72, 54, 178, 18]],
    })
    await pdf.destroy()
  })

  it('keeps quote and context empty when a contiguous exact match is uncertain', async () => {
    const { module } = fakeEngine([{
      width: 300,
      height: 200,
      items: [
        { str: 'alpha', transform: [10, 0, 0, 10, 20, 100], width: 50 },
        { str: 'middle', transform: [10, 0, 0, 10, 80, 100], width: 50 },
        { str: 'omega', transform: [10, 0, 0, 10, 140, 100], width: 50 },
      ],
      annotations: [
        {
          id: 'disjoint-highlight',
          annotationType: 9,
          quadPoints: [
            20, 110, 70, 110, 20, 100, 70, 100,
            140, 110, 190, 110, 140, 100, 190, 100,
          ],
          contentsObj: { str: 'Keep the note even without a quote' },
        },
        {
          id: 'partial-item-highlight',
          annotationType: 9,
          quadPoints: [80, 110, 100, 110, 80, 100, 100, 100],
        },
      ],
    }])
    const pdf = await openPdf(new Uint8Array([1]), { pdfJs: module })
    const meta = await pdf.pageMeta(1)

    expect(meta.embeddedAnnotations[0]).toMatchObject({
      note: 'Keep the note even without a quote',
      quote: '',
      prefix: '',
      suffix: '',
    })
    expect(meta.embeddedAnnotations[1]).toMatchObject({
      id: 'partial-item-highlight',
      quote: '',
      prefix: '',
      suffix: '',
    })
    await pdf.destroy()
  })

  it('returns no embedded annotations when getAnnotations is unavailable', async () => {
    const { module, calls } = fakeEngine([{ width: 300, height: 200, items: [] }])
    const pdf = await openPdf(new Uint8Array([1]), { pdfJs: module })
    const meta = await pdf.pageMeta(1)

    expect(meta.embeddedAnnotations).toEqual([])
    expect(calls.annotationIntents).toEqual([])
    expect(calls.cleanups).toBe(1)
    await pdf.destroy()
  })

  it('cleans up the page when embedded annotation extraction fails', async () => {
    const { module, calls } = fakeEngine([{
      width: 300,
      height: 200,
      items: [],
      annotations: [],
      annotationError: new Error('annotation read failed'),
    }])
    const pdf = await openPdf(new Uint8Array([1]), { pdfJs: module })

    await expect(pdf.pageMeta(1)).rejects.toThrow('annotation read failed')
    expect(calls.cleanups).toBe(1)
    await pdf.destroy()
  })

  it('rasterizes pages through the injected canvas at the requested scale', async () => {
    const { module, calls } = fakeEngine([{ width: 612, height: 792, items: [] }])
    const pdf = await openPdf(new Uint8Array([1]), { pdfJs: module, createCanvas: fakeCanvas() })
    const dataUrl = await pdf.renderPage(1, 2)
    expect(dataUrl).toBe('data:image/png;base64,fakepng')
    expect(calls.renderScales).toEqual([2])
    await pdf.destroy()
    expect(calls.destroyed).toBe(true)
  })

  it('rejects work on a destroyed document and honors an aborted signal', async () => {
    const { module } = fakeEngine([{ width: 612, height: 792, items: [] }])
    const pdf = await openPdf(new Uint8Array([1]), { pdfJs: module })
    await pdf.destroy()
    await expect(pdf.pageMeta(1)).rejects.toThrow('closed')

    const abort = new AbortController()
    abort.abort()
    await expect(openPdf(new Uint8Array([1]), { pdfJs: module, signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
