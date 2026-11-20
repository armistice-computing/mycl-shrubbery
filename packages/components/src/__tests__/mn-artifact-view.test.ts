/**
 * REAL component test - mn-artifact-view controlled artifact surface.
 *
 * The element renders caller-owned preview state and emits composed intents. It
 * does not fetch artifact bytes or own object URL lifetime.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import '../mn-artifact-view.js'
import type {
  MnArtifactIntentDetail,
  MnArtifactOpenDocumentDetail,
  MnArtifactPdfModeDetail,
  MnArtifactView,
} from '../mn-artifact-view.js'
import type { MnPdfReader, MnPdfReaderView, MnPdfZoomChangeDetail } from '../mn-pdf-reader.js'
import type { MnPdfAnnotationView } from '../mn-pdf-annotation-view.js'

async function mount(setup?: (el: MnArtifactView) => void): Promise<MnArtifactView> {
  const el = document.createElement('mn-artifact-view') as MnArtifactView
  setup?.(el)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

const sr = (el: MnArtifactView) => el.shadowRoot!

describe('mn-artifact-view - real custom element', () => {
  beforeAll(() => {
    expect(customElements.get('mn-artifact-view')).toBeDefined()
  })

  it('renders loading, error, and non-image ready states from controlled props', async () => {
    const el = await mount((node) => {
      node.title = 'report.pdf'
      node.mimeType = 'application/pdf'
      node.status = 'loading'
    })
    expect(sr(el).querySelector('mn-loading')).not.toBeNull()

    el.status = 'error'
    el.error = 'download failed'
    await el.updateComplete
    const error = sr(el).querySelector('mn-empty-state')!
    expect(error.getAttribute('title')).toBe('Could not load artifact')
    expect(error.getAttribute('description')).toBe('download failed')

    el.status = 'ready'
    el.error = ''
    await el.updateComplete
    const empty = sr(el).querySelector('mn-empty-state')!
    expect(empty.getAttribute('title')).toBe('No inline preview for pdf')
  })

  const PDF_VIEW: MnPdfReaderView = {
    status: 'ready',
    error: '',
    pages: [
      {
        pageNumber: 1,
        width: 612,
        height: 792,
        imageUrl: 'data:image/png;base64,page-one',
        textItems: [{ id: 't1', text: 'artifact text', x: 10, y: 10, width: 60, height: 12 }],
      },
    ],
    annotations: [],
    canAnnotate: false,
    downloadable: true,
    externalOpenable: true,
    zoom: 1,
    pageNumber: 1,
  }

  it('renders a PDF artifact as the controlled mn-pdf-reader and relays its intents', async () => {
    const el = await mount((node) => {
      node.graphId = 'graph-a'
      node.artifactId = 'artifact-pdf'
      node.title = 'paper.pdf'
      node.mimeType = 'application/pdf'
      node.status = 'ready'
      node.pdf = PDF_VIEW
    })
    const zooms: MnPdfZoomChangeDetail[] = []
    el.addEventListener('mn-pdf-zoom-change', (event) => {
      zooms.push((event as CustomEvent<MnPdfZoomChangeDetail>).detail)
    })

    // The reader is the surface; the "No inline preview" state is gone.
    expect(sr(el).querySelector('mn-empty-state')).toBeNull()
    const reader = sr(el).querySelector('mn-pdf-reader') as MnPdfReader
    expect(reader).not.toBeNull()
    await reader.updateComplete
    expect(reader.pages).toHaveLength(1)
    expect(reader.zoom).toBe(1)
    expect(reader.shadowRoot!.querySelector('.pdf-image')?.getAttribute('src')).toBe('data:image/png;base64,page-one')

    // Intents from inside the reader bubble composed through this host.
    ;(reader.shadowRoot!.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement).click()
    expect(zooms).toEqual([{ zoom: 1.2, mode: 'in' }])
  })

  it('offers Original/Annotations controls on PDF artifacts and mounts the shared annotation list in Annotations mode', async () => {
    const el = await mount((node) => {
      node.graphId = 'graph-a'
      node.artifactId = 'artifact-pdf'
      node.title = 'paper.pdf'
      node.mimeType = 'application/pdf'
      node.status = 'ready'
      node.pdf = {
        ...PDF_VIEW,
        annotations: [
          { id: 'ann-1', pageNumber: 1, quote: 'artifact quote', kind: 'highlight', source: 'reader', rects: [] },
        ],
      }
    })
    const modes: MnArtifactPdfModeDetail[] = []
    const opened: string[] = []
    el.addEventListener('mn-artifact-pdf-mode-change', (event) => {
      modes.push((event as CustomEvent<MnArtifactPdfModeDetail>).detail)
    })
    el.addEventListener('mn-pdf-annotation-open-original', (event) => {
      opened.push((event as CustomEvent<{ annotationId: string }>).detail.annotationId)
    })

    const originalButton = sr(el).querySelector('[data-pdf-mode="original"]') as HTMLButtonElement
    const annotationsButton = sr(el).querySelector('[data-pdf-mode="annotations"]') as HTMLButtonElement
    expect(originalButton.getAttribute('aria-pressed')).toBe('true')
    expect(annotationsButton.getAttribute('aria-pressed')).toBe('false')
    annotationsButton.click()
    expect(modes).toEqual([{ graphId: 'graph-a', artifactId: 'artifact-pdf', mode: 'annotations' }])

    // The shell answers the intent by projecting the mode back down.
    el.pdf = { ...el.pdf!, mode: 'annotations' }
    await el.updateComplete
    expect(sr(el).querySelector('mn-pdf-reader')).toBeNull()
    const list = sr(el).querySelector('mn-pdf-annotation-view') as MnPdfAnnotationView | null
    expect(list).not.toBeNull()
    await list!.updateComplete
    expect(list!.shadowRoot!.textContent).toContain('artifact quote')
    ;(list!.shadowRoot!.querySelector('.annotation-open') as HTMLButtonElement).click()
    expect(opened).toEqual(['ann-1'])

    el.pdf = { ...el.pdf!, mode: 'original' }
    await el.updateComplete
    expect(sr(el).querySelector('mn-pdf-annotation-view')).toBeNull()
    expect(sr(el).querySelector('mn-pdf-reader')).not.toBeNull()
  })

  it('keeps the PDF empty-state fallback when no reader state is supplied', async () => {
    const el = await mount((node) => {
      node.mimeType = 'application/pdf'
      node.status = 'ready'
    })
    expect(sr(el).querySelector('mn-pdf-reader')).toBeNull()
    expect(sr(el).querySelector('mn-empty-state')?.getAttribute('title')).toBe('No inline preview for pdf')
  })

  it('renders an image preview URL and metadata without fetching', async () => {
    const el = await mount((node) => {
      node.graphId = 'graph-a'
      node.artifactId = 'artifact-a'
      node.title = 'diagram.png'
      node.mimeType = 'image/png'
      node.artifactStatus = 'ready'
      node.status = 'ready'
      node.previewUrl = 'blob:preview-a'
    })

    expect(sr(el).querySelector('.title')?.textContent).toBe('diagram.png')
    expect(sr(el).querySelector('.meta')?.textContent).toContain('Image')
    expect(sr(el).querySelector('.meta')?.textContent).toContain('image/png')
    const image = sr(el).querySelector('img') as HTMLImageElement | null
    expect(image).not.toBeNull()
    expect(image!.getAttribute('src')).toBe('blob:preview-a')
    expect(image!.getAttribute('alt')).toBe('diagram.png')
    // Non-PDF artifacts get no Original/Annotations controls.
    expect(sr(el).querySelector('[data-pdf-mode]')).toBeNull()
  })

  it('renders scene artifacts directly as the real Excalidraw canvas host', async () => {
    const el = await mount((node) => {
      node.graphId = 'graph-a'
      node.artifactId = 'scene-a'
      node.title = 'Architecture scene'
      node.mimeType = 'application/vnd.excalidraw+json'
      node.status = 'ready'
    })

    const canvas = sr(el).querySelector('mn-excalidraw-canvas') as HTMLElement & {
      graphId: string
      artifactId: string
      title: string
    }
    expect(canvas).not.toBeNull()
    expect(canvas.graphId).toBe('graph-a')
    expect(canvas.artifactId).toBe('scene-a')
    expect(canvas.title).toBe('Architecture scene')
    expect(sr(el).querySelector('.artifact-view')).toBeNull()
    expect(sr(el).querySelector('mn-empty-state')).toBeNull()
  })

  it('emits refresh, edit, history, download, and open-document intents', async () => {
    const el = await mount((node) => {
      node.graphId = 'graph-a'
      node.artifactId = 'artifact-a'
      node.ingestedDocumentId = 'doc-a'
      node.mimeType = 'image/png'
      node.previewUrl = 'blob:preview-a'
      node.status = 'ready'
    })
    const refreshes: MnArtifactIntentDetail[] = []
    const edits: MnArtifactIntentDetail[] = []
    const histories: MnArtifactIntentDetail[] = []
    const downloads: MnArtifactIntentDetail[] = []
    const opens: MnArtifactOpenDocumentDetail[] = []
    el.addEventListener('mn-artifact-refresh', (event) => {
      refreshes.push((event as CustomEvent<MnArtifactIntentDetail>).detail)
    })
    el.addEventListener('mn-artifact-history-open', (event) => {
      histories.push((event as CustomEvent<MnArtifactIntentDetail>).detail)
    })
    el.addEventListener('mn-artifact-edit-open', (event) => {
      edits.push((event as CustomEvent<MnArtifactIntentDetail>).detail)
    })
    el.addEventListener('mn-artifact-download', (event) => {
      downloads.push((event as CustomEvent<MnArtifactIntentDetail>).detail)
    })
    el.addEventListener('mn-artifact-open-document', (event) => {
      opens.push((event as CustomEvent<MnArtifactOpenDocumentDetail>).detail)
    })

    ;(sr(el).querySelector('[aria-label="Refresh artifact"]') as HTMLButtonElement).click()
    ;(sr(el).querySelector('[aria-label="Edit artifact"]') as HTMLButtonElement).click()
    ;(sr(el).querySelector('[aria-label="Open artifact history"]') as HTMLButtonElement).click()
    ;(sr(el).querySelector('[aria-label="Download artifact"]') as HTMLButtonElement).click()
    ;(sr(el).querySelector('[aria-label="Open ingested document"]') as HTMLButtonElement).click()

    expect(refreshes).toEqual([{ graphId: 'graph-a', artifactId: 'artifact-a' }])
    expect(edits).toEqual([{ graphId: 'graph-a', artifactId: 'artifact-a' }])
    expect(histories).toEqual([{ graphId: 'graph-a', artifactId: 'artifact-a' }])
    expect(downloads).toEqual([{ graphId: 'graph-a', artifactId: 'artifact-a' }])
    expect(opens).toEqual([{ graphId: 'graph-a', artifactId: 'artifact-a', documentId: 'doc-a' }])
  })
})
