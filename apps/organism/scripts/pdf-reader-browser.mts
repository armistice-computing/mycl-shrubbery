/**
 * pdf-reader-browser.mts — the controlled PDF reader against a REAL cell in
 * REAL WebKit (the engine Garden ships).
 *
 * What the happy-dom suites cannot prove, proved here:
 *   - pdf.js rasterizes a page to a canvas data URL when the reader's real
 *     IntersectionObserver reports it visible;
 *   - a real browser text selection over the transparent text layer yields
 *     page-space quads at the right coordinates;
 *   - the artifact-scope mount through mn-artifact-view renders pages and
 *     answers zoom/download intents.
 *
 *   pnpm -C apps/organism run test:pdf-reader-browser
 *   SHRUBBERY_HEADED=1 ... (watch it)
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { chromium, webkit, type Page } from 'playwright'
import { createServer } from 'vite'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'
import { resolveGardendBin, spawnGardend } from '../src/cell/spawn-gardend.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.SHRUBBERY_PDF_READER_BROWSER_PORT ?? 5223)
const headed = process.env.SHRUBBERY_HEADED === '1'
// WebKit is Garden's shipping engine (Tauri WKWebView) and the default. Both
// engines prove selection geometry: Chromium uses shadow-root selection, while
// WebKit uses the reader's light-DOM text layer because it retargets shadow-DOM
// selection boundaries to the host (verified 2026-10-19).
const engineName = process.env.SHRUBBERY_BROWSER === 'chromium' ? 'chromium' : 'webkit'
const GRAPH_ID = 'pdf-reader-harness'
const ARTIFACT_ID = 'pdf-reader-harness-oracle'
const PDF_FILENAME = 'harness-oracle.pdf'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`pdf-reader-browser assertion failed: ${message}`)
}

/** One-page PDF with "Harness Oracle" in 18pt Helvetica at (72, 720). */
function minimalPdf(text: string): Uint8Array {
  const escaped = text.replace(/([\\()])/g, '\\$1')
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R 7 0 R] >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '6 0 obj\n<< /Type /Annot /Subtype /Highlight /Rect [72 720 250 738] /QuadPoints [72 738 250 738 72 720 250 720] /Contents (Embedded highlight note) /T (Reviewer) /C [1 0.8 0] >>\nendobj\n',
    '7 0 obj\n<< /Type /Annot /Subtype /Text /Rect [400 650 420 670] /Contents (Embedded sticky note) /T (Reviewer) /Name /Comment >>\nendobj\n',
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body))
    body += object
  }
  const xrefOffset = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n`
  body += '0000000000 65535 f \n'
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return Buffer.from(binary, 'binary').toString('base64')
}

interface HarnessState {
  ready: boolean
  error: string | null
  status: string
  filename: string
  pageCount: number
  firstPageWidth: number
  firstPageHeight: number
  textItemCount: number
  textItems: Array<{ id: string; text: string; x: number; y: number; width: number; height: number }>
  pageImages: number
  zoom: number
  pageNumber: number
  mode: string
  canAnnotate: boolean
  annotationError: string
  annotations: Array<{
    id: string
    pageNumber: number
    quote: string
    note?: string
    rects: Array<[number, number, number, number]>
  }>
  activeAnnotationId: string
  readyCount: number
  selection: {
    pageNumber: number
    exact: string
    prefix: string
    suffix: string
    quads: Array<[number, number, number, number]>
  } | null
  downloads: Array<{ url: string; filename: string }>
  opens: string[]
}

async function state(page: Page): Promise<HarnessState> {
  return page.evaluate(() => {
    const bridge = (window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness
    if (!bridge) throw new Error('pdf-reader harness bridge unavailable')
    return bridge.state
  })
}

const bin = resolveGardendBin()
assert(existsSync(bin), `gardend binary is required: ${bin} (set GARDEN_BIN)`)
const cell = await spawnGardend({ bin, readyTimeoutMs: 30_000 })
const mcp = new LoopbackMcpClient({
  mcpUrl: cell.mcpUrl,
  healthUrl: `${cell.apiUrl}/health`,
  token: cell.token,
  origin: 'http://127.0.0.1',
})

const server = await createServer({
  root: appDir,
  configFile: resolve(appDir, 'vite.config.ts'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  logLevel: 'warn',
})

let browser: Awaited<ReturnType<typeof webkit.launch>> | null = null
try {
  await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'PDF Reader Harness' })
  await mcp.callTool('create_document', {
    graphId: GRAPH_ID,
    documentId: 'pdf-reader-harness-ingested',
    title: 'Harness ingested document',
  })
  const headers = { Authorization: `Bearer ${cell.token}`, 'X-User-ID': 'pdf-reader-harness' }
  const bytes = minimalPdf('Harness Oracle')
  const revision = await fetch(
    `${cell.apiUrl}/artifacts/${GRAPH_ID}/${ARTIFACT_ID}/revisions`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataBase64: base64(bytes),
        mimeType: 'application/pdf',
        filename: PDF_FILENAME,
        label: 'Harness Oracle',
      }),
    },
  )
  assert(revision.ok, `artifact revision upload failed: HTTP ${revision.status}`)
  const navigation = await fetch(
    `${cell.apiUrl}/navigation/${GRAPH_ID}/artifacts/${ARTIFACT_ID}`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Harness Oracle',
        originalFilename: PDF_FILENAME,
        mimeType: 'application/pdf',
        status: 'ready',
        storageKey: `local://artifacts/${ARTIFACT_ID}/original/${PDF_FILENAME}`,
      }),
    },
  )
  assert(navigation.ok, `artifact registration failed: HTTP ${navigation.status}`)

  await server.listen()
  browser = await (engineName === 'chromium' ? chromium : webkit).launch({ headless: !headed })
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', value => pageErrors.push(value.stack ?? value.message))
  page.on('console', value => {
    if (value.type() === 'error') consoleErrors.push(value.text())
  })

  const query = new URLSearchParams({
    apiUrl: cell.apiUrl,
    mcpUrl: cell.mcpUrl,
    token: cell.token,
    graphId: GRAPH_ID,
    artifactId: ARTIFACT_ID,
    title: 'Harness Oracle',
  })
  await page.goto(`http://127.0.0.1:${port}/pdf-reader-browser-harness.html?${query}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const current = (window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state
    return current?.ready === true || Boolean(current?.error)
  })
  const boot = await state(page)
  assert(boot.error == null, `fixture boot failed: ${String(boot.error)}`)

  // Real load: bytes from the artifact route, pdf.js enumeration.
  await page.waitForFunction(
    () => (window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state.status === 'ready',
    undefined,
    { timeout: 30_000 },
  )
  let current = await state(page)
  // The artifact route may omit content-disposition; the controller's honest
  // fallback is `${artifactId}.pdf`.
  assert(current.filename === PDF_FILENAME || current.filename === `${ARTIFACT_ID}.pdf`, `filename was ${current.filename}`)
  assert(current.pageCount === 1, `page count was ${current.pageCount}`)
  assert(current.firstPageWidth === 612 && current.firstPageHeight === 792, `page dims were ${current.firstPageWidth}x${current.firstPageHeight}`)
  assert(current.textItemCount === 1, `text item count was ${current.textItemCount}`)
  assert(current.canAnnotate === true, 'shared annotations were not enabled')
  assert(current.annotationError === '', `annotation import warning/error: ${current.annotationError}; ${JSON.stringify(current.annotations)}; text=${JSON.stringify(current.textItems)}`)
  assert(current.annotations.length === 2, `embedded annotation count was ${current.annotations.length}`)
  assert(current.annotations.some(annotation => annotation.quote === 'Harness Oracle' && annotation.note === 'Embedded highlight note'),
    `embedded highlight was ${JSON.stringify(current.annotations)}`)
  assert(current.annotations.some(annotation => annotation.quote === '' && annotation.note === 'Embedded sticky note'),
    `embedded sticky note was ${JSON.stringify(current.annotations)}`)

  // Real IntersectionObserver → lazy rasterization to a canvas data URL.
  await page.waitForFunction(
    () => ((window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state.pageImages ?? 0) >= 1,
    undefined,
    { timeout: 30_000 },
  )
  const imageSrc = await page.locator('mn-artifact-view >> mn-pdf-reader >> .pdf-image').getAttribute('src')
  assert(imageSrc?.startsWith('data:image/png'), `page image was ${imageSrc ?? '(none)'}`)

  await page.locator('mn-artifact-view >> button[aria-label="Show PDF annotations"]').click()
  await page.waitForFunction(
    () => (window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state.mode === 'annotations',
  )
  const annotationView = page.locator('mn-pdf-annotation-view')
  await annotationView.waitFor()
  const annotationViewText = await annotationView.evaluate(node => node.shadowRoot?.textContent ?? '')
  assert(annotationViewText?.includes('Embedded highlight note'), `annotation view was ${annotationViewText}`)
  assert(annotationViewText?.includes('Embedded sticky note'), `annotation view was ${annotationViewText}`)
  assert(annotationViewText?.includes('Imported'), `annotation view was ${annotationViewText}`)
  assert(await page.locator('.pdf-light-selection-root').count() === 0, 'light selection layer survived Annotations mode')
  const firstAnnotation = current.annotations[0]
  assert(firstAnnotation, 'annotation view test has no annotation')
  await page.locator('mn-pdf-annotation-view >> .annotation-open').first().click()
  await page.waitForFunction(
    expected => {
      const currentState = (window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state
      return currentState?.mode === 'original' && currentState.activeAnnotationId === expected
    },
    firstAnnotation.id,
  )

  // A REAL text selection over the transparent text layer → page-space quads.
  // Capture what WebKit actually preserves before choosing its fallback.
  const selectionDiagnostics = await page.evaluate(() => {
    const reader = document.querySelector('mn-artifact-view')?.shadowRoot?.querySelector('mn-pdf-reader')
    if (!reader) throw new Error('reader unavailable')
    const shadowSelection = (reader.shadowRoot as unknown as { getSelection?: () => Selection | null }).getSelection?.()
    const span = shadowSelection
      ? reader.shadowRoot?.querySelector('.pdf-text-layer span')
      : document.querySelector('.pdf-light-selection-root .pdf-text-layer span')
    const text = span ? Array.from(span.childNodes).find(node => node.nodeType === 3) : undefined
    if (!text) throw new Error('text layer unavailable')
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 7) // "Harness"
    const selection = shadowSelection ?? window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const currentRange = selection?.rangeCount ? selection.getRangeAt(0) : null
    const rangeRects = []
    if (currentRange) {
      for (const rect of Array.from(currentRange.getClientRects())) {
        rangeRects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      }
    }
    const diagnostics = {
      hasShadowSelection: Boolean(shadowSelection),
      text: selection?.toString() ?? null,
      anchor: {
        nodeName: selection?.anchorNode?.nodeName ?? null,
        nodeType: selection?.anchorNode?.nodeType ?? null,
        text: selection?.anchorNode?.textContent?.slice(0, 80) ?? null,
        offset: selection?.anchorOffset ?? -1,
      },
      focus: {
        nodeName: selection?.focusNode?.nodeName ?? null,
        nodeType: selection?.focusNode?.nodeType ?? null,
        text: selection?.focusNode?.textContent?.slice(0, 80) ?? null,
        offset: selection?.focusOffset ?? -1,
      },
      rangeStart: {
        nodeName: currentRange?.startContainer.nodeName ?? null,
        nodeType: currentRange?.startContainer.nodeType ?? null,
        text: currentRange?.startContainer.textContent?.slice(0, 80) ?? null,
        offset: currentRange?.startOffset ?? -1,
      },
      rangeEnd: {
        nodeName: currentRange?.endContainer.nodeName ?? null,
        nodeType: currentRange?.endContainer.nodeType ?? null,
        text: currentRange?.endContainer.textContent?.slice(0, 80) ?? null,
        offset: currentRange?.endOffset ?? -1,
      },
      rangeText: currentRange?.toString() ?? null,
      rangeRects,
    }
    if (shadowSelection) {
      reader.shadowRoot!.querySelector('.pdf-scroll')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    } else {
      span!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    }
    return diagnostics
  })
  current = await state(page)
  assert(current.selection?.exact === 'Harness', `selection exact was ${JSON.stringify(current.selection?.exact)}`)
  assert(current.selection.pageNumber === 1, `selection page was ${current.selection.pageNumber}`)
  assert(current.selection.suffix === ' Oracle', `selection suffix was ${JSON.stringify(current.selection.suffix)}`)
  const quad = current.selection.quads[0]
  assert(quad, 'selection produced no quads in a real layout engine')
  const [qx, qy, qw, qh] = quad
  // pdf.js places the 18pt run at x=72, top-left y = 792-720-18 = 54 (scale 1).
  assert(Math.abs(qx - 72) < 6, `quad x was ${qx}`)
  assert(Math.abs(qy - 54) < 8, `quad y was ${qy}`)
  assert(qw > 30 && qw < 200, `quad width was ${qw}`)
  assert(qh > 8 && qh < 40, `quad height was ${qh}`)

  const textBox = engineName === 'chromium'
    ? await page.locator('mn-pdf-reader >> .pdf-text-layer span').first().boundingBox()
    : await page.locator('.pdf-light-selection-root .pdf-text-layer span').first().boundingBox()
  assert(textBox, 'selection text box missing')
  const beforeWheel = await page.locator('mn-pdf-reader >> .pdf-scroll').evaluate(node => (node as HTMLElement).scrollTop)
  await page.mouse.move(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2)
  await page.mouse.wheel(0, 600)
  await page.waitForFunction(
    previous => ((document.querySelector('mn-artifact-view')?.shadowRoot?.querySelector('mn-pdf-reader')?.shadowRoot?.querySelector('.pdf-scroll') as HTMLElement | null)?.scrollTop ?? 0) > previous,
    beforeWheel,
  )
  if (engineName === 'webkit') {
    await page.evaluate(() => {
      const view = document.querySelector('mn-artifact-view') as HTMLElement
      view.style.width = '70%'
    })
    await page.waitForFunction(() => {
      const scroller = document.querySelector('mn-artifact-view')?.shadowRoot?.querySelector('mn-pdf-reader')?.shadowRoot?.querySelector('.pdf-scroll') as HTMLElement | null
      const light = document.querySelector('.pdf-light-selection-root') as HTMLElement | null
      if (!scroller || !light) return false
      const scrollerBox = scroller.getBoundingClientRect()
      const lightBox = light.getBoundingClientRect()
      return Math.abs(scrollerBox.left - lightBox.left) < 1 && Math.abs(scrollerBox.width - lightBox.width) < 1
    })
  }

  await page.locator('mn-pdf-reader >> button[aria-label="Highlight selection"]').click()
  await page.waitForFunction(
    () => (window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state.annotations.length === 3,
  )
  await page.locator('mn-pdf-reader >> button[aria-label="Add note to selection"]').click()
  await page.waitForFunction(
    () => (window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state.annotations.length === 4,
  )
  current = await state(page)
  assert(current.annotations.some(annotation => annotation.quote === 'Harness' && annotation.note === 'Harness note'),
    `user note was ${JSON.stringify(current.annotations)}`)

  const companionDocument = await mcp.callTool('read_document', {
    graphId: GRAPH_ID,
    documentId: `pdf-ann-${ARTIFACT_ID}`,
    format: 'json',
  }) as { content: string }
  const companionJson = JSON.parse(companionDocument.content) as {
    tiptapJson: { content: Array<{ attrs?: Record<string, string> }> }
  }
  const userBlock = companionJson.tiptapJson.content.find(node => {
    const raw = node.attrs?.['data-pdf-selector']
    if (!raw) return false
    const selector = JSON.parse(raw) as { source?: string; kind?: string; exact?: string }
    return selector.source === 'reader' && selector.kind === 'highlight' && selector.exact === 'Harness'
  })
  const userBlockId = userBlock?.attrs?.['data-block-id']
  assert(userBlockId, 'user highlight block missing from companion')
  await mcp.callTool('edit_comment', {
    graphId: GRAPH_ID,
    documentId: `pdf-ann-${ARTIFACT_ID}`,
    commentId: 'pdf-agent-witness',
    action: 'set',
    text: 'Agent witness',
    author: 'Agent',
    blockId: userBlockId,
    find: 'Harness',
    quotedText: 'Harness',
    occurrence: 1,
  })
  const provenance = await mcp.callTool('get_wires', {
    graphId: GRAPH_ID,
    documentId: `pdf-ann-${ARTIFACT_ID}`,
    direction: 'outgoing',
  })
  const provenanceText = JSON.stringify(provenance)
  assert(provenanceText.includes('annotates'), `annotates wires were ${provenanceText}`)
  assert(provenanceText.includes(ARTIFACT_ID), `artifact wire was ${provenanceText}`)
  assert(provenanceText.includes('pdf-reader-harness-ingested'), `document wire was ${provenanceText}`)

  const readyCount = current.readyCount
  await page.locator('mn-pdf-reader >> button[aria-label="Reload PDF"]').click()
  await page.waitForFunction(
    previous => ((window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state.readyCount ?? 0) > previous,
    readyCount,
  )
  current = await state(page)
  assert(current.annotations.length === 4, `reload duplicated annotations: ${JSON.stringify(current.annotations)}`)
  assert(current.annotations.some(annotation => annotation.quote === 'Harness' && annotation.note === 'Agent witness'),
    `second writer note missing after reload: ${JSON.stringify(current.annotations)}`)
  assert(current.annotations.some(annotation => annotation.quote === 'Harness' && annotation.note === 'Harness note'),
    `user note missing after reload: ${JSON.stringify(current.annotations)}`)
  assert(current.annotationError === '', `reload import warning/error: ${current.annotationError}`)

  const firstAnnotationId = current.annotations[0]?.id
  const annotationBox = await page.locator('mn-pdf-reader >> .anno-rect').first().boundingBox()
  assert(firstAnnotationId && annotationBox, 'embedded annotation overlay missing')
  await page.mouse.click(annotationBox.x + annotationBox.width / 2, annotationBox.y + annotationBox.height / 2)
  await page.waitForFunction(
    expected => (window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state.activeAnnotationId === expected,
    firstAnnotationId,
  )

  // Toolbar intents: zoom rescales the real page box; download delegates.
  await page.locator('mn-pdf-reader >> button[aria-label="Zoom in"]').click()
  await page.waitForFunction(
    () => (window as unknown as { __pdfReaderHarness?: { state: HarnessState } }).__pdfReaderHarness?.state.zoom === 1.2,
  )
  const pageBoxWidth = await page.locator('mn-pdf-reader >> .pdf-page').evaluate(node => (node as HTMLElement).style.width)
  assert(pageBoxWidth === '734.4px', `page box width after zoom was ${pageBoxWidth}`)
  await page.locator('mn-pdf-reader >> button[aria-label="Download PDF"]').click()
  current = await state(page)
  assert(current.downloads.length === 1 && current.downloads[0]?.filename === current.filename, `downloads were ${JSON.stringify(current.downloads)}`)

  assert(pageErrors.length === 0, `page errors:\n${pageErrors.join('\n')}`)
  assert(consoleErrors.length === 0, `console errors:\n${consoleErrors.join('\n')}`)

  process.stdout.write(`${JSON.stringify({
    ok: true,
    browser: engineName,
    headed,
    realCellBytesAndEnumeration: true,
    intersectionObserverLazyRasterization: true,
    realSelectionQuads: quad ?? null,
    selectionDiagnostics,
    zoomAndDownloadIntents: true,
    pageErrors,
    consoleErrors,
  }, null, 2)}\n`)
} finally {
  await browser?.close().catch(() => undefined)
  await server.close().catch(() => undefined)
  await cell.kill().catch(() => undefined)
}
