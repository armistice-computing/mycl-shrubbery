/**
 * Browser-harness entry for the controlled PDF reader and shared annotations.
 *
 * Boots the REAL pieces against a REAL spawned gardend cell (coordinates arrive
 * as query params from scripts/pdf-reader-browser.mts): the shell-owned
 * OrganismPdfReaderController in artifact scope, mounted through the controlled
 * <mn-artifact-view> → <mn-pdf-reader> surface. A __pdfReaderHarness bridge on
 * window exposes the controller snapshot and captured intents for the driver.
 */
import '@shrubbery/components'
import type {
  MnArtifactPdfModeDetail,
  MnArtifactView,
  MnPdfAnnotateDetail,
  MnPdfAnnotation,
  MnPdfAnnotationOpenOriginalDetail,
  MnPdfAnnotationSelectDetail,
  MnPdfSelectionDetail,
  MnPdfTextItem,
} from '@shrubbery/components'
import { OrganismPdfReaderController } from '../cell/pdf-reader-controller.js'
import { LoopbackMcpClient } from '../cell/loopback-mcp.js'

interface HarnessState {
  ready: boolean
  error: string | null
  status: string
  filename: string
  pageCount: number
  firstPageWidth: number
  firstPageHeight: number
  textItemCount: number
  textItems: readonly MnPdfTextItem[]
  pageImages: number
  zoom: number
  pageNumber: number
  mode: string
  canAnnotate: boolean
  annotationError: string
  annotations: readonly MnPdfAnnotation[]
  activeAnnotationId: string
  readyCount: number
  selection: MnPdfSelectionDetail | null
  downloads: Array<{ url: string; filename: string }>
  opens: string[]
}

const state: HarnessState = {
  ready: false,
  error: null,
  status: 'idle',
  filename: '',
  pageCount: 0,
  firstPageWidth: 0,
  firstPageHeight: 0,
  textItemCount: 0,
  textItems: [],
  pageImages: 0,
  zoom: 1,
  pageNumber: 0,
  mode: 'original',
  canAnnotate: false,
  annotationError: '',
  annotations: [],
  activeAnnotationId: '',
  readyCount: 0,
  selection: null,
  downloads: [],
  opens: [],
}

const params = new URLSearchParams(window.location.search)
const apiUrl = (params.get('apiUrl') ?? '').replace(/\/+$/, '')
const mcpUrl = (params.get('mcpUrl') ?? '').replace(/\/+$/, '')
const token = params.get('token') ?? ''
const graphId = params.get('graphId') ?? ''
const artifactId = params.get('artifactId') ?? ''
const title = params.get('title') ?? 'harness.pdf'
const requestedPage = Number(params.get('page') ?? '0')
let requestedPageApplied = false

const root = document.getElementById('pdf-reader-harness-root')!
const view = document.createElement('mn-artifact-view') as MnArtifactView
root.appendChild(view)
const mcp = new LoopbackMcpClient({
  mcpUrl,
  healthUrl: `${apiUrl}/health`,
  token,
  origin: window.location.origin,
})

const controller = new OrganismPdfReaderController({
  requestRender: () => render(),
  download: (url, filename) => {
    state.downloads.push({ url, filename })
    sync()
  },
  openExternal: (url) => {
    state.opens.push(url)
    sync()
  },
})

function sync(): void {
  const snapshot = controller.snapshot()
  if (snapshot.status === 'ready' && state.status !== 'ready') state.readyCount += 1
  state.status = snapshot.status
  state.filename = snapshot.filename
  state.pageCount = snapshot.pages.length
  state.firstPageWidth = snapshot.pages[0]?.width ?? 0
  state.firstPageHeight = snapshot.pages[0]?.height ?? 0
  state.textItemCount = snapshot.pages[0]?.textItems.length ?? 0
  state.textItems = snapshot.pages[0]?.textItems ?? []
  state.pageImages = snapshot.pages.filter((page) => page.imageUrl).length
  state.zoom = snapshot.zoom
  state.pageNumber = snapshot.pageNumber
  state.mode = snapshot.mode
  state.canAnnotate = snapshot.canAnnotate
  state.annotationError = snapshot.annotationError
  state.annotations = snapshot.annotations
  state.activeAnnotationId = snapshot.activeAnnotationId
}

function render(): void {
  const snapshot = controller.snapshot()
  sync()
  if (snapshot.status === 'ready' && !requestedPageApplied && requestedPage > 0) {
    requestedPageApplied = true
    controller.setPageNumber(requestedPage)
    return
  }
  view.graphId = graphId
  view.artifactId = artifactId
  view.title = title
  view.mimeType = 'application/pdf'
  view.fileType = 'pdf'
  view.artifactStatus = 'ready'
  view.status = 'ready'
  view.pdf = snapshot
}

view.addEventListener('mn-pdf-page-visible', (event) => {
  controller.handlePageVisible((event as CustomEvent<{ pageNumber: number }>).detail.pageNumber)
})
view.addEventListener('mn-pdf-page-change', (event) => {
  controller.setPageNumber((event as CustomEvent<{ pageNumber: number }>).detail.pageNumber)
})
view.addEventListener('mn-pdf-zoom-change', (event) => {
  controller.setZoom((event as CustomEvent<{ zoom: number }>).detail.zoom)
})
view.addEventListener('mn-pdf-download', () => controller.download())
view.addEventListener('mn-pdf-open-external', () => controller.openExternal())
view.addEventListener('mn-pdf-reload', () => { void controller.reload() })
view.addEventListener('mn-artifact-pdf-mode-change', (event) => {
  controller.setMode((event as CustomEvent<MnArtifactPdfModeDetail>).detail.mode)
})
view.addEventListener('mn-pdf-annotation-open-original', (event) => {
  controller.openAnnotation((event as CustomEvent<MnPdfAnnotationOpenOriginalDetail>).detail.annotationId)
})
view.addEventListener('mn-pdf-highlight', (event) => {
  void controller.highlight((event as CustomEvent<MnPdfAnnotateDetail>).detail)
})
view.addEventListener('mn-pdf-note', (event) => {
  void controller.note((event as CustomEvent<MnPdfAnnotateDetail>).detail)
})
view.addEventListener('mn-pdf-annotation-select', (event) => {
  controller.selectAnnotation((event as CustomEvent<MnPdfAnnotationSelectDetail>).detail.annotationId)
})
view.addEventListener('mn-pdf-selection', (event) => {
  state.selection = (event as CustomEvent<MnPdfSelectionDetail | null>).detail
})

;(window as unknown as { __pdfReaderHarness: { state: HarnessState } }).__pdfReaderHarness = { state }

if (!apiUrl || !mcpUrl || !token || !graphId || !artifactId) {
  state.error = 'missing cell coordinates in query params'
} else {
  controller.setScope(
    {
      auth: {
        token: () => token,
        userId: () => 'pdf-reader-harness',
        isAuthenticated: () => true,
        whenReady: () => Promise.resolve(),
        onChange: () => () => undefined,
      },
      runtime: {
        mode: () => 'local',
        isGateway: () => false,
        graphBaseUrl: () => apiUrl,
      },
      mcp,
      ui: {
        prompt: async () => 'Harness note',
        confirm: async () => true,
        icon: () => ({}) as never,
        presenceColors: [],
      },
    },
    { kind: 'artifact', graphId, artifactId, ingestedDocumentId: 'pdf-reader-harness-ingested' },
  )
  render()
  state.ready = true
}
