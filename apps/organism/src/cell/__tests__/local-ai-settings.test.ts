import { describe, expect, it, vi } from 'vitest'
import type { ShrubberyContract } from '@shrubbery/nucleus'
import { GardendLocalAiSettings, modelChoiceLine, modelDownloadSize } from '../local-ai-settings.js'

const GRAPH_ID = 'local-ai-graph'
const BASE = `https://cell.example/g/${GRAPH_ID}`

function contract(): Pick<ShrubberyContract, 'auth' | 'runtime'> {
  return {
    auth: {
      token: () => 'local-ai-token',
      userId: () => 'local-ai-user',
      isAuthenticated: () => true,
      whenReady: () => Promise.resolve(),
      onChange: () => () => undefined,
    },
    runtime: {
      mode: () => 'local',
      isGateway: () => false,
      graphBaseUrl: () => BASE,
    },
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface RecordedRequest {
  readonly path: string
  readonly method: string
  readonly body: unknown
  readonly authorization: string | null
  readonly userId: string | null
}

function backend(overrides: Record<string, (request: RecordedRequest) => Response> = {}) {
  const requests: RecordedRequest[] = []
  let indexPolls = 0
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const request: RecordedRequest = {
      path: url.pathname,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null,
      authorization: new Headers(init.headers).get('authorization'),
      userId: new Headers(init.headers).get('x-user-id'),
    }
    requests.push(request)
    const key = `${request.method} ${request.path}`
    if (overrides[key]) return overrides[key]!(request)

    if (request.path.endsWith('/api/semantic/model/status')) return json({
      modelId: 'fastembed/bge-small-en-v1.5',
      displayName: 'BGE Small',
      providerId: 'fastembed',
      prepared: true,
      loaded: true,
      runtimeAvailable: true,
      effectiveBatchSize: 4,
    })
    if (request.path.endsWith('/api/semantic/models')) return json([
      {
        modelId: 'fastembed/bge-small-en-v1.5',
        displayName: 'BGE Small',
        selected: true,
        recommended: true,
        effectiveBatchSize: 4,
      },
      {
        modelId: 'candle/nomic-embed-text-v2-moe',
        displayName: 'Nomic V2 MoE',
        selected: false,
      },
    ])
    if (request.path.endsWith(`/api/semantic/index/status/${GRAPH_ID}`)) return json({
      documentCount: 3,
      blockCount: 17,
      staleDocumentCount: 1,
      indexedAt: '2026-07-11T12:00:00.000Z',
      compatible: true,
    })
    if (request.path.endsWith('/api/artifacts/ingestion/approaches')) return json([
      { approachId: 'markdown.direct', label: 'Markdown Direct', family: 'markdown', status: 'available', selectable: true },
      { approachId: 'pdf.fast-text', label: 'PDF Fast Text', family: 'pdf', status: 'available', selectable: true },
      { approachId: 'pdf.ocr', label: 'OCR candidate', family: 'pdf', status: 'candidate', selectable: false },
    ])
    if (request.path.endsWith('/api/artifacts/ingestion/docling/status')) return json({
      supported: false,
      available: false,
      status: 'unsupported',
      reason: 'unsupported on this fixture platform',
    })
    if (request.path.endsWith('/api/artifacts/ingestion/pdf/pipeline')) return json({
      preferredEngineId: 'auto',
      effectiveEngineId: 'pdf.fast-text',
      effectiveReason: 'Auto selected the available baseline.',
      platform: 'fixture',
      engines: [
        { engineId: 'pdf.fast-text', label: 'PDF Fast Text', implemented: true, available: true },
        { engineId: 'pdf.docling-accurate', label: 'Docling', implemented: true, available: false },
        { engineId: 'pdf.ocrmypdf-tesseract', label: 'OCRmyPDF', implemented: false, available: false },
      ],
      preferenceOptions: [
        { engineId: 'auto', label: 'Auto' },
        { engineId: 'pdf.fast-text', label: 'Fast Text' },
        { engineId: 'pdf.docling-accurate', label: 'Docling' },
        { engineId: 'pdf.ocrmypdf-tesseract', label: 'OCRmyPDF' },
      ],
    })
    if (request.method === 'PUT' && request.path.endsWith('/api/semantic/model/config')) return json({
      modelId: String((request.body as Record<string, unknown>).modelId),
      displayName: 'Configured model',
      effectiveBatchSize: Number((request.body as Record<string, unknown>).batchSize),
      prepared: false,
      loaded: false,
      runtimeAvailable: true,
    })
    if (request.method === 'PUT' && request.path.endsWith('/api/artifacts/ingestion/pdf/pipeline')) return json({
      preferredEngineId: String((request.body as Record<string, unknown>).preferredEngineId),
      effectiveEngineId: 'pdf.fast-text',
      effectiveReason: 'Fixture preference saved.',
      engines: [],
      preferenceOptions: [],
    })
    if (request.method === 'POST' && request.path.endsWith('/api/semantic/index/refresh/jobs')) {
      return json({ job_id: 'semantic-job-1', status: 'queued' }, 202)
    }
    if (request.path.endsWith('/api/semantic/index/refresh/jobs/semantic-job-1')) {
      indexPolls += 1
      return indexPolls === 1
        ? json({ job_id: 'semantic-job-1', status: 'running', progress: { percent: 45, message: 'Embedding blocks' } })
        : json({ job_id: 'semantic-job-1', status: 'succeeded', progress: { percent: 100, message: 'Index ready' } })
    }
    return json({ error: `Unhandled ${key}` }, 404)
  })
  return { fetch, requests }
}

