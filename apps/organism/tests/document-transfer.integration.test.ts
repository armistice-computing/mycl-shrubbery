/**
 * Real-cell document transfer oracle.
 *
 * No mocked route is involved: a fresh gardend archives the original Markdown
 * bytes, writes the editable CRDT document, links both records, and serves the
 * result through Markdown and themed HTML export routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL as NodeUrl } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import type { ShrubberyContract } from '@shrubbery/nucleus'
import { GardendDocumentTransferService } from '../src/cell/document-transfer.js'
import { LoopbackMcpClient, mcpText } from '../src/cell/loopback-mcp.js'
import { resolveGardendBin, spawnGardend, type GardendCell } from '../src/cell/spawn-gardend.js'
import {
  loadSidebarSections,
  type SidebarDocumentRest,
} from '../src/cell/sidebar-documents.js'
import { OrganismOriginalFileController } from '../src/cell/original-file-controller.js'
import { OrganismPdfReaderController } from '../src/cell/pdf-reader-controller.js'
import { makeSidebarDocumentEditable } from '../src/cell/sidebar-mutations.js'
import type { SidebarNode, SidebarSection } from '@shrubbery/runtime'

const GRAPH_ID = 'organism-document-transfer-it'
const ISOLATION_GRAPH_ID = 'organism-document-transfer-isolation-it'
const GARDEND_BIN = resolveGardendBin()

function minimalPdf(text: string): Uint8Array {
  const escaped = text.replace(/([\\()])/g, '\\$1')
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
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

function minimalEpub(): Uint8Array {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
      <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
        <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
      </container>`),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB Transfer Oracle</dc:title></metadata>
        <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
        <spine><itemref idref="chapter"/></spine>
      </package>`),
    'OEBPS/chapter.xhtml': strToU8(`<!doctype html><html xmlns="http://www.w3.org/1999/xhtml">
      <head><title>Garden Chapter</title></head>
      <body><h1>Garden Chapter</h1><p>The EPUB reached the real gardend cell.</p></body>
    </html>`),
  })
}

function minimalDocx(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>DOCX Transfer Oracle</w:t></w:r></w:p>
          <w:p><w:r><w:t>The DOCX reached the real gardend cell.</w:t></w:r></w:p>
          <w:sectPr/>
        </w:body>
      </w:document>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`),
  })
}

function minimalIpynb(): string {
  return JSON.stringify({
    metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', source: 'Notebook markdown' },
      { cell_type: 'code', source: 'print("matrix")', outputs: [{ text: 'OUTPUT_SECRET' }] },
      { cell_type: 'raw', source: 'RAW_SECRET' },
      { cell_type: 'markdown', source: '## After code' },
    ],
  })
}

function binaryFilePart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function documentNode(sections: readonly SidebarSection[], documentId: string): SidebarNode | null {
  const find = (nodes: readonly SidebarNode[]): SidebarNode | null => {
    for (const node of nodes) {
      if (node.id === documentId) return node
      const nested = find(node.children ?? [])
      if (nested) return nested
    }
    return null
  }
  for (const section of sections) {
    const node = find(section.nodes ?? [])
    if (node) return node
  }
  return null
}

function escapeMultipartValue(value: string): string {
  return value.replace(/["\r\n]/g, character => character === '"' ? '%22' : '')
}

async function encodeMultipart(form: FormData): Promise<{ body: Uint8Array; contentType: string }> {
  const boundary = `----shrubbery-${crypto.randomUUID()}`
  const chunks: Uint8Array[] = []
  const encoder = new TextEncoder()
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      chunks.push(encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n${value}\r\n`,
      ))
      continue
    }
    chunks.push(encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartValue(name)}"; filename="${escapeMultipartValue(value.name)}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`,
    ))
    chunks.push(new Uint8Array(await value.arrayBuffer()))
    chunks.push(encoder.encode('\r\n'))
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`))
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

/** Node's happy-dom fetch strips Authorization on loopback requests. Drive the
 * exact same Fetch-shaped service over node:http so the real-cell oracle keeps
 * the bearer and still exercises service serialization/polling end-to-end. */
