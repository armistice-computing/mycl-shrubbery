/**
 * REAL component test - mn-original-viewer controlled original-file surface.
 *
 * The element renders caller-owned preview data and emits composed intents. It
 * does not read native files, refresh URLs, run pdfjs, build EPUB previews, or
 * decorate annotations by itself.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import '../mn-original-viewer.js'
import type {
  MnOriginalViewer,
  MnOriginalViewerAnnotationDetail,
  MnOriginalViewerChapterDetail,
  MnOriginalViewerIntentDetail,
} from '../mn-original-viewer.js'
import type { MnPdfReader } from '../mn-pdf-reader.js'
import type { MnPdfAnnotationView } from '../mn-pdf-annotation-view.js'

async function mount(setup?: (el: MnOriginalViewer) => void): Promise<MnOriginalViewer> {
  const el = document.createElement('mn-original-viewer') as MnOriginalViewer
  setup?.(el)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

const sr = (el: MnOriginalViewer) => el.shadowRoot!

describe('mn-original-viewer - real custom element', () => {
  beforeAll(() => {
    expect(customElements.get('mn-original-viewer')).toBeDefined()
  })

  it('renders loading and error states from controlled status props', async () => {
    const el = await mount((node) => {
      node.status = 'loading'
    })
    expect(sr(el).querySelector('mn-loading')).not.toBeNull()

    el.status = 'error'
    el.error = 'read failed'
    await el.updateComplete
    const empty = sr(el).querySelector('mn-empty-state')!
    expect(empty.getAttribute('title')).toBe('Original file failed')
    expect(empty.getAttribute('description')).toBe('read failed')
  })

  it('renders text originals and emits reload/download intents', async () => {
    const el = await mount((node) => {
      node.status = 'ready'
      node.kind = 'text'
      node.graphId = 'graph-a'
      node.documentId = 'doc-a'
      node.filename = 'notes.txt'
      node.text = 'Original text body'
      node.downloadable = true
    })
    const reloads: MnOriginalViewerIntentDetail[] = []
    const downloads: MnOriginalViewerIntentDetail[] = []
    el.addEventListener('mn-original-viewer-reload', (event) => {
      reloads.push((event as CustomEvent<MnOriginalViewerIntentDetail>).detail)
    })
    el.addEventListener('mn-original-viewer-download', (event) => {
      downloads.push((event as CustomEvent<MnOriginalViewerIntentDetail>).detail)
    })

    expect(sr(el).querySelector('.source-pre')?.textContent).toBe('Original text body')
    ;(sr(el).querySelector('[aria-label="Reload original file"]') as HTMLButtonElement).click()
    ;(sr(el).querySelector('[aria-label="Download original file"]') as HTMLButtonElement).click()

    expect(reloads).toEqual([{ graphId: 'graph-a', documentId: 'doc-a' }])
    expect(downloads).toEqual([{ graphId: 'graph-a', documentId: 'doc-a' }])
  })

  it('renders iframe HTML and annotation rail as controlled data', async () => {
    const el = await mount((node) => {
      node.status = 'ready'
      node.kind = 'html'
      node.graphId = 'graph-a'
      node.documentId = 'doc-a'
      node.filename = 'source.html'
      node.srcdoc = '<h1>Original</h1>'
      node.annotations = [
        { id: 'ann-1', label: 'Source comment', quote: 'Important sentence', pageNumber: 2 },
      ]
    })
    const annotations: MnOriginalViewerAnnotationDetail[] = []
    el.addEventListener('mn-original-viewer-annotation-select', (event) => {
      annotations.push((event as CustomEvent<MnOriginalViewerAnnotationDetail>).detail)
    })

    const frame = sr(el).querySelector('iframe') as HTMLIFrameElement
    expect(frame).not.toBeNull()
    expect(frame.srcdoc).toBe('<h1>Original</h1>')
    expect(sr(el).querySelector('.annotation-rail')?.textContent).toContain('Important sentence')

    ;(sr(el).querySelector('[data-annotation-id="ann-1"]') as HTMLButtonElement).click()
    expect(annotations[0]).toMatchObject({
      graphId: 'graph-a',
      documentId: 'doc-a',
      annotationId: 'ann-1',
    })
  })

  it('renders EPUB chapters and emits chapter selection intents', async () => {
    const el = await mount((node) => {
      node.status = 'ready'
      node.kind = 'epub'
      node.graphId = 'graph-a'
      node.documentId = 'doc-a'
      node.title = 'Book'
      node.chapters = [
        { id: 'c1', title: 'Intro', text: 'Intro text' },
        { id: 'c2', title: 'Chapter Two', text: 'Second text' },
      ]
    })
    const chapters: MnOriginalViewerChapterDetail[] = []
    el.addEventListener('mn-original-viewer-chapter-select', (event) => {
      chapters.push((event as CustomEvent<MnOriginalViewerChapterDetail>).detail)
    })

    expect(sr(el).querySelector('.source-pre')?.textContent).toBe('Intro text')
    const chapterTwo = Array.from(sr(el).querySelectorAll('.chapter-button')).find((button) => button.textContent === 'Chapter Two') as HTMLButtonElement
    chapterTwo.click()

    expect(chapters[0]).toMatchObject({
      graphId: 'graph-a',
      documentId: 'doc-a',
      chapterId: 'c2',
    })
  })

  it('renders controlled PDF page previews and file fallback actions', async () => {
    const pdf = await mount((node) => {
      node.status = 'ready'
      node.kind = 'pdf'
      node.filename = 'paper.pdf'
      node.pages = [
        { pageNumber: 1, width: 612, height: 792, imageUrl: 'data:image/png;base64,abc' },
        { pageNumber: 2, width: 612, height: 792 },
      ]
    })
    expect(sr(pdf).querySelectorAll('.pdf-page')).toHaveLength(2)
    expect(sr(pdf).querySelector('.pdf-image')?.getAttribute('src')).toBe('data:image/png;base64,abc')
    expect(sr(pdf).querySelector('.pdf-placeholder')?.textContent).toContain('Page 2')

    const file = await mount((node) => {
      node.status = 'ready'
      node.kind = 'file'
      node.graphId = 'graph-a'
      node.documentId = 'doc-file'
      node.filename = 'archive.zip'
      node.externalOpenable = true
    })
    const opens: MnOriginalViewerIntentDetail[] = []
    file.addEventListener('mn-original-viewer-open-external', (event) => {
      opens.push((event as CustomEvent<MnOriginalViewerIntentDetail>).detail)
    })

    const open = Array.from(sr(file).querySelectorAll('button')).find((button) => button.textContent?.includes('Open')) as HTMLButtonElement
    open.click()
    expect(opens).toEqual([{ graphId: 'graph-a', documentId: 'doc-file' }])
  })

  it('mounts the controlled mn-pdf-reader for PDFs with reader state, replacing the blob iframe', async () => {
    const el = await mount((node) => {
      node.status = 'ready'
      node.kind = 'pdf'
      node.filename = 'paper.pdf'
      node.src = 'blob:legacy-iframe-src'
      node.pdf = {
        status: 'ready',
        error: '',
        pages: [
          {
            pageNumber: 1,
            width: 612,
            height: 792,
            textItems: [{ id: 't1', text: 'original text', x: 12, y: 24, width: 70, height: 12 }],
          },
        ],
        annotations: [],
        canAnnotate: false,
        downloadable: true,
        externalOpenable: false,
        zoom: 1.5,
        pageNumber: 1,
      }
    })
    const downloads: unknown[] = []
    const reloads: unknown[] = []
    el.addEventListener('mn-pdf-download', (event) => {
      downloads.push((event as CustomEvent).detail)
    })
    el.addEventListener('mn-pdf-reload', (event) => {
      reloads.push((event as CustomEvent).detail)
    })

    // The controlled reader owns the surface and its toolbar — no blob iframe,
    // no legacy preview pages, and no duplicate original-viewer header.
    expect(sr(el).querySelector('iframe')).toBeNull()
    expect(sr(el).querySelector('.toolbar')).toBeNull()
    const reader = sr(el).querySelector('mn-pdf-reader') as MnPdfReader | null
    expect(reader).not.toBeNull()
    await reader!.updateComplete
    expect(reader!.zoom).toBe(1.5)
    expect(reader!.shadowRoot!.querySelector('.pdf-text-layer span')?.textContent).toBe('original text')
    // Intents bubble composed through the viewer host unchanged.
    ;(reader!.shadowRoot!.querySelector('[aria-label="Download PDF"]') as HTMLButtonElement).click()
    expect(downloads).toEqual([{ filename: 'paper.pdf' }])
    ;(reader!.shadowRoot!.querySelector('[aria-label="Reload PDF"]') as HTMLButtonElement).click()
    expect(reloads).toEqual([{ filename: 'paper.pdf' }])
  })

  it('renders the shared annotation list in Annotations mode and unmounts the reader', async () => {
    const el = await mount((node) => {
      node.status = 'ready'
      node.kind = 'pdf'
      node.filename = 'paper.pdf'
      node.pdf = {
        status: 'ready',
        error: '',
        pages: [
          {
            pageNumber: 1,
            width: 612,
            height: 792,
            textItems: [{ id: 't1', text: 'original text', x: 12, y: 24, width: 70, height: 12 }],
          },
        ],
        annotations: [
          { id: 'ann-1', pageNumber: 1, quote: 'quoted text', kind: 'highlight', source: 'reader', rects: [] },
        ],
        activeAnnotationId: '',
        canAnnotate: true,
        downloadable: true,
        externalOpenable: false,
        zoom: 1,
        pageNumber: 1,
      }
    })
    expect(sr(el).querySelector('mn-pdf-reader')).not.toBeNull()

    const selected: string[] = []
    const opened: string[] = []
    el.addEventListener('mn-pdf-annotation-select', (event) => {
      selected.push((event as CustomEvent<{ annotationId: string }>).detail.annotationId)
    })
    el.addEventListener('mn-pdf-annotation-open-original', (event) => {
      opened.push((event as CustomEvent<{ annotationId: string }>).detail.annotationId)
    })

    el.pdf = { ...el.pdf!, mode: 'annotations' }
    await el.updateComplete

    // The reader unmounted — disconnect removes its light-DOM selection
    // layer — and the shared annotation component owns the surface.
    expect(sr(el).querySelector('mn-pdf-reader')).toBeNull()
    const list = sr(el).querySelector('mn-pdf-annotation-view') as MnPdfAnnotationView | null
    expect(list).not.toBeNull()
    await list!.updateComplete
    expect(list!.shadowRoot!.textContent).toContain('quoted text')
    ;(list!.shadowRoot!.querySelector('.annotation-main') as HTMLButtonElement).click()
    expect(selected).toEqual(['ann-1'])
    ;(list!.shadowRoot!.querySelector('.annotation-open') as HTMLButtonElement).click()
    expect(opened).toEqual(['ann-1'])

    // Back to Original the reader remounts.
    el.pdf = { ...el.pdf!, mode: 'original' }
    await el.updateComplete
    expect(sr(el).querySelector('mn-pdf-annotation-view')).toBeNull()
    expect(sr(el).querySelector('mn-pdf-reader')).not.toBeNull()
  })

  it('keeps the legacy PDF iframe path when no reader state is supplied', async () => {
    const el = await mount((node) => {
      node.status = 'ready'
      node.kind = 'pdf'
      node.filename = 'paper.pdf'
      node.src = 'blob:legacy-iframe-src'
    })
    expect(sr(el).querySelector('mn-pdf-reader')).toBeNull()
    expect(sr(el).querySelector('.toolbar')).not.toBeNull()
    expect(sr(el).querySelector('iframe')?.getAttribute('src')).toBe('blob:legacy-iframe-src')
  })
})