const emptySection = {
  id: 'local-ai',
  title: 'Local AI',
  description: 'Local model and ingestion state.',
} as const

describe('GardendLocalAiSettings', () => {
  it('projects real model, index, and ingestion state without advertising unwired engines', async () => {
    const fixture = backend()
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, { fetch: fixture.fetch })
    await settings.ensureLoaded()
    const section = settings.decorateSection(emptySection)

    expect(fixture.requests).toHaveLength(6)
    expect(fixture.requests.every(request => request.authorization === 'Bearer local-ai-token')).toBe(true)
    expect(fixture.requests.every(request => request.userId === 'local-ai-user')).toBe(true)
    expect(section.wide).toBe(false)
    expect(section.metrics?.map(metric => [metric.id, metric.value])).toEqual([
      ['semantic-model-status', 'BGE Small'],
      ['semantic-index-status', '17 blocks'],
      ['pdf-pipeline-status', 'PDF Fast Text'],
      ['ingestion-approaches', '2 available'],
    ])
    expect(section.selects?.find(select => select.id === 'semanticModel')?.options).toEqual([
      { value: 'fastembed/bge-small-en-v1.5', label: 'BGE Small · recommended' },
      { value: 'candle/nomic-embed-text-v2-moe', label: 'Nomic V2 MoE' },
    ])
    expect(section.selects?.find(select => select.id === 'pdfEngine')?.options.map(option => option.value)).toEqual([
      'auto', 'pdf.fast-text', 'pdf.docling-accurate',
    ])
    expect(JSON.stringify(section)).not.toContain('pdf.ocrmypdf-tesseract')
    expect(section.jobs?.map(job => job.id)).toEqual([
      'prepare-semantic-model', 'refresh-semantic-index', 'refresh-local-ai',
    ])
    expect(section.notes).toContain('Docling is unavailable on this platform: unsupported on this fixture platform')
  })

  it('groups search and PDF rows by topic, and puts Refresh status beside the title', async () => {
    const fixture = backend()
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, { fetch: fixture.fetch })
    await settings.ensureLoaded()
    const section = settings.decorateSection(emptySection)

    expect(section.groups?.map(group => [group.id, group.title])).toEqual([
      ['semantic-search', 'Search by meaning'],
      ['pdf-reading', 'Reading PDFs'],
    ])
    const inGroup = (id: string) => [
      ...(section.metrics ?? []), ...(section.selects ?? []), ...(section.jobs ?? []),
    ].filter(row => row.group === id).map(row => row.id)
    expect(inGroup('semantic-search')).toEqual([
      'semantic-model-status', 'semantic-index-status', 'semanticModel', 'semanticBatchSize',
      'prepare-semantic-model', 'refresh-semantic-index',
    ])
    expect(inGroup('pdf-reading')).toEqual(['pdf-pipeline-status', 'ingestion-approaches', 'pdfEngine'])
    const rebuild = section.jobs?.find(job => job.id === 'refresh-semantic-index')
    expect(rebuild?.label).toBe('Rebuild graph semantic/vector index')
    expect(rebuild?.actionLabel).toBe('Rebuild')
    const refresh = section.jobs?.find(job => job.id === 'refresh-local-ai')
    expect(refresh?.placement).toBe('header')
    expect(refresh?.actionLabel).toBe('Refresh status')
    const explainer = section.groups?.[0].explainer ?? []
    expect(explainer.filter(entry => typeof entry === 'string').join(' ')).toContain('embedding')
    expect(explainer.filter(entry => typeof entry === 'string').join(' ')).toContain('keeps itself up to date')
  })

  it('describes each model from the node\'s own numbers and never invents a size', () => {
    expect(modelDownloadSize('small F32 safetensors (~130 MB)')).toBe('about 130 MB')
    expect(modelDownloadSize('large Candle model')).toBeNull()
    expect(modelChoiceLine({
      displayName: 'BGE Small EN v1.5', recommended: true, speed: 'fast', quality: 'balanced',
      sizeHint: 'small F32 safetensors (~130 MB)', dimensions: 384,
    })).toBe('BGE Small EN v1.5 (recommended): fast, balanced quality, about 130 MB, 384 numbers per block.')
    expect(modelChoiceLine({
      displayName: 'Nomic Embed Text V2 MoE', speed: 'slow', quality: 'quality', sizeHint: 'large Candle model', dimensions: 768,
    })).toBe('Nomic Embed Text V2 MoE: slow, high quality, size not listed, 768 numbers per block.')
    // Nomic's size is measured from its files when the node's hint has no number.
    expect(modelChoiceLine({
      modelId: 'fastembed/nomic-ai/nomic-embed-text-v2-moe',
      displayName: 'Nomic Embed Text V2 MoE', speed: 'slow', quality: 'quality', sizeHint: 'large Candle model', dimensions: 768,
    })).toBe('Nomic Embed Text V2 MoE: slow, high quality, about 1.9 GB, 768 numbers per block.')
  })

  it('persists model, batch, and PDF choices through exact authenticated gardend routes', async () => {
    const fixture = backend()
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, { fetch: fixture.fetch })
    await settings.ensureLoaded()
    await settings.select('semanticModel', 'candle/nomic-embed-text-v2-moe')
    await settings.select('semanticBatchSize', '8')
    await settings.select('pdfEngine', 'pdf.docling-accurate')

    const writes = fixture.requests.filter(request => request.method === 'PUT')
    expect(writes).toEqual([
      expect.objectContaining({
        path: `/g/${GRAPH_ID}/api/semantic/model/config`,
        body: { modelId: 'candle/nomic-embed-text-v2-moe', batchSize: 4 },
      }),
      expect.objectContaining({
        path: `/g/${GRAPH_ID}/api/semantic/model/config`,
        body: { modelId: 'fastembed/bge-small-en-v1.5', batchSize: 8 },
      }),
      expect.objectContaining({
        path: `/g/${GRAPH_ID}/api/artifacts/ingestion/pdf/pipeline`,
        body: { preferredEngineId: 'pdf.docling-accurate' },
      }),
    ])
  })

  it('runs and polls semantic indexing as a cancellable backend job', async () => {
    const fixture = backend()
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, {
      fetch: fixture.fetch,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    })
    await settings.ensureLoaded()
    await settings.job('refresh-semantic-index')

    const submit = fixture.requests.find(request => request.method === 'POST'
      && request.path.endsWith('/api/semantic/index/refresh/jobs'))
    expect(submit?.body).toEqual({ graphId: GRAPH_ID, flushBoundary: 'required' })
    const section = settings.decorateSection(emptySection)
    expect(section.jobs?.find(job => job.id === 'refresh-semantic-index')).toMatchObject({
      status: 'succeeded',
      detail: 'Index ready',
      progress: 100,
    })
  })

  it('keeps watching a healthy reindex beyond the former ten-minute cutoff', async () => {
    vi.useFakeTimers()
    let polls = 0
    const fixture = backend({
      [`GET /g/${GRAPH_ID}/api/semantic/index/refresh/jobs/semantic-job-1`]: () => {
        polls += 1
        return polls < 802
          ? json({ job_id: 'semantic-job-1', status: 'running', progress: { percent: 45, message: 'Embedding blocks' } })
          : json({ job_id: 'semantic-job-1', status: 'succeeded', progress: { percent: 100, message: 'Index ready' } })
      },
    })

    try {
      vi.setSystemTime(0)
      const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, {
        fetch: fixture.fetch,
        sleep: async () => { vi.advanceTimersByTime(750) },
      })
      await settings.ensureLoaded()
      await settings.job('refresh-semantic-index')

      expect(polls).toBe(802)
      expect(settings.decorateSection(emptySection).jobs?.find(job => job.id === 'refresh-semantic-index')).toMatchObject({
        status: 'succeeded',
        detail: 'Index ready',
        progress: 100,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps partial runtime failures visible instead of replacing real ingestion state with defaults', async () => {
    const failure = { error: 'constitution is absent' }
    const fixture = backend({
      [`GET /g/${GRAPH_ID}/api/semantic/model/status`]: () => json(failure, 500),
      [`GET /g/${GRAPH_ID}/api/semantic/models`]: () => json(failure, 500),
      [`GET /g/${GRAPH_ID}/api/semantic/index/status/${GRAPH_ID}`]: () => json(failure, 500),
    })
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, { fetch: fixture.fetch })
    await settings.ensureLoaded()
    const section = settings.decorateSection(emptySection)

    expect(section.metrics?.map(metric => metric.id)).toEqual([
      'pdf-pipeline-status', 'ingestion-approaches',
    ])
    expect(section.metrics?.find(metric => metric.id === 'semantic-model-status')).toBeUndefined()
    expect(fixture.requests).toHaveLength(4)
    expect(section.notes?.filter(note => note.includes('constitution is absent'))).toHaveLength(1)
    expect(JSON.stringify(section)).not.toContain('768')
    expect(JSON.stringify(section)).not.toContain('fastembed')
  })

  it('renders a restart-interrupted reindex job as interrupted, never as an operation failure', async () => {
    const fixture = backend({
      [`GET /g/${GRAPH_ID}/api/semantic/index/refresh/jobs/semantic-job-1`]: () => json({
        job_id: 'semantic-job-1',
        status: 'failed',
        detail: {
          error_code: 'JOB_INTERRUPTED',
          reason: 'owner_restarted',
          interruption: { outcome: 'unknown' },
        },
      }),
    })
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, {
      fetch: fixture.fetch,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    })
    await settings.ensureLoaded()
    await settings.job('refresh-semantic-index')

    const section = settings.decorateSection(emptySection)
    expect(section.jobs?.find(job => job.id === 'refresh-semantic-index')).toMatchObject({
      status: 'interrupted',
      detail: 'Interrupted (outcome unknown — inspect before retrying).',
      progress: null,
    })
    // The interruption is not an error: it must not land in the notes/errors.
    expect(JSON.stringify(section.jobs)).not.toContain('failed')
  })

  it('keeps a plain reindex failure (no JOB_INTERRUPTED code) as an error', async () => {
    const fixture = backend({
      [`GET /g/${GRAPH_ID}/api/semantic/index/refresh/jobs/semantic-job-1`]: () => json({
        job_id: 'semantic-job-1',
        status: 'failed',
        error: 'embedding model OOM',
      }),
    })
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, {
      fetch: fixture.fetch,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    })
    await settings.ensureLoaded()
    await settings.job('refresh-semantic-index')

    const section = settings.decorateSection(emptySection)
    expect(section.jobs?.find(job => job.id === 'refresh-semantic-index')).toMatchObject({
      status: 'failed',
      detail: 'embedding model OOM',
    })
  })

  function doclingBackend(steps: readonly Record<string, unknown>[]) {
    // GET status answers the current step; each read after set-up starts
    // moves one step on and stays on the last.
    let started = false
    let index = 0
    const before = {
      supported: true,
      available: false,
      status: 'setup-required',
      reason: 'Docling is not set up on this computer yet',
      setupDownloads: ['uv 0.10.4 (about 20 MB) from https://github.com/astral-sh/uv', 'Python, Docling and PyTorch'],
    }
    return backend({
      [`GET /g/${GRAPH_ID}/api/artifacts/ingestion/docling/status`]: () => {
        if (!started) return json(before)
        const step = steps[Math.min(index, steps.length - 1)]!
        index += 1
        return json(step)
      },
      [`POST /g/${GRAPH_ID}/api/artifacts/ingestion/docling/prepare`]: () => {
        started = true
        return json({ supported: true, available: false, status: 'preparing', reason: 'Starting' })
      },
    })
  }

  it('says what Docling set-up downloads before it is started', async () => {
    const fixture = doclingBackend([])
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, { fetch: fixture.fetch })
    await settings.ensureLoaded()
    const job = settings.decorateSection(emptySection).jobs?.find(item => item.id === 'prepare-docling')
    expect(job).toMatchObject({ label: 'Set up Docling', status: 'idle', actionLabel: 'Set up' })
    expect(job?.detail).toContain('Set-up downloads: uv 0.10.4 (about 20 MB) from https://github.com/astral-sh/uv; Python, Docling and PyTorch.')
  })

  it('follows a background Docling set-up to its end', async () => {
    const fixture = doclingBackend([
      { supported: true, available: false, status: 'preparing', reason: 'Downloading Python and Docling' },
      { supported: true, available: true, status: 'available', reason: null },
    ])
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, {
      fetch: fixture.fetch,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    })
    await settings.ensureLoaded()
    await settings.job('prepare-docling')

    expect(fixture.requests.filter(request => request.method === 'POST'
      && request.path.endsWith('/api/artifacts/ingestion/docling/prepare'))).toHaveLength(1)
    expect(settings.decorateSection(emptySection).jobs?.find(item => item.id === 'prepare-docling')).toMatchObject({
      status: 'succeeded',
      detail: 'Docling is ready.',
    })
  })

  it('keeps following a Docling set-up through a failed status read', async () => {
    let reads = 0
    const fixture = backend({
      [`GET /g/${GRAPH_ID}/api/artifacts/ingestion/docling/status`]: () => {
        reads += 1
        if (reads === 1) return json({ supported: true, available: false, status: 'setup-required', reason: 'Docling is not set up on this computer yet' })
        if (reads === 2) return json({ error: 'cell busy' }, 503)
        return json({ supported: true, available: true, status: 'available', reason: null })
      },
      [`POST /g/${GRAPH_ID}/api/artifacts/ingestion/docling/prepare`]: () =>
        json({ supported: true, available: false, status: 'preparing', reason: 'Starting' }),
    })
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, {
      fetch: fixture.fetch,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    })
    await settings.ensureLoaded()
    await settings.job('prepare-docling')

    expect(settings.decorateSection(emptySection).jobs?.find(item => item.id === 'prepare-docling')).toMatchObject({
      status: 'succeeded',
      detail: 'Docling is ready.',
    })
  })

  it('reports a Docling set-up that ended without a working runtime', async () => {
    const fixture = doclingBackend([
      { supported: true, available: false, status: 'setup-required', reason: 'The last set-up did not finish: download uv: timed out' },
    ])
    const settings = new GardendLocalAiSettings(contract(), GRAPH_ID, {
      fetch: fixture.fetch,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    })
    await settings.ensureLoaded()
    await settings.job('prepare-docling')

    expect(settings.decorateSection(emptySection).jobs?.find(item => item.id === 'prepare-docling')).toMatchObject({
      status: 'failed',
      detail: 'The last set-up did not finish: download uv: timed out',
    })
  })
})