const nodeCellFetch: typeof fetch = async (input, init = {}) => {
  const url = new NodeUrl(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
  const headers = new Headers(init.headers)
  let body: Uint8Array | undefined
  if (init.body instanceof FormData) {
    const multipart = await encodeMultipart(init.body)
    body = multipart.body
    headers.set('content-type', multipart.contentType)
  } else if (typeof init.body === 'string') {
    body = new TextEncoder().encode(init.body)
  } else if (init.body instanceof URLSearchParams) {
    body = new TextEncoder().encode(init.body.toString())
  }
  if (body) headers.set('content-length', String(body.byteLength))

  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: init.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
    }, response => {
      const chunks: Uint8Array[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => responseHeaders.append(name, item))
          else if (value !== undefined) responseHeaders.set(name, value)
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }))
      })
    })
    request.on('error', reject)
    if (init.signal) {
      if (init.signal.aborted) request.destroy(new DOMException('Aborted', 'AbortError'))
      else init.signal.addEventListener('abort', () => request.destroy(new DOMException('Aborted', 'AbortError')), { once: true })
    }
    if (body) request.write(body)
    request.end()
  })
}

describe('document transfer — real gardend', () => {
  let cell: GardendCell
  let service: GardendDocumentTransferService
  let mcp: LoopbackMcpClient
  let contract: Pick<ShrubberyContract, 'auth' | 'runtime'>

  beforeAll(async () => {
    if (!existsSync(GARDEND_BIN)) {
      throw new Error(`gardend binary is required for document transfer integration: ${GARDEND_BIN}`)
    }
    cell = await spawnGardend({ bin: GARDEND_BIN })
    mcp = new LoopbackMcpClient({
      mcpUrl: cell.mcpUrl,
      healthUrl: `${cell.apiUrl}/health`,
      token: cell.token,
      origin: 'http://127.0.0.1',
    })
    await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'Document Transfer IT' })
    await mcp.toolsCall('create_graph', { graph_id: ISOLATION_GRAPH_ID, title: 'Document Transfer Isolation IT' })

    contract = {
      auth: {
        token: () => cell.token,
        userId: () => 'organism-document-transfer',
        isAuthenticated: () => true,
        whenReady: () => Promise.resolve(),
        onChange: () => () => {},
      },
      runtime: {
        mode: () => 'local',
        isGateway: () => false,
        graphBaseUrl: () => cell.apiUrl,
      },
    }
    service = new GardendDocumentTransferService(contract, {
      fetch: nodeCellFetch,
      pollIntervalMs: 25,
      jobTimeoutMs: 30_000,
    })
  }, 30_000)

  afterAll(async () => {
    if (cell) await cell.kill()
  })

  it('uploads, ingests, and exports one document byte-for-byte through the live cell contract', async () => {
    const file = new File([
      '# Transfer Oracle\n\nThe shrubbery document transfer reached the real cell.\n',
    ], 'transfer-oracle.md', { type: 'text/markdown' })

    const uploaded = await service.uploadFile(GRAPH_ID, file)

    expect(uploaded.documentId).toMatch(/^doc-/)
    expect(uploaded.title).toBe('transfer-oracle')
    expect(uploaded.readOnly).toBe(false)
    expect(uploaded.jobId).toBeNull()

    const markdown = await service.exportDocument(GRAPH_ID, uploaded.documentId, {
      format: 'markdown',
      title: uploaded.title,
    })
    expect(markdown.filename).toBe('transfer-oracle.md')
    expect(await markdown.blob.text()).toContain('# Transfer Oracle')
    expect(await markdown.blob.text()).toContain('reached the real cell')

    const html = await service.exportDocument(GRAPH_ID, uploaded.documentId, {
      format: 'html',
      theme: 'dusk',
      title: uploaded.title,
    })
    const htmlText = await html.blob.text()
    expect(html.filename).toBe('transfer-oracle.html')
    expect(htmlText).toContain('Transfer Oracle')
    expect(htmlText).toContain('theme-dusk')
  }, 40_000)

  it('clips deterministic HTML through the real authenticated extractor and materializes the document', async () => {
    const clipped = await service.importWebClip(
      GRAPH_ID,
      'https://example.test/garden-browser-contract',
      {
        title: 'Clipped Garden Contract',
        html: `<!doctype html>
          <html>
            <head><title>Ignored browser title</title></head>
            <body>
              <nav>Navigation noise</nav>
              <article>
                <h1>Clipped Garden Contract</h1>
                <p>The real gardend web clip path extracted this paragraph.</p>
                <p>A second paragraph gives the article enough body to clear the clip route's floor for empty pages, so the test exercises a real article rather than a stub.</p>
                <p><a href="/deep-roots">Relative links become absolute</a>.</p>
              </article>
              <footer>Footer noise</footer>
            </body>
          </html>`,
      },
    )

    expect(clipped.status).toBe('complete')
    expect(clipped.documentId).toMatch(/^doc-/)
    const markdown = await service.exportDocument(GRAPH_ID, clipped.documentId, {
      format: 'markdown',
      title: 'Clipped Garden Contract',
    })
    const body = await markdown.blob.text()
    expect(body).toContain('# Clipped Garden Contract')
    expect(body).toContain('Source: https://example.test/garden-browser-contract')
    expect(body).toContain('The real gardend web clip path extracted this paragraph.')
    expect(body).toContain('[Relative links become absolute](https://example.test/deep-roots).')
    expect(body).not.toContain('Navigation noise')
    expect(body).not.toContain('Footer noise')

    const workspace = await mcp.toolsCall('get_workspace', { graph_id: GRAPH_ID }) as {
      structuredContent?: { documents?: Array<Record<string, unknown>> }
    }
    const document = workspace.structuredContent?.documents?.find(item => item.id === clipped.documentId)
    expect(document).toMatchObject({ id: clipped.documentId, title: 'Clipped Garden Contract' })
  }, 40_000)

  it('browser-parses PDF, EPUB, and DOCX while the real cell archives originals and persists conforming source links', async () => {
    const fixtures = [
      {
        file: new File([binaryFilePart(minimalPdf('The PDF reached the real gardend cell.'))], 'transfer-oracle.pdf', { type: 'application/pdf' }),
        expected: 'The PDF reached the real gardend cell.',
        title: 'transfer-oracle',
      },
      {
        file: new File([binaryFilePart(minimalEpub())], 'transfer-oracle.epub', { type: 'application/epub+zip' }),
        expected: 'The EPUB reached the real gardend cell.',
        title: 'EPUB Transfer Oracle',
      },
      {
        file: new File([binaryFilePart(minimalDocx())], 'transfer-oracle.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
        expected: 'The DOCX reached the real gardend cell.',
        title: 'DOCX Transfer Oracle',
      },
    ]

    const uploadedIds: string[] = []
    const uploadedFiles = new Map<string, File>()
    for (const fixture of fixtures) {
      const uploaded = await service.uploadFile(GRAPH_ID, fixture.file)
      uploadedIds.push(uploaded.documentId)
      uploadedFiles.set(uploaded.documentId, fixture.file)
      expect(uploaded.title).toBe(fixture.title)
      expect(uploaded.readOnly).toBe(true)
      expect(uploaded.jobId).toBeNull()
      expect(uploaded.sourceFile).not.toHaveProperty('sizeBytes')

      const markdown = await service.exportDocument(GRAPH_ID, uploaded.documentId, {
        format: 'markdown',
        title: uploaded.title,
      })
      expect(await markdown.blob.text()).toContain(fixture.expected)

      const artifactId = String(uploaded.sourceFile?.artifactId)
      const original = await nodeCellFetch(
        `${cell.apiUrl}/artifacts/${encodeURIComponent(GRAPH_ID)}/${encodeURIComponent(artifactId)}/download`,
        { headers: { Authorization: `Bearer ${cell.token}` } },
      )
      expect(original.ok).toBe(true)
      expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(await fixture.file.arrayBuffer()))
    }

    const workspace = await mcp.toolsCall('get_workspace', { graph_id: GRAPH_ID }) as {
      structuredContent?: { documents?: Array<Record<string, unknown>> }
    }
    const documents = workspace.structuredContent?.documents ?? []
    for (const documentId of uploadedIds) {
      const document = documents.find(item => item.id === documentId)
      expect(document).toBeDefined()
      expect(Number(document?.blockCount ?? document?.block_count)).toBeGreaterThan(0)
      // `sourceFile` is deliberately NOT asserted here any more. gardend's
      // `get_workspace` returns a bounded projection (compact_workspace_entry,
      // garden 491df20 "bound graph result surfaces"), and source-file
      // metadata is one of the fields that bounding drops. Nothing in the app
      // reads it from this surface — the sidebar loads it over SPARQL — so
      // this was pinning a contract no consumer has.
      //
      // The invariants it protected are still covered, on the surfaces that
      // actually carry them: the sidebar projection below asserts the same
      // source file reaches the tree, the OriginalFileController block after
      // it proves the storage key resolves to real bytes (stronger than the
      // `local://artifacts/` string match this made), and the per-upload
      // assertion above still pins that sizeBytes never leaks.
    }

    const projectionRest: SidebarDocumentRest = {
      async query(graphId, sparql) {
        const result = await mcp.toolsCall('sparql_query', { graphId, query: sparql })
        return JSON.parse(mcpText(result)) as Record<string, unknown>
      },
    }
    const projected = await loadSidebarSections(projectionRest, GRAPH_ID, uploadedIds[0]!)
    const importedNode = documentNode(projected, uploadedIds[0]!)
    expect(importedNode).toMatchObject({
      id: uploadedIds[0],
      readOnly: true,
      icon: 'book-open',
      sourceFile: {
        originalFilename: 'transfer-oracle.pdf',
        mimeType: 'application/pdf',
        fileType: 'pdf',
      },
    })

    const contract: Pick<ShrubberyContract, 'auth' | 'runtime'> = {
      auth: {
        token: () => cell.token,
        userId: () => 'organism-document-transfer',
        isAuthenticated: () => true,
        whenReady: () => Promise.resolve(),
        onChange: () => () => {},
      },
      runtime: {
        mode: () => 'local',
        isGateway: () => false,
        graphBaseUrl: () => cell.apiUrl,
      },
    }
    const objectUrls: string[] = []
    const revoked: string[] = []
    const downloads: Array<{ url: string; filename: string }> = []
    const reader = new OrganismOriginalFileController({
      requestRender: () => undefined,
      fetch: nodeCellFetch,
      url: {
        createObjectURL: () => {
          const value = `blob:real-gardend-original-${objectUrls.length + 1}`
          objectUrls.push(value)
          return value
        },
        revokeObjectURL: value => revoked.push(value),
      },
      download: (url, filename) => downloads.push({ url, filename }),
    })
    reader.setScope(contract, GRAPH_ID, uploadedIds[0]!, importedNode!.sourceFile)
    // Phase 2 original-first: a PDF source ACTIVATES the original surface by
    // default, and this controller no longer fetches bytes or sets the legacy
    // blob-iframe src for PDFs — that moved to the PDF reader controller.
    expect(reader.snapshot()).toMatchObject({
      available: true,
      active: true,
      status: 'idle',
      src: '',
      filename: 'transfer-oracle.pdf',
      mimeType: 'application/pdf',
    })
    // The explicit per-session toggle back to extracted text is honored.
    await reader.toggle()
    expect(reader.snapshot()).toMatchObject({ active: false, status: 'idle' })

    // The shell's PDF reader controller owns the PDF bytes against the real
    // cell: document-original route with the artifact fallback, real pdf.js
    // page enumeration, controlled snapshot, download delegation, cleanup.
    const pdfReader = new OrganismPdfReaderController({
      requestRender: () => undefined,
      fetch: nodeCellFetch,
      url: {
        createObjectURL: () => {
          const value = `blob:real-gardend-original-${objectUrls.length + 1}`
          objectUrls.push(value)
          return value
        },
        revokeObjectURL: value => revoked.push(value),
      },
      download: (url, filename) => downloads.push({ url, filename }),
    })
    pdfReader.setScope(contract, {
      kind: 'document',
      graphId: GRAPH_ID,
      documentId: uploadedIds[0]!,
      sourceFile: importedNode!.sourceFile!,
    })
    const pdfDeadline = Date.now() + 60_000
    while (pdfReader.snapshot().status !== 'ready') {
      const status = pdfReader.snapshot()
      if (status.status === 'error') throw new Error(`pdf reader failed: ${status.error}`)
      if (Date.now() > pdfDeadline) throw new Error('pdf reader timed out')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const pdfSnapshot = pdfReader.snapshot()
    expect(pdfSnapshot.filename).toBe('transfer-oracle.pdf')
    expect(pdfSnapshot.pages.length).toBeGreaterThan(0)
    expect(pdfSnapshot.pages[0]).toMatchObject({ pageNumber: 1 })
    expect(pdfSnapshot.pages[0]!.width).toBeGreaterThan(0)
    expect(pdfSnapshot.pages[0]!.textItems.length).toBeGreaterThan(0)
    expect(pdfSnapshot.canAnnotate).toBe(false)
    expect(pdfSnapshot.downloadable).toBe(true)
    pdfReader.download()
    expect(downloads).toEqual([{
      url: 'blob:real-gardend-original-1',
      filename: 'transfer-oracle.pdf',
    }])
    pdfReader.destroy()
    expect(revoked).toContain('blob:real-gardend-original-1')

    await makeSidebarDocumentEditable(mcp, {
      graphId: GRAPH_ID,
      documentId: uploadedIds[0]!,
    })
    await mcp.toolsCall('flush_crdt', { graphId: GRAPH_ID })

    // A fresh client + fresh projection reads model a browser reload: the flag
    // must come back from gardend authority, not an in-memory UI override.
    const reloadMcp = new LoopbackMcpClient({
      mcpUrl: cell.mcpUrl,
      healthUrl: `${cell.apiUrl}/health`,
      token: cell.token,
      origin: 'http://127.0.0.1',
    })
    const reloadedWorkspace = await reloadMcp.toolsCall('get_workspace', { graph_id: GRAPH_ID }) as {
      structuredContent?: { documents?: Array<Record<string, unknown>> }
    }
    // The catalog must still know the document after the edit; `readOnly`
    // itself is asserted on the projection below, because the bounded
    // `get_workspace` entry no longer carries it (see the note above).
    expect(reloadedWorkspace.structuredContent?.documents?.find(item => item.id === uploadedIds[0])).toMatchObject({
      id: uploadedIds[0],
    })
    const reloadedProjection = await loadSidebarSections({
      async query(graphId, sparql) {
        return JSON.parse(mcpText(await reloadMcp.toolsCall('sparql_query', { graphId, query: sparql }))) as Record<string, unknown>
      },
    }, GRAPH_ID, uploadedIds[0]!)
    expect(documentNode(reloadedProjection, uploadedIds[0]!)).toMatchObject({
      readOnly: false,
      icon: 'file-text',
      sourceFile: {
        originalFilename: 'transfer-oracle.pdf',
      },
    })

    // Reuse the exact document id in another graph. Neither readOnly nor source
    // metadata may bleed across the graph boundary.
    await mcp.toolsCall('create_document', {
      graphId: ISOLATION_GRAPH_ID,
      documentId: uploadedIds[0],
      title: 'Same ID, isolated graph',
    })
    await mcp.toolsCall('flush_crdt', { graphId: ISOLATION_GRAPH_ID })
    const isolatedProjection = await loadSidebarSections(projectionRest, ISOLATION_GRAPH_ID, uploadedIds[0]!)
    expect(documentNode(isolatedProjection, uploadedIds[0]!)).toMatchObject({
      readOnly: false,
      sourceFile: null,
    })
    reader.setScope(contract, ISOLATION_GRAPH_ID, uploadedIds[0]!, null)
    expect(reader.snapshot()).toMatchObject({ available: false, active: false })
    expect(revoked).toEqual(['blob:real-gardend-original-1'])
    reader.destroy()

    // Keep the deterministic fixture bytes referenced so the test fails if the
    // selected source document ever stops being the PDF fixture.
    expect(uploadedFiles.get(uploadedIds[0]!)?.type).toBe('application/pdf')
  }, 60_000)

  it('imports every accepted file type with content, order, source identity, and original bytes intact', async () => {
    const binaryFixtures = [
      { file: new File([binaryFilePart(minimalPdf('Matrix PDF'))], 'matrix.pdf', { type: 'application/pdf' }), expected: 'Matrix PDF', fileType: 'pdf', readOnly: true },
      { file: new File([binaryFilePart(minimalEpub())], 'matrix.epub', { type: 'application/epub+zip' }), expected: 'The EPUB reached the real gardend cell.', fileType: 'epub', readOnly: true },
      { file: new File([binaryFilePart(minimalDocx())], 'matrix.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }), expected: 'The DOCX reached the real gardend cell.', fileType: 'docx', readOnly: true },
      { file: new File([minimalIpynb()], 'matrix.ipynb', { type: 'application/x-ipynb+json' }),
        expected: 'Notebook markdown', fileType: 'ipynb', readOnly: true,
        order: ['Notebook markdown', 'print("matrix")', '## After code'] },
    ]
    const textExtensions = [
      'md', 'markdown', 'txt', 'html', 'htm', 'xml', 'log', 'csv', 'json', 'yaml', 'yml',
      'ini', 'cfg', 'conf', 'py', 'js', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'sh',
      'sql', 'graphql', 'gql', 'toml',
    ]
    const fixtures = [
      ...binaryFixtures,
      ...textExtensions.map(extension => ({
        file: new File([extension === 'xml' ? '<paragraph>matrix xml</paragraph>' : `matrix ${extension}`], `matrix.${extension}`),
        expected: `matrix ${extension}`,
        fileType: extension,
        readOnly: false,
      })),
    ]

    for (const fixture of fixtures) {
      const uploaded = await service.uploadFile(GRAPH_ID, fixture.file)
      expect(uploaded.outcome).toBe('document')
      expect(uploaded.documentId).not.toBe('')
      expect(uploaded.fileType).toBe(fixture.fileType)
      expect(uploaded.readOnly).toBe(fixture.readOnly)
      expect(uploaded.jobId).toBeNull()

      const markdown = await service.exportDocument(GRAPH_ID, uploaded.documentId, {
        format: 'markdown',
        title: uploaded.title,
      })
      expect(await markdown.blob.text()).toContain(fixture.expected)
      const order = 'order' in fixture ? fixture.order as readonly string[] | undefined : undefined
      if (order) {
        let previous = -1
        for (const part of order) {
          const index = (await markdown.blob.text()).indexOf(part)
          expect(index).toBeGreaterThan(previous)
          previous = index
        }
      }

      const artifactId = String(uploaded.sourceFile?.artifactId)
      expect(artifactId).not.toBe('')
      const original = await nodeCellFetch(
        `${cell.apiUrl}/artifacts/${encodeURIComponent(GRAPH_ID)}/${encodeURIComponent(artifactId)}/download`,
        { headers: { Authorization: `Bearer ${cell.token}` } },
      )
      expect(original.ok).toBe(true)
      expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(await fixture.file.arrayBuffer()))
    }
  }, 120_000)

  it('keeps an over-threshold PDF on the document and original-reader path', async () => {
    const readerService = new GardendDocumentTransferService(contract, {
      fetch: nodeCellFetch,
      attachThresholdBytes: 1,
    })
    const file = new File([binaryFilePart(minimalPdf('Large reader PDF'))], 'large.pdf', { type: 'application/pdf' })

    const uploaded = await readerService.uploadFile(GRAPH_ID, file)

    expect(uploaded.outcome).toBe('document')
    expect(uploaded.documentId).not.toBe('')
    expect(uploaded.fileType).toBe('pdf')
    const markdown = await readerService.exportDocument(GRAPH_ID, uploaded.documentId, {
      format: 'markdown',
      title: uploaded.title,
    })
    expect(await markdown.blob.text()).toContain('Large reader PDF')
    const artifactId = String(uploaded.sourceFile?.artifactId)
    expect(artifactId).not.toBe('')
    const original = await nodeCellFetch(
      `${cell.apiUrl}/artifacts/${encodeURIComponent(GRAPH_ID)}/${encodeURIComponent(artifactId)}/download`,
      { headers: { Authorization: `Bearer ${cell.token}` } },
    )
    expect(original.ok).toBe(true)
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()))
  }, 60_000)

  it('attaches large and unknown files through the real cell without creating documents or jobs', async () => {
    const before = await mcp.toolsCall('get_workspace', { graph_id: GRAPH_ID }) as {
      structuredContent?: { documents?: unknown[] }
    }
    const beforeCount = before.structuredContent?.documents?.length ?? 0
    const attachService = new GardendDocumentTransferService(contract, {
      fetch: nodeCellFetch,
      attachThresholdBytes: 1,
    })
    const files = [
      new File(['large'], 'large.md', { type: 'text/markdown' }),
      new File(['data'], 'payload.bin', { type: 'application/octet-stream' }),
    ]

    for (const file of files) {
      const uploaded = await attachService.uploadFile(GRAPH_ID, file)
      expect(uploaded.outcome).toBe('attachment')
      expect(uploaded.documentId).toBe('')
      expect(uploaded.jobId).toBeNull()
      expect(uploaded.readOnly).toBe(true)
      expect(uploaded.sourceFile).toMatchObject({ mode: 'attached', sizeBytes: file.size })
      expect(String(uploaded.sourceFile?.sha256)).toHaveLength(64)

      const artifactId = String(uploaded.sourceFile?.artifactId)
      expect(artifactId).not.toBe('')
      const original = await nodeCellFetch(
        `${cell.apiUrl}/artifacts/${encodeURIComponent(GRAPH_ID)}/${encodeURIComponent(artifactId)}/download`,
        { headers: { Authorization: `Bearer ${cell.token}` } },
      )
      expect(original.ok).toBe(true)
      expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()))

      const after = await mcp.toolsCall('get_workspace', { graph_id: GRAPH_ID }) as {
        structuredContent?: { documents?: unknown[] }
      }
      expect(after.structuredContent?.documents?.length ?? 0).toBe(beforeCount)
    }
  }, 60_000)
})
