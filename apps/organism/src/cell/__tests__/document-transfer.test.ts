import { afterEach, describe, expect, it, vi } from 'vitest'
import '@shrubbery/components'
import type { MnExportDialog } from '@shrubbery/components'
import type { ShrubberyContract } from '@shrubbery/nucleus'
import {
  attachDocumentExportDialog,
  contentDispositionFilename,
  DEFAULT_TRANSFER_JOB_TIMEOUT_MS,
  DOCUMENT_IMPORT_ACCEPT,
  DocumentTransferCancelledError,
  parseIpynbInBrowser,
  gardendResponseError,
  GardendDocumentTransferService,
  isYouTubeClipUrl,
  pickDocumentFiles,
  safeDownloadFilename,
  saveBlob,
  shouldSkipDocumentImportFile,
  type ExportedDocument,
} from '../document-transfer.js'

function contract(base = '/cell'): Pick<ShrubberyContract, 'auth' | 'runtime'> {
  return {
    auth: {
      token: () => 'secret-token',
      userId: () => 'user-a',
      isAuthenticated: () => true,
      whenReady: () => Promise.resolve(),
      onChange: () => () => {},
    },
    runtime: {
      mode: () => 'local',
      isGateway: () => false,
      graphBaseUrl: () => base,
    },
  }
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function exported(format: 'markdown' | 'html', body: string, filename: string): ExportedDocument {
  return {
    blob: new Blob([body], { type: format === 'html' ? 'text/html' : 'text/markdown' }),
    filename,
    format,
    contentType: format === 'html' ? 'text/html' : 'text/markdown',
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('GardendDocumentTransferService', () => {
  it('archives bytes through conforming artifact routes, imports in the selected graph, polls the job, and preserves metadata', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let statusReads = 0
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes('/artifacts/graph%20a/') && url.endsWith('/revisions')) {
        return jsonResponse({ revisionId: 'rev-1' }, 201)
      }
      if (url.includes('/navigation/graph%20a/artifacts/') && init?.method === 'PUT') {
        return jsonResponse({ artifactId: 'artifact-staged' })
      }
      if (url.endsWith('/api/crdt/operations')) {
        return jsonResponse({ documentId: 'doc-1', title: 'Imported Plan' })
      }
      if (url.includes('/navigation/graph%20a/artifacts/')) {
        return jsonResponse({ label: 'plan', originalFilename: 'plan.md', mimeType: 'text/markdown', status: 'ready' })
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), {
      fetch,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    const file = new File(['# Plan'], 'plan.md', { type: 'text/markdown' })
    const progress: string[] = []

    const result = await service.uploadFile('graph a', file, {
      parentId: 'folder-1',
      onProgress: (_file, state) => progress.push(`${state.status}:${state.percent ?? '-'}`),
    })

    expect(result).toMatchObject({
      documentId: 'doc-1',
      title: 'Imported Plan',
      fileType: 'md',
      readOnly: false,
      sourceFile: expect.objectContaining({ originalFilename: 'plan.md' }),
      jobId: null,
    })
    expect(progress).toEqual(['running:75', 'succeeded:100'])
    expect(calls[0].url).toMatch(/^\/cell\/artifacts\/graph%20a\/document-import-.+\/revisions$/)
    expect(calls[0].init?.method).toBe('POST')
    const headers = calls[0].init?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer secret-token')
    expect(headers.get('X-User-ID')).toBe('user-a')
    const revision = JSON.parse(String(calls[0].init?.body))
    expect(atob(revision.dataBase64)).toBe('# Plan')
    expect(revision).toMatchObject({ filename: 'plan.md', mimeType: 'text/markdown', label: 'plan' })
    const navigation = JSON.parse(String(calls[1].init?.body))
    expect(navigation).not.toHaveProperty('sizeBytes')
    expect(navigation).toMatchObject({ originalFilename: 'plan.md', status: 'ready' })
    const writeCall = calls.find(call => call.url.endsWith('/api/crdt/operations'))!
    expect(JSON.parse(String(writeCall.init?.body))).toMatchObject({
      graphId: 'graph a',
      kind: 'document.write',
      payload: { parentId: 'folder-1', content: '# Plan', format: 'markdown', readOnly: false },
    })
    expect(statusReads).toBe(0)
  })

  it('makes a parsed import editable when the person asks (Eschaton, T1)', async () => {
    const bodies: unknown[] = []
    const binaryParser = vi.fn(async () => ({ fileType: 'pdf' as const, title: 'Paper', markdown: '# Paper\n', warnings: [] }))
    let crdtWrites = 0
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/revisions')) return jsonResponse({ revisionId: 'rev-pdf' }, 201)
      if (url.includes('/navigation/g/artifacts/') && init?.method === 'PUT') return jsonResponse({ artifactId: 'artifact-pdf' })
      if (url.endsWith('/api/crdt/operations')) {
        bodies.push(JSON.parse(String(init?.body)))
        crdtWrites += 1
        return jsonResponse(crdtWrites === 1 ? { documentId: 'doc-pdf', title: 'Paper' } : { documentId: 'doc-pdf' })
      }
      if (url.includes('/navigation/g/artifacts/')) return jsonResponse({ label: 'Paper', originalFilename: 'paper.pdf', status: 'ready' })
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch, binaryParser })
    const file = new File(['pdf bytes'], 'paper.pdf', { type: 'application/pdf' })

    const result = await service.uploadFile('g', file, { editable: true })

    expect(result.readOnly).toBe(false)
    expect(bodies[0]).toMatchObject({ kind: 'document.write', payload: { readOnly: false } })
  })

  it('parses binary documents in the browser and persists a source link without non-conforming size metadata', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const binaryParser = vi.fn(async () => ({
      fileType: 'pdf' as const,
      title: 'Browser Parsed',
      markdown: '# Browser Parsed\n\nExtracted binary content.\n',
      warnings: [],
    }))
    let crdtWrites = 0
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/revisions')) return jsonResponse({ revisionId: 'rev-pdf' }, 201)
      if (url.includes('/navigation/g/artifacts/') && init?.method === 'PUT') {
        return jsonResponse({ artifactId: 'artifact-pdf' })
      }
      if (url.endsWith('/api/crdt/operations')) {
        crdtWrites += 1
        return jsonResponse(crdtWrites === 1
          ? { documentId: 'doc-pdf', title: 'Browser Parsed' }
          : { documentId: 'doc-pdf' })
      }
      if (url.includes('/navigation/g/artifacts/')) {
        return jsonResponse({ label: 'Browser Parsed', originalFilename: 'paper.pdf', status: 'ready' })
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch, binaryParser })
    const file = new File(['pdf bytes'], 'paper.pdf', { type: 'application/pdf' })

    const result = await service.uploadFile('g', file, { parentId: 'folder-pdf' })

    expect(binaryParser).toHaveBeenCalledWith(file, undefined)
    expect(result).toMatchObject({
      documentId: 'doc-pdf',
      title: 'Browser Parsed',
      fileType: 'pdf',
      readOnly: true,
      jobId: null,
      sourceFile: expect.objectContaining({ originalFilename: 'paper.pdf' }),
    })
    expect(calls.some(call => call.url.endsWith('/import'))).toBe(false)
    const crdtCalls = calls.filter(call => call.url.endsWith('/api/crdt/operations'))
    expect(JSON.parse(String(crdtCalls[0].init?.body))).toMatchObject({
      kind: 'document.write',
      graphId: 'g',
      payload: {
        title: 'Browser Parsed',
        content: '# Browser Parsed\n\nExtracted binary content.\n',
        format: 'markdown',
        parentId: 'folder-pdf',
        readOnly: true,
      },
    })
    const sourceWrite = JSON.parse(String(crdtCalls[1].init?.body))
    expect(sourceWrite).toMatchObject({
      kind: 'workspace.createDocument',
      graphId: 'g',
      documentId: 'doc-pdf',
      payload: {
        documentId: 'doc-pdf',
        sourceFile: {
          originalFilename: 'paper.pdf',
          mimeType: 'application/pdf',
          fileType: 'pdf',
        },
      },
    })
    expect(sourceWrite.payload.sourceFile).not.toHaveProperty('sizeBytes')
  })

  it('does not fall back after a successful parse when source attachment fails', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const binaryParser = vi.fn(async () => ({
      fileType: 'pdf' as const,
      title: 'Browser Parsed',
      markdown: '# Browser Parsed\n',
      warnings: [],
    }))
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/artifacts/ingestion/pdf/pipeline')) {
        return jsonResponse({ effectiveEngineId: 'pdf.fast-text' })
      }
      if (url.endsWith('/revisions')) return jsonResponse({ revisionId: 'rev-pdf' }, 201)
      if (url.includes('/navigation/g/artifacts/') && init?.method === 'PUT') {
        return jsonResponse({ artifactId: 'artifact-pdf' })
      }
      if (url.endsWith('/api/crdt/operations')) {
        const body = JSON.parse(String(init?.body))
        if (body.kind === 'document.write') return jsonResponse({ documentId: 'doc-pdf', title: 'Browser Parsed' })
        if (body.kind === 'workspace.createDocument') return jsonResponse({ error: 'source link rejected' }, 500)
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch, binaryParser })

    await expect(service.uploadFile('g', new File(['pdf'], 'paper.pdf', { type: 'application/pdf' })))
      .rejects.toThrow('source link rejected')

    const crdtKinds = calls
      .filter(call => call.url.endsWith('/api/crdt/operations'))
      .map(call => String(JSON.parse(String(call.init?.body)).kind))
    expect(crdtKinds).toEqual(['document.write', 'workspace.createDocument'])
    expect(calls.some(call => call.url.endsWith('/import'))).toBe(false)
  })

  it('reads the current pipeline for each PDF import instead of pinning a prior result', async () => {
    let pipelineReads = 0
    const binaryParser = vi.fn(async () => ({
      fileType: 'pdf' as const,
      title: 'Browser Parsed',
      markdown: '# Browser Parsed\n',
      warnings: [],
    }))
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/artifacts/ingestion/pdf/pipeline')) {
        pipelineReads += 1
        if (pipelineReads === 1) return jsonResponse({ error: 'temporary pipeline failure' }, 500)
        return jsonResponse({ effectiveEngineId: 'pdf.docling-accurate' })
      }
      if (url.endsWith('/revisions')) return jsonResponse({ revisionId: `rev-${pipelineReads}` }, 201)
      if (url.includes('/navigation/g/artifacts/') && !url.endsWith('/import')) {
        return jsonResponse({ artifactId: `artifact-${pipelineReads}` })
      }
      if (url.endsWith('/api/crdt/operations')) return jsonResponse({ documentId: 'doc-browser-pdf' })
      if (url.endsWith('/import')) return jsonResponse({ job_id: 'job-server-pdf' }, 202)
      if (url.endsWith('/graphs/jobs/job-server-pdf')) {
        return jsonResponse({ job_id: 'job-server-pdf', status: 'succeeded' })
      }
      if (url.endsWith('/graphs/jobs/job-server-pdf/result')) {
        return jsonResponse({ documentId: 'doc-server-pdf', title: 'Server Parsed', fileType: 'pdf' })
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), {
      fetch,
      binaryParser,
      pollIntervalMs: 0,
      sleep: async () => {},
    })

    const first = await service.uploadFile('g', new File(['one'], 'one.pdf', { type: 'application/pdf' }))
    const second = await service.uploadFile('g', new File(['two'], 'two.pdf', { type: 'application/pdf' }))

    expect(first.documentId).toBe('doc-browser-pdf')
    expect(second.documentId).toBe('doc-server-pdf')
    expect(binaryParser).toHaveBeenCalledTimes(1)
    expect(pipelineReads).toBe(2)
  })

  it('honors a server-side effective PDF engine instead of the browser parser', async () => {
    const binaryParser = vi.fn()
    const calls: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/api/artifacts/ingestion/pdf/pipeline')) {
        return jsonResponse({ effectiveEngineId: 'pdf.docling-accurate' })
      }
      if (url.endsWith('/revisions')) return jsonResponse({ revisionId: 'rev-pdf' }, 201)
      if (url.includes('/navigation/g/artifacts/') && !url.endsWith('/import')) {
        return jsonResponse({ artifactId: 'artifact-pdf' })
      }
      if (url.endsWith('/import')) return jsonResponse({ job_id: 'job-pdf' }, 202)
      if (url.endsWith('/graphs/jobs/job-pdf')) {
        return jsonResponse({ job_id: 'job-pdf', status: 'succeeded', progress: { percent: 100 } })
      }
      if (url.endsWith('/graphs/jobs/job-pdf/result')) {
        return jsonResponse({ documentId: 'doc-server-pdf', title: 'Server Parsed', fileType: 'pdf', readOnly: true })
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), {
      fetch,
      binaryParser,
      pollIntervalMs: 0,
      sleep: async () => {},
    })

    const result = await service.uploadFile('g', new File(['pdf'], 'paper.pdf', { type: 'application/pdf' }))

    expect(binaryParser).not.toHaveBeenCalled()
    expect(result).toMatchObject({ documentId: 'doc-server-pdf', title: 'Server Parsed', fileType: 'pdf' })
    expect(calls.some(url => url.endsWith('/api/artifacts/ingestion/pdf/pipeline'))).toBe(true)
    expect(calls.some(url => url.endsWith('/import'))).toBe(true)
  })

  it('falls back to the server import when browser PDF parsing fails', async () => {
    const binaryParser = vi.fn(async () => { throw new Error('password required') })
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/artifacts/ingestion/pdf/pipeline')) {
        return jsonResponse({ effectiveEngineId: 'pdf.fast-text' })
      }
      if (url.endsWith('/revisions')) return jsonResponse({ revisionId: 'rev-pdf' }, 201)
      if (url.includes('/navigation/g/artifacts/') && !url.endsWith('/import')) {
        return jsonResponse({ artifactId: 'artifact-pdf' })
      }
      if (url.endsWith('/import')) return jsonResponse({ job_id: 'job-fallback' }, 202)
      if (url.endsWith('/graphs/jobs/job-fallback')) {
        return jsonResponse({ job_id: 'job-fallback', status: 'succeeded' })
      }
      if (url.endsWith('/graphs/jobs/job-fallback/result')) {
        return jsonResponse({ documentId: 'doc-fallback-pdf', title: 'Fallback Parsed', fileType: 'pdf' })
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), {
      fetch,
      binaryParser,
      pollIntervalMs: 0,
      sleep: async () => {},
    })
    const progress: string[] = []

    const result = await service.uploadFile('g', new File(['pdf'], 'locked.pdf', { type: 'application/pdf' }), {
      onProgress: (_file, state) => { if (state.message) progress.push(state.message) },
    })

    expect(result.documentId).toBe('doc-fallback-pdf')
    expect(progress).toContain('Browser parse failed for locked.pdf; trying Mycl PDF import')
  })

  it('cancels the remote job when the caller aborts during polling', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/revisions')) return jsonResponse({ revisionId: 'rev' }, 201)
      if (url.includes('/navigation/g/artifacts/') && init?.method === 'PUT') return jsonResponse({ artifactId: 'staged' })
      if (url.endsWith('/import')) {
        return jsonResponse({ job_id: 'job-cancel', documentId: 'doc-pending', status: 'queued' }, 202)
      }
      if (url.endsWith('/graphs/jobs/job-cancel') && init?.method === 'DELETE') {
        return jsonResponse({ job_id: 'job-cancel', cancelled: true })
      }
      if (url.endsWith('/graphs/jobs/job-cancel')) {
        return jsonResponse({ job_id: 'job-cancel', status: 'running' })
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), {
      fetch,
      pollIntervalMs: 1,
      binaryParser: false,
      sleep: async () => {
        controller.abort()
        throw new DocumentTransferCancelledError()
      },
    })

    await expect(service.uploadFile('g', new File(['body'], 'paper.pdf', { type: 'application/pdf' }), { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledWith('/cell/graphs/jobs/job-cancel', expect.objectContaining({ method: 'DELETE' }))
  })

  // A job that stays "running" while each poll moves the clock by `stepMs`;
  // it succeeds on poll number `succeedOnPoll` (never, when that is 0).
  function slowPdfImport(stepMs: number, succeedOnPoll: number) {
    let now = 1_000_000
    let polls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/revisions')) return jsonResponse({ revisionId: 'rev' }, 201)
      if (url.includes('/navigation/g/artifacts/') && init?.method === 'PUT') return jsonResponse({ artifactId: 'staged' })
      if (url.endsWith('/import')) return jsonResponse({ job_id: 'job-slow', status: 'queued' }, 202)
      if (url.endsWith('/graphs/jobs/job-slow') && init?.method === 'DELETE') {
        return jsonResponse({ job_id: 'job-slow', cancelled: true })
      }
      if (url.endsWith('/graphs/jobs/job-slow')) {
        polls += 1
        return jsonResponse({ job_id: 'job-slow', status: polls === succeedOnPoll ? 'succeeded' : 'running' })
      }
      if (url.endsWith('/graphs/jobs/job-slow/result')) {
        return jsonResponse({ documentId: 'doc-slow', title: 'Scanned', fileType: 'pdf' })
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), {
      fetch,
      binaryParser: false,
      sleep: async () => { now += stepMs },
    })
    const upload = () => service.uploadFile('g', new File(['body'], 'scanned.pdf', { type: 'application/pdf' }))
    return { fetch, upload }
  }

  it('waits for a PDF import that takes longer than five minutes', async () => {
    // 7 polls, 1 min apart: the job ends after 6 min, as an OCR parse can.
    const { fetch, upload } = slowPdfImport(60_000, 7)

    await expect(upload()).resolves.toMatchObject({ documentId: 'doc-slow' })
    expect(fetch).not.toHaveBeenCalledWith('/cell/graphs/jobs/job-slow', expect.objectContaining({ method: 'DELETE' }))
  })

  it('waits longer than the node allows a PDF parse, then cancels the job', async () => {
    expect(DEFAULT_TRANSFER_JOB_TIMEOUT_MS).toBeGreaterThan(15 * 60_000)
    const { fetch, upload } = slowPdfImport(60_000, 0)

    await expect(upload()).rejects.toThrow('Transfer job job-slow timed out after 20 min')
    expect(fetch).toHaveBeenCalledWith('/cell/graphs/jobs/job-slow', expect.objectContaining({ method: 'DELETE' }))
  })

  it('continues a batch after per-file errors, skips OS metadata, and uses per-file parent folders', async () => {
    const parents: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/revisions')) {
        const body = JSON.parse(String(init?.body))
        if (body.filename === 'broken.txt') return jsonResponse({ detail: 'parser rejected file' }, 422)
        return jsonResponse({ revisionId: 'rev' }, 201)
      }
      if (url.includes('/navigation/g/artifacts/') && init?.method === 'PUT') return jsonResponse({ artifactId: 'staged' })
      if (url.endsWith('/api/crdt/operations')) {
        const body = JSON.parse(String(init?.body))
        parents.push(String(body.payload.parentId))
        return jsonResponse({ documentId: 'doc-keep.md', title: 'keep.md' })
      }
      if (url.includes('/navigation/g/artifacts/')) return jsonResponse({ label: 'keep', originalFilename: 'keep.md', status: 'ready' })
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch })
    const keep = new File(['a'], 'keep.md')
    const broken = new File(['b'], 'broken.txt')
    const skipped = new File(['meta'], '.DS_Store')

    const result = await service.uploadFiles('g', [keep, broken, skipped], {
      parentIdForFile: file => file.name === 'keep.md' ? 'folder-a' : 'folder-b',
    })

    expect(result.succeeded.map(item => item.file.name)).toEqual(['keep.md'])
    expect(result.failed.map(item => [item.file.name, item.error.message])).toEqual([
      ['broken.txt', 'parser rejected file'],
    ])
    expect(result.skipped).toEqual([skipped])
    expect(result.cancelled).toBe(false)
    expect(parents).toEqual(['folder-a'])
  })

  it('imports a stored artifact as an editable document through the job contract', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/artifacts/g/art%2F1/download')) {
        return new Response('# Source\n\nBody', {
          headers: {
            'content-type': 'text/markdown',
            'content-disposition': 'attachment; filename="source.md"',
          },
        })
      }
      if (url.endsWith('/api/crdt/operations')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          graphId: 'g',
          kind: 'document.write',
          payload: { title: 'Source', parentId: 'folder-a', format: 'markdown', content: '# Source\n\nBody' },
        })
        return jsonResponse({ documentId: 'doc-imported', title: 'Source' })
      }
      if (url.includes('/navigation/g/artifacts/art%2F1') && init?.method === 'PUT') {
        return jsonResponse({ artifactId: 'art/1', ingestedDocId: 'doc-imported' })
      }
      if (url.includes('/navigation/g/artifacts/art%2F1')) {
        return jsonResponse({ artifactId: 'art/1', label: 'Source', sizeBytes: 42 })
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch, sleep: async () => {} })

    await expect(service.importArtifact('g', 'art/1', {
      title: 'Source',
      parentId: 'folder-a',
      readOnly: false,
    })).resolves.toEqual({
      artifactId: 'art/1',
      documentId: 'doc-imported',
      title: 'Source',
      readOnly: false,
      jobId: null,
    })
  })

  it('clips a URL through the authenticated graph route and returns the created document', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/cell/graphs/graph%20a/imports/clip')
      expect(init?.method).toBe('POST')
      const headers = init?.headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer secret-token')
      expect(headers.get('X-User-ID')).toBe('user-a')
      expect(headers.get('Prefer')).toBe('wait-for-flush')
      expect(JSON.parse(String(init?.body))).toEqual({
        url: 'https://example.com/garden?view=full',
        title: 'Garden Article',
        folderId: 'reading',
        html: '<article><h1>Garden Article</h1><p>Deep roots.</p></article>',
      })
      return jsonResponse({
        status: 'complete',
        documents_created: 1,
        document_ids: ['doc-clip'],
        warnings: ['used deterministic HTML'],
        errors: [],
      })
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch })

    await expect(service.importWebClip('graph a', ' https://example.com/garden?view=full ', {
      title: ' Garden Article ',
      folderId: ' reading ',
      html: '<article><h1>Garden Article</h1><p>Deep roots.</p></article>',
    })).resolves.toEqual({
      documentId: 'doc-clip',
      status: 'complete',
      warnings: ['used deterministic HTML'],
    })
  })

  it('rejects unsafe clip URLs and surfaces successful-HTTP import errors', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      status: 'error',
      documentIds: [],
      warnings: [],
      errors: ['Could not extract readable content from the page'],
    })) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch })

    await expect(service.importWebClip('g', 'file:///etc/passwd')).rejects.toThrow(
      'Enter a valid http:// or https:// URL',
    )
    expect(fetch).not.toHaveBeenCalled()
    await expect(service.importWebClip('g', 'https://example.com/empty')).rejects.toMatchObject({
      message: 'Could not extract readable content from the page',
      payload: expect.objectContaining({ status: 'error' }),
    })
  })

  it('auto-detects YouTube hosts and imports transcripts through the dedicated route', async () => {
    expect(isYouTubeClipUrl('https://youtu.be/abc123')).toBe(true)
    expect(isYouTubeClipUrl('https://music.youtube.com/watch?v=abc123')).toBe(true)
    expect(isYouTubeClipUrl('https://notyoutube.com/watch?v=abc123')).toBe(false)
    expect(isYouTubeClipUrl('not a url')).toBe(false)

    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/cell/graphs/g/imports/youtube')
      expect((init?.headers as Headers).get('Prefer')).toBe('wait-for-flush')
      expect(JSON.parse(String(init?.body))).toEqual({
        url: 'https://www.youtube.com/watch?v=abc123',
        folderId: 'videos',
        languages: ['en', 'es'],
        mode: 'timestamped',
        chunkSeconds: 45,
        showRanges: true,
      })
      return jsonResponse({
        status: 'complete',
        documentIds: ['doc-video'],
        warnings: ['Transcript source notice'],
        errors: [],
      })
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch })

    await expect(service.importYouTubeClip('g', 'https://www.youtube.com/watch?v=abc123', {
      folderId: ' videos ',
      languages: [' en ', '', 'es'],
      mode: 'timestamped',
      chunkSeconds: 45,
      showRanges: true,
    })).resolves.toEqual({
      documentId: 'doc-video',
      status: 'complete',
      warnings: ['Transcript source notice'],
    })
    await expect(service.importYouTubeClip('g', 'https://example.com/video')).rejects.toThrow(
      'Enter a valid YouTube URL',
    )
  })

  it('exports raw markdown/html with server filenames and strict graph/document escaping', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Headers).get('Authorization')).toBe('Bearer secret-token')
      return new Response('# Export', {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename*=UTF-8''Garden%20Plan.md`,
        },
      })
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract('/cell/'), { fetch })

    const result = await service.exportDocument('graph/one', 'doc two', { format: 'markdown', title: 'fallback' })

    expect(await result.blob.text()).toBe('# Export')
    expect(result.filename).toBe('Garden Plan.md')
    expect(fetch).toHaveBeenCalledWith(
      '/cell/documents/graph%2Fone/doc%20two/export?format=markdown',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})

describe('document transfer browser adapters', () => {
  it('surfaces loopback and nested gateway error messages', async () => {
    await expect(gardendResponseError(
      jsonResponse({ ok: false, error: 'loopback token lacks artifacts.write' }, 403),
      'fallback',
    )).resolves.toBe('loopback token lacks artifacts.write')
    await expect(gardendResponseError(
      jsonResponse({ detail: { error_code: 'GRAPH_STORAGE_LIMIT_REACHED', message: 'Graph storage is full' } }, 403),
      'fallback',
    )).resolves.toBe('Graph storage is full')
    await expect(gardendResponseError(
      new Response('<html>gateway error</html>', { status: 502 }),
      'image upload failed: HTTP 502',
    )).resolves.toBe('image upload failed: HTTP 502')
  })

  it('recognizes system files, sanitizes download names, and parses RFC 5987 disposition names', () => {
    expect(shouldSkipDocumentImportFile(new File(['x'], '.DS_Store'))).toBe(true)
    expect(shouldSkipDocumentImportFile(new File(['x'], 'notes.md'))).toBe(false)
    expect(safeDownloadFilename('../Garden:Plan?.md')).toBe('Garden-Plan-.md')
    expect(contentDispositionFilename(`attachment; filename*=UTF-8''My%20Garden.md`)).toBe('My Garden.md')
    expect(contentDispositionFilename('attachment; filename="plain.md"')).toBe('plain.md')
  })

  it('resolves null and removes its transient input when the browser picker is cancelled', async () => {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const picking = pickDocumentFiles()
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept).toContain('.pdf')
    expect(input.multiple).toBe(true)
    input.dispatchEvent(new Event('cancel'))
    await expect(picking).resolves.toBeNull()
    expect(input.isConnected).toBe(false)
  })

  it('saves a blob through a temporary noopener download anchor and revokes the object URL', () => {
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const revoke = vi.fn()
    saveBlob(new Blob(['body']), 'Garden:Plan.md', {
      createObjectURL: () => 'blob:transfer',
      revokeObjectURL: revoke,
      revokeDelayMs: 5,
    })
    expect(click).toHaveBeenCalledOnce()
    expect(document.body.querySelector('a')).toBeNull()
    vi.advanceTimersByTime(5)
    expect(revoke).toHaveBeenCalledWith('blob:transfer')
    vi.useRealTimers()
  })

  it('binds the controlled export dialog to preview, theme, copy, download, print, and close actions', async () => {
    const dialog = document.createElement('mn-export-dialog') as MnExportDialog
    document.body.appendChild(dialog)
    const exportDocument = vi.fn(async (_graphId: string, _documentId: string, options: { format: 'markdown' | 'html'; theme?: string }) => {
      if (options.format === 'html') {
        return exported('html', `<main data-theme="${options.theme}">Plan</main>`, `Plan-${options.theme}.html`)
      }
      return exported('markdown', '# Plan', 'Plan.md')
    })
    const save = vi.fn()
    const copy = vi.fn(async () => {})
    const print = vi.fn()
    const controller = attachDocumentExportDialog(dialog, { exportDocument } as never, { save, copy, print })

    await controller.open({ graphId: 'g', documentId: 'd', title: 'Plan' })
    await dialog.updateComplete
    expect(dialog.open).toBe(true)
    expect(dialog.htmlContent).toContain('data-theme="garden"')
    expect(dialog.markdownAvailable).toBe(true)

    dialog.dispatchEvent(new CustomEvent('mn-export-copy-markdown'))
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith('# Plan'))
    expect(dialog.copyStatus).toBe('success')

    dialog.dispatchEvent(new CustomEvent('mn-export-download-markdown'))
    dialog.dispatchEvent(new CustomEvent('mn-export-download-html'))
    dialog.dispatchEvent(new CustomEvent('mn-export-print'))
    expect(save).toHaveBeenNthCalledWith(1, expect.any(Blob), 'Plan.md')
    expect(save).toHaveBeenNthCalledWith(2, expect.any(Blob), 'Plan-garden.html')
    expect(print).toHaveBeenCalledWith(dialog)

    dialog.dispatchEvent(new CustomEvent('mn-export-theme-select', { detail: { themeId: 'dusk' } }))
    await vi.waitFor(() => expect(dialog.htmlContent).toContain('data-theme="dusk"'))
    expect(exportDocument).toHaveBeenCalledWith('g', 'd', expect.objectContaining({ format: 'html', theme: 'dusk' }))

    dialog.dispatchEvent(new CustomEvent('mn-export-close'))
    expect(dialog.open).toBe(false)
    controller.destroy()
  })

  it('accepts notebooks and converts markdown and code cells without outputs or raw content', async () => {
    expect(DOCUMENT_IMPORT_ACCEPT).toContain('.ipynb')
    const notebook = {
      metadata: { language_info: { name: 'python' } },
      cells: [
        { cell_type: 'markdown', source: '# Notes' },
        { cell_type: 'code', source: ['print("hello")\n', '```python\n', 'print("nested")'], outputs: [{ text: 'SECRET_OUTPUT' }] },
        { cell_type: 'raw', source: 'RAW_SECRET' },
        { cell_type: 'markdown', source: ['## Next\n', 'A paragraph'] },
      ],
    }
    const parsed = await parseIpynbInBrowser(new File([JSON.stringify(notebook)], 'analysis.ipynb'))

    expect(parsed.fileType).toBe('ipynb')
    expect(parsed.title).toBe('analysis')
    expect(parsed.markdown).toContain('# Notes')
    expect(parsed.markdown).toContain('## Next\nA paragraph')
    expect(parsed.markdown).toContain('print("hello")\n```python\nprint("nested")')
    expect(parsed.markdown).toContain('print("nested")')
    expect(parsed.markdown).toContain('````python')
    expect(parsed.markdown.indexOf('# Notes')).toBeLessThan(parsed.markdown.indexOf('print("hello")'))
    expect(parsed.markdown.indexOf('print("hello")')).toBeLessThan(parsed.markdown.indexOf('## Next'))
    expect(parsed.markdown).not.toContain('SECRET_OUTPUT')
    expect(parsed.markdown).not.toContain('RAW_SECRET')
  })

  it('rejects malformed or empty notebooks and honors pre-aborted signals', async () => {
    await expect(parseIpynbInBrowser(new File(['not json'], 'bad.ipynb')))
      .rejects.toThrow('not valid notebook JSON')
    await expect(parseIpynbInBrowser(new File(['{}'], 'bad.ipynb')))
      .rejects.toThrow('does not contain a notebook cells array')
    await expect(parseIpynbInBrowser(new File([JSON.stringify({ cells: [{ cell_type: 'raw', source: 'raw only' }] })], 'empty.ipynb')))
      .rejects.toThrow('does not contain readable notebook markdown or code cells')
    const controller = new AbortController()
    controller.abort()
    await expect(parseIpynbInBrowser(new File(['{}'], 'cancelled.ipynb'), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('attaches large and unknown files without creating document blocks', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/cell/artifacts/g/upload')
      expect(init?.method).toBe('POST')
      const form = init?.body as FormData
      expect(form.get('mode')).toBe('attach')
      return jsonResponse({ artifactId: 'attach-1', mode: 'attached', sha256: 'abc', sizeBytes: 4, fileType: 'bin' }, 201)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch, attachThresholdBytes: 1 })

    const largeText = await service.uploadFile('g', new File(['large'], 'large.md', { type: 'text/markdown' }))
    const unknown = await service.uploadFile('g', new File(['data'], 'payload.bin', { type: 'application/octet-stream' }))

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(largeText).toMatchObject({ outcome: 'attachment', documentId: '', fileType: 'bin', jobId: null })
    expect(unknown).toMatchObject({ outcome: 'attachment', documentId: '', fileType: 'bin', jobId: null })
    expect(largeText.sourceFile).toMatchObject({
      artifactId: 'attach-1',
      storageKey: 'local://artifacts/attach-1/original/large.md',
    })
  })

  it('streams a large PDF into the artifact store and imports it in place', async () => {
    const requests: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url === '/cell/artifacts/g/upload') {
        return jsonResponse({ artifactId: 'pdf-attach', mode: 'attached', fileType: 'pdf' }, 201)
      }
      if (url === '/cell/artifacts/g/pdf-attach/import') {
        return jsonResponse({
          documentId: 'doc-large-pdf',
          title: 'large',
          readOnly: true,
          sourceFile: { artifactId: 'pdf-attach', fileType: 'pdf' },
        }, 201)
      }
      throw new Error(`Unexpected request ${url}`)
    }) as unknown as typeof globalThis.fetch
    const service = new GardendDocumentTransferService(contract(), { fetch, attachThresholdBytes: 1 })

    const uploaded = await service.uploadFile('g', new File(['pdf'], 'large.pdf', { type: 'application/pdf' }))

    expect(uploaded).toMatchObject({ outcome: 'document', documentId: 'doc-large-pdf', fileType: 'pdf' })
    expect(requests).toEqual([
      '/cell/artifacts/g/upload',
      '/cell/artifacts/g/pdf-attach/import',
    ])
  })
})
