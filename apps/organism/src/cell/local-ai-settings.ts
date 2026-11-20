/**
 * Authenticated gardend-backed Local AI settings.
 *
 * The Garden desktop settings page talks to these services through Tauri IPC.
 * A headless gardend cell exposes the same model, semantic-index, and ingestion
 * primitives over its loopback REST API. This controller keeps that transport
 * in the shell and projects only non-secret, render-ready rows into the
 * controlled settings component.
 */

import type {
  MnSettingsJob,
  MnSettingsSection,
} from '@shrubbery/components'
import type { ShrubberyContract } from '@shrubbery/nucleus'

type LocalAiContract = Pick<ShrubberyContract, 'auth' | 'runtime'>

export interface GardendLocalAiSettingsOptions {
  readonly fetch?: typeof fetch
  readonly pollIntervalMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

interface JsonRecord {
  readonly [key: string]: unknown
}

interface SemanticModelStatus extends JsonRecord {
  readonly modelId?: string
  readonly displayName?: string
  readonly providerId?: string
  readonly prepared?: boolean
  readonly loaded?: boolean
  readonly setupRequired?: boolean
  readonly runtimeAvailable?: boolean
  readonly effectiveBatchSize?: number
  readonly defaultBatchSize?: number
  readonly reason?: string | null
}

interface SemanticModelDescriptor extends JsonRecord {
  readonly modelId?: string
  readonly displayName?: string
  readonly selected?: boolean
  readonly recommended?: boolean
  readonly effectiveBatchSize?: number
  readonly defaultBatchSize?: number
  /** The node's catalog words (garden semantic_model_catalog.rs). */
  readonly speed?: string
  readonly quality?: string
  readonly sizeHint?: string
  readonly dimensions?: number
}

interface SemanticIndexStatus extends JsonRecord {
  readonly documentCount?: number
  readonly blockCount?: number
  readonly staleDocumentCount?: number
  readonly indexedAt?: string | null
  readonly compatible?: boolean
  readonly reason?: string | null
}

interface PdfEngineDescriptor extends JsonRecord {
  readonly engineId?: string
  readonly label?: string
  readonly implemented?: boolean
  readonly available?: boolean
  readonly status?: string
}

interface PdfPreferenceOption extends JsonRecord {
  readonly engineId?: string
  readonly label?: string
  readonly description?: string
}

interface PdfPipelineStatus extends JsonRecord {
  readonly preferredEngineId?: string
  readonly effectiveEngineId?: string
  readonly effectiveReason?: string
  readonly platform?: string
  readonly engines?: readonly PdfEngineDescriptor[]
  readonly preferenceOptions?: readonly PdfPreferenceOption[]
}

interface IngestionApproach extends JsonRecord {
  readonly approachId?: string
  readonly label?: string
  readonly family?: string
  readonly status?: string
  readonly selectable?: boolean
}

interface DoclingRuntimeStatus extends JsonRecord {
  readonly prepared?: boolean
  readonly available?: boolean
  readonly supported?: boolean
  readonly setupRequired?: boolean
  readonly status?: string
  readonly reason?: string | null
  /** What set-up fetches from the network, in the node's words. */
  readonly setupDownloads?: readonly string[]
}

type LocalAiOperationStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/** Epsilon's startup recovery (garden 5ee0570) marks jobs that were queued or
 * running when Garden restarted as status=failed with
 * detail.error_code="JOB_INTERRUPTED" and detail.interruption.outcome="unknown".
 * The worker died; the OPERATION's outcome is unknown (writes may have
 * committed). Render as an interruption to inspect, never as an operation
 * failure. A plain failure is the case without that error_code. */
function interruptedJobDetail(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const detail = payload.detail
  if (!isRecord(detail)) return null
  const code = stringValue(detail.error_code ?? detail.errorCode)
  if (code !== 'JOB_INTERRUPTED') return null
  const interruption = isRecord(detail.interruption) ? detail.interruption : null
  const outcome = stringValue(interruption?.outcome) || 'unknown'
  return `Interrupted (outcome ${outcome} — inspect before retrying).`
}

interface LocalAiOperation {
  readonly id: string
  readonly label: string
  readonly status: LocalAiOperationStatus
  readonly detail: string
  readonly progress: number | null
  readonly backendJobId?: string | null
}

const MODEL_BATCH_SIZES = [1, 2, 4, 8, 16, 32, 64] as const
const LOAD_KEYS = ['model', 'models', 'index', 'approaches', 'docling', 'pdf'] as const
type LoadKey = (typeof LOAD_KEYS)[number]

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clampPercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null
}

function errorText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!isRecord(value)) return fallback
  for (const key of ['error', 'message', 'detail']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (isRecord(candidate)) {
      const nested = errorText(candidate, '')
      if (nested) return nested
    }
  }
  return fallback
}

async function responseValue(response: Response): Promise<unknown> {
  if (response.status === 204) return null
  const body = await response.text()
  if (!body.trim()) return null
  try {
    return JSON.parse(body) as unknown
  } catch {
    return body
  }
}

function modelReadiness(status: SemanticModelStatus | null): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (!status) return { label: 'Unavailable', tone: 'danger' }
  if (status.prepared && status.loaded) return { label: 'Prepared and loaded', tone: 'success' }
  if (status.loaded) return { label: 'Loaded for this run', tone: 'success' }
  if (status.prepared) return { label: 'Prepared', tone: 'warning' }
  if (status.runtimeAvailable === false) return { label: 'Runtime unavailable', tone: 'danger' }
  return { label: 'Setup required', tone: 'warning' }
}

function indexReadiness(status: SemanticIndexStatus | null): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (!status) return { label: 'Unavailable', tone: 'danger' }
  if (status.compatible === false) return { label: 'Incompatible', tone: 'danger' }
  if (finiteNumber(status.staleDocumentCount) > 0) return { label: 'Stale', tone: 'warning' }
  if (stringValue(status.indexedAt)) return { label: 'Ready', tone: 'success' }
  return { label: 'Not built', tone: 'neutral' }
}

/** "~130 MB" from the node's size hint, or null when it gives no number. */
export function modelDownloadSize(sizeHint: unknown): string | null {
  const match = /~?\s*\d+(?:\.\d+)?\s*(?:KB|MB|GB)/i.exec(stringValue(sizeHint))
  return match ? `about ${match[0].replace(/^~\s*/, '')}` : null
}

/**
 * Download sizes the node's catalog doesn't state, measured from the model's
 * files. Nomic Embed Text V2 MoE: model.safetensors 1,901,187,232 bytes plus
 * tokenizer.json 17,082,734 and config.json (Hugging Face file listing for
 * nomic-ai/nomic-embed-text-v2-moe, 2026-11-18). Its catalog hint is "large
 * Candle model" (garden semantic_model_catalog.rs); once that hint carries a
 * number, the hint wins and this entry can go.
 */
const MEASURED_DOWNLOAD_SIZES: Readonly<Record<string, string>> = {
  'fastembed/nomic-ai/nomic-embed-text-v2-moe': 'about 1.9 GB',
}

/** The node's quality words, as a sentence says them. */
const QUALITY_WORDS: Record<string, string> = { quality: 'high', balanced: 'balanced', light: 'lighter' }

/** One line per model for the explainer, in the node's words and numbers. */
export function modelChoiceLine(model: SemanticModelDescriptor): string | null {
  const name = stringValue(model.displayName) || stringValue(model.modelId)
  if (!name) return null
  const parts: string[] = []
  const speed = stringValue(model.speed)
  const quality = stringValue(model.quality)
  if (speed) parts.push(speed)
  if (quality) parts.push(`${QUALITY_WORDS[quality] ?? quality} quality`)
  parts.push(modelDownloadSize(model.sizeHint) ?? MEASURED_DOWNLOAD_SIZES[stringValue(model.modelId)] ?? 'size not listed')
  const dimensions = finiteNumber(model.dimensions)
  if (dimensions) parts.push(`${dimensions} numbers per block`)
  return `${name}${model.recommended ? ' (recommended)' : ''}: ${parts.join(', ')}.`
}

const SEARCH_GROUP = 'semantic-search'
const PDF_GROUP = 'pdf-reading'

function formatCount(value: unknown, singular: string, plural = `${singular}s`): string {
  const count = finiteNumber(value)
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`
}

export class GardendLocalAiSettings {
  private readonly fetchImpl: typeof fetch
  private readonly pollIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly subscribers = new Set<() => void>()
  private readonly errors = new Map<LoadKey | 'operation', string>()
  private loaded = false
  private loading = false
  private modelStatus: SemanticModelStatus | null = null
  private models: readonly SemanticModelDescriptor[] = []
  private indexStatus: SemanticIndexStatus | null = null
  private approaches: readonly IngestionApproach[] = []
  private doclingStatus: DoclingRuntimeStatus | null = null
  private pdfStatus: PdfPipelineStatus | null = null
  private operation: LocalAiOperation | null = null

  constructor(
    private readonly contract: LocalAiContract,
    private readonly graphId: string,
    options: GardendLocalAiSettingsOptions = {},
  ) {
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') throw new Error('GardendLocalAiSettings: fetch is unavailable')
    this.fetchImpl = fetchImpl.bind(globalThis)
    this.pollIntervalMs = options.pollIntervalMs ?? 750
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  private emit(): void {
    for (const callback of this.subscribers) callback()
  }

  private apiBase(): string {
    const base = this.contract.runtime.graphBaseUrl(this.graphId).replace(/\/+$/, '')
    if (!base) throw new Error(`No Local AI API base is available for graph ${this.graphId}`)
    return base
  }

  private headers(extra: HeadersInit = {}): Headers {
    const headers = new Headers(extra)
    const token = this.contract.auth.token()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const userId = this.contract.auth.userId()
    if (userId) headers.set('X-User-ID', userId)
    return headers
  }

  private async request(path: string, init: RequestInit = {}, label = 'Local AI request'): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase()}${path}`, {
      ...init,
      headers: this.headers(init.headers),
      cache: init.cache ?? 'no-store',
    })
    const payload = await responseValue(response)
    if (!response.ok) throw new Error(errorText(payload, `${label} failed: HTTP ${response.status}`))
    return payload
  }

  private async json(path: string, method: 'POST' | 'PUT', body: unknown, label: string): Promise<unknown> {
    return this.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, label)
  }

  private async read<T>(key: LoadKey, path: string): Promise<T | null> {
    try {
      const value = await this.request(path, {}, `Read ${key}`)
      this.errors.delete(key)
      return value as T
    } catch (error) {
      this.errors.set(key, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  async ensureLoaded(force = false): Promise<void> {
    if (this.loading || (this.loaded && !force)) return
    this.loading = true
    const [model, approaches, docling, pdf] = await Promise.all([
      this.read<SemanticModelStatus>('model', '/api/semantic/model/status'),
      this.read<readonly IngestionApproach[]>('approaches', '/api/artifacts/ingestion/approaches'),
      this.read<DoclingRuntimeStatus>('docling', '/api/artifacts/ingestion/docling/status'),
      this.read<PdfPipelineStatus>('pdf', '/api/artifacts/ingestion/pdf/pipeline'),
    ])
    const [models, index] = model
      ? await Promise.all([
          this.read<readonly SemanticModelDescriptor[]>('models', '/api/semantic/models'),
          this.read<SemanticIndexStatus>('index', `/api/semantic/index/status/${encodeURIComponent(this.graphId)}`),
        ])
      : [null, null]
    if (!model) {
      // Model/catalog/index all resolve through the same constituted embedder
      // selection. One truthful model error is more useful than three identical
      // 500s and prevents Settings refreshes from hammering a known-broken seam.
      this.errors.delete('models')
      this.errors.delete('index')
    }
    this.modelStatus = isRecord(model) ? model : null
    this.models = Array.isArray(models) ? models.filter(isRecord) : []
    this.indexStatus = isRecord(index) ? index : null
    this.approaches = Array.isArray(approaches) ? approaches.filter(isRecord) : []
    this.doclingStatus = isRecord(docling) ? docling : null
    this.pdfStatus = isRecord(pdf) ? pdf : null
    this.loading = false
    this.loaded = true
  }

  handlesSelect(settingId: string): boolean {
    return settingId === 'semanticModel' || settingId === 'semanticBatchSize' || settingId === 'pdfEngine'
  }

  handlesJob(jobId: string): boolean {
    return jobId === 'prepare-semantic-model'
      || jobId === 'refresh-semantic-index'
      || jobId === 'prepare-docling'
      || jobId === 'refresh-local-ai'
  }

  private selectedModel(): SemanticModelDescriptor | null {
    const selectedId = stringValue(this.modelStatus?.modelId)
    return this.models.find(model => model.selected)
      ?? this.models.find(model => stringValue(model.modelId) === selectedId)
      ?? this.models[0]
      ?? null
  }

  private currentBatchSize(): number {
    const model = this.selectedModel()
    return finiteNumber(this.modelStatus?.effectiveBatchSize)
      || finiteNumber(model?.effectiveBatchSize)
      || finiteNumber(this.modelStatus?.defaultBatchSize)
      || finiteNumber(model?.defaultBatchSize)
      || 4
  }

  async select(settingId: string, value: string): Promise<void> {
    this.errors.delete('operation')
    try {
      if (settingId === 'semanticModel') {
        const result = await this.json('/api/semantic/model/config', 'PUT', {
          modelId: value,
          batchSize: this.currentBatchSize(),
        }, 'Save embedding model')
        this.modelStatus = isRecord(result) ? result : this.modelStatus
      } else if (settingId === 'semanticBatchSize') {
        const modelId = stringValue(this.selectedModel()?.modelId ?? this.modelStatus?.modelId)
        if (!modelId) throw new Error('No embedding model is available to configure.')
        const result = await this.json('/api/semantic/model/config', 'PUT', {
          modelId,
          batchSize: Math.max(1, Math.min(64, Number.parseInt(value, 10) || 1)),
        }, 'Save embedding batch size')
        this.modelStatus = isRecord(result) ? result : this.modelStatus
      } else if (settingId === 'pdfEngine') {
        const result = await this.json('/api/artifacts/ingestion/pdf/pipeline', 'PUT', {
          preferredEngineId: value,
        }, 'Save PDF ingestion engine')
        this.pdfStatus = isRecord(result) ? result : this.pdfStatus
      }
    } catch (error) {
      this.errors.set('operation', error instanceof Error ? error.message : String(error))
    }
    await this.ensureLoaded(true)
  }

  private setOperation(operation: LocalAiOperation | null): void {
    this.operation = operation ? Object.freeze({ ...operation }) : null
    this.emit()
  }

  private patchOperation(patch: Partial<LocalAiOperation>): void {
    if (!this.operation) return
    this.setOperation({ ...this.operation, ...patch })
  }

  private async prepareSemanticModel(): Promise<void> {
    this.setOperation({
      id: 'prepare-semantic-model',
      label: 'Prepare embedding model',
      status: 'running',
      detail: 'Preparing the selected model in the local cache…',
      progress: null,
    })
    const result = await this.request('/api/semantic/model/prepare', { method: 'POST' }, 'Prepare embedding model')
    this.modelStatus = isRecord(result) ? result : this.modelStatus
    this.patchOperation({ status: 'succeeded', detail: 'Embedding model prepared and loaded.', progress: 100 })
  }

  private async refreshSemanticIndex(): Promise<void> {
    if (this.operation?.id === 'refresh-semantic-index'
      && (this.operation.status === 'queued' || this.operation.status === 'running')
      && this.operation.backendJobId) {
      await this.request(
        `/api/semantic/index/refresh/jobs/${encodeURIComponent(this.operation.backendJobId)}`,
        { method: 'DELETE' },
        'Cancel the index rebuild',
      )
      this.patchOperation({ status: 'cancelled', detail: 'Rebuild cancelled.', progress: null })
      return
    }

    this.setOperation({
      id: 'refresh-semantic-index',
      label: 'Rebuild graph semantic/vector index',
      status: 'queued',
      detail: 'Saving recent edits, then rebuilding…',
      progress: 0,
    })
    const submit = await this.json('/api/semantic/index/refresh/jobs', 'POST', {
      graphId: this.graphId,
      flushBoundary: 'required',
    }, 'Start semantic index refresh')
    if (!isRecord(submit)) throw new Error('Semantic index refresh returned an invalid job envelope.')
    const jobId = stringValue(submit.job_id ?? submit.jobId)
    if (!jobId) throw new Error('Semantic index refresh did not return a job_id.')
    this.patchOperation({ backendJobId: jobId })

    while (true) {
      const payload = await this.request(
        `/api/semantic/index/refresh/jobs/${encodeURIComponent(jobId)}`,
        {},
        'Read semantic index refresh',
      )
      if (!isRecord(payload)) throw new Error('Semantic index job returned an invalid status.')
      const status = stringValue(payload.status).toLowerCase()
      const progress = isRecord(payload.progress) ? payload.progress : {}
      const detail = stringValue(progress.message) || `Semantic index refresh ${status || 'running'}.`
      const percent = clampPercent(progress.percent)
      if (status === 'failed') {
        const interrupted = interruptedJobDetail(payload)
        if (interrupted) {
          this.patchOperation({ status: 'interrupted', detail: interrupted, progress: null })
          return
        }
        throw new Error(errorText(payload, 'Semantic index refresh failed.'))
      }
      if (status === 'cancelled') {
        this.patchOperation({ status: 'cancelled', detail, progress: percent })
        return
      }
      if (status === 'succeeded') {
        this.patchOperation({ status: 'succeeded', detail, progress: 100 })
        return
      }
      this.patchOperation({ status: status === 'queued' ? 'queued' : 'running', detail, progress: percent })
      await this.sleep(this.pollIntervalMs)
    }
  }

  private async prepareDocling(): Promise<void> {
    this.setOperation({
      id: 'prepare-docling',
      label: 'Set up Docling',
      status: 'running',
      detail: 'Starting…',
      progress: null,
    })
    // The node answers at once and works in the background; its status says
    // "preparing" with the current step until set-up ends.
    let status = await this.request('/api/artifacts/ingestion/docling/prepare', { method: 'POST' }, 'Set up Docling')
    // One failed read is not a failed set-up: the node keeps working. Give up
    // only after several in a row.
    let failedReads = 0
    while (isRecord(status) && status.status === 'preparing') {
      this.doclingStatus = status
      this.patchOperation({ status: 'running', detail: `${stringValue(status.reason) || 'Working'}…`, progress: null })
      await this.sleep(this.pollIntervalMs)
      try {
        status = await this.request('/api/artifacts/ingestion/docling/status', {}, 'Read Docling set-up')
        failedReads = 0
      } catch (error) {
        failedReads += 1
        if (failedReads >= 5) throw error
      }
    }
    this.doclingStatus = isRecord(status) ? status : this.doclingStatus
    if (this.doclingStatus?.available === true) {
      this.patchOperation({ status: 'succeeded', detail: 'Docling is ready.', progress: 100 })
      return
    }
    throw new Error(stringValue(this.doclingStatus?.reason) || 'Docling set-up did not finish.')
  }

  /** What the Docling row says before set-up: the reason it is not ready, and
   * what set-up will download. */
  private doclingSetupDetail(): string {
    const reason = (stringValue(this.doclingStatus?.reason) || 'The accurate PDF parser is not set up').replace(/\.+$/, '')
    const downloads = (this.doclingStatus?.setupDownloads ?? []).filter(item => typeof item === 'string' && item)
    if (!downloads.length) return reason
    return `${reason}. Set-up downloads: ${downloads.join('; ')}. It can take several minutes.`
  }

  async job(jobId: string): Promise<void> {
    this.errors.delete('operation')
    if (jobId === 'refresh-local-ai') {
      await this.ensureLoaded(true)
      return
    }
    try {
      if (jobId === 'prepare-semantic-model') await this.prepareSemanticModel()
      else if (jobId === 'refresh-semantic-index') await this.refreshSemanticIndex()
      else if (jobId === 'prepare-docling') await this.prepareDocling()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.errors.set('operation', message)
      if (this.operation?.id === jobId) this.patchOperation({ status: 'failed', detail: message, progress: null })
    }
    await this.ensureLoaded(true)
  }

  private operationJob(id: string, fallback: MnSettingsJob): MnSettingsJob {
    if (this.operation?.id !== id) return fallback
    return {
      id,
      label: this.operation.label,
      status: this.operation.status,
      detail: this.operation.detail,
      progress: this.operation.progress,
      actionLabel: this.operation.status === 'queued' || this.operation.status === 'running'
        ? (id === 'refresh-semantic-index' ? 'Cancel' : null)
        : fallback.actionLabel,
      disabled: (this.operation.status === 'queued' || this.operation.status === 'running')
        && id !== 'refresh-semantic-index',
    }
  }

  decorateSection(base: MnSettingsSection): MnSettingsSection {
    const model = this.selectedModel()
    const modelState = modelReadiness(this.modelStatus)
    const indexState = indexReadiness(this.indexStatus)
    const effectivePdfId = stringValue(this.pdfStatus?.effectiveEngineId)
    const effectivePdf = this.pdfStatus?.engines?.find(engine => stringValue(engine.engineId) === effectivePdfId)
    const availableApproaches = this.approaches.filter(approach => approach.selectable !== false && approach.status === 'available')
    const busy = this.loading || this.operation?.status === 'running'

    // Search by meaning: what it is, the models to choose from, the set-up steps.
    const metrics: Array<NonNullable<MnSettingsSection['metrics']>[number]> = []
    const selects: Array<NonNullable<MnSettingsSection['selects']>[number]> = []
    const jobs: MnSettingsJob[] = []
    if (this.modelStatus) {
      metrics.push({
        id: 'semantic-model-status',
        label: 'Model in use',
        value: stringValue(model?.displayName ?? this.modelStatus.displayName ?? model?.modelId ?? this.modelStatus.modelId) || 'Unknown',
        detail: modelState.label,
        tone: modelState.tone,
        group: SEARCH_GROUP,
      })
    }
    if (this.indexStatus) {
      metrics.push({
        id: 'semantic-index-status',
        label: 'Search index',
        value: formatCount(this.indexStatus.blockCount, 'block'),
        detail: `${indexState.label} · ${formatCount(this.indexStatus.documentCount, 'document')}${finiteNumber(this.indexStatus.staleDocumentCount) ? ` · ${formatCount(this.indexStatus.staleDocumentCount, 'stale document')}` : ''}`,
        tone: indexState.tone,
        group: SEARCH_GROUP,
      })
    }
    if (this.models.length && model) {
      selects.push({
        id: 'semanticModel',
        label: 'Embedding model',
        description: 'The model that makes embeddings on this computer.',
        value: stringValue(model.modelId),
        options: this.models
          .map(candidate => ({
            value: stringValue(candidate.modelId),
            label: `${stringValue(candidate.displayName) || stringValue(candidate.modelId)}${candidate.recommended ? ' · recommended' : ''}`,
          }))
          .filter(option => option.value),
        disabled: busy,
        group: SEARCH_GROUP,
      })
      selects.push({
        id: 'semanticBatchSize',
        label: 'Batch size',
        description: 'How many blocks it embeds at once. Lower uses less memory; higher may finish sooner.',
        value: String(this.currentBatchSize()),
        options: MODEL_BATCH_SIZES.map(value => ({ value: String(value), label: String(value) })),
        disabled: busy,
        group: SEARCH_GROUP,
      })
    }
    if (this.modelStatus && this.models.length) {
      jobs.push({
        ...this.operationJob('prepare-semantic-model', {
          id: 'prepare-semantic-model',
          label: 'Prepare embedding model',
          status: this.modelStatus.prepared ? 'ready' : 'idle',
          detail: stringValue(this.modelStatus.reason) || `${modelState.label}. Downloads the model once and loads it; its files stay on this computer.`,
          actionLabel: this.modelStatus.prepared ? 'Load again' : 'Prepare',
          disabled: this.modelStatus.runtimeAvailable === false || this.loading,
        }),
        group: SEARCH_GROUP,
      })
    }
    if (this.indexStatus) {
      jobs.push({
        ...this.operationJob('refresh-semantic-index', {
          id: 'refresh-semantic-index',
          label: 'Rebuild graph semantic/vector index',
          status: this.indexStatus.indexedAt ? (finiteNumber(this.indexStatus.staleDocumentCount) ? 'idle' : 'ready') : 'idle',
          detail: stringValue(this.indexStatus.reason)
            || 'Saves recent edits, then makes embeddings for this graph’s blocks with the chosen model, so search by meaning can find them. Run it after you change the model, or when the index shows stale documents.',
          actionLabel: 'Rebuild',
          disabled: this.loading || this.modelStatus?.runtimeAvailable === false,
        }),
        group: SEARCH_GROUP,
      })
    }

    // PDF reading: the reader in use, the choice, Docling's set-up.
    if (this.pdfStatus) {
      metrics.push({
        id: 'pdf-pipeline-status',
        label: 'Reader in use',
        value: stringValue(effectivePdf?.label) || effectivePdfId || 'Unknown',
        detail: stringValue(this.pdfStatus.effectiveReason) || stringValue(this.pdfStatus.platform),
        tone: effectivePdf?.available === false ? 'warning' : 'neutral',
        group: PDF_GROUP,
      })
    }
    if (this.approaches.length) {
      metrics.push({
        id: 'ingestion-approaches',
        label: 'Importers',
        value: `${availableApproaches.length} available`,
        detail: availableApproaches.map(approach => stringValue(approach.label)).filter(Boolean).join(', '),
        group: PDF_GROUP,
      })
    }
    const implementedEngineIds = new Set(
      (this.pdfStatus?.engines ?? [])
        .filter(engine => engine.implemented !== false)
        .map(engine => stringValue(engine.engineId)),
    )
    const pdfOptions = (this.pdfStatus?.preferenceOptions ?? [])
      .filter(option => option.engineId === 'auto' || implementedEngineIds.has(stringValue(option.engineId)))
      .map(option => ({ value: stringValue(option.engineId), label: stringValue(option.label) || stringValue(option.engineId) }))
      .filter(option => option.value)
    if (pdfOptions.length) {
      selects.push({
        id: 'pdfEngine',
        label: 'Preferred reader',
        description: 'Auto uses the best reader that is set up. If the one you choose isn’t set up, Mycl says so and uses another.',
        value: stringValue(this.pdfStatus?.preferredEngineId) || 'auto',
        options: pdfOptions,
        disabled: this.loading,
        group: PDF_GROUP,
      })
    }
    if (this.doclingStatus?.supported !== false) {
      const available = this.doclingStatus?.available === true
      // Set-up started before this page was opened is still running there.
      const preparing = this.doclingStatus?.status === 'preparing'
      jobs.push({
        ...this.operationJob('prepare-docling', {
          id: 'prepare-docling',
          label: 'Set up Docling',
          status: available ? 'ready' : preparing ? 'running' : 'idle',
          detail: available
            ? 'Docling is ready.'
            : preparing
              ? `${stringValue(this.doclingStatus?.reason) || 'Working'}…`
              : this.doclingSetupDetail(),
          actionLabel: available ? 'Check again' : preparing ? 'Follow' : 'Set up',
          disabled: this.loading,
        }),
        group: PDF_GROUP,
      })
    }

    // Beside the section title: re-read every status above.
    jobs.push({
      id: 'refresh-local-ai',
      label: 'Refresh status',
      status: this.loading ? 'running' : 'idle',
      detail: this.loading ? 'Reading the model, the index and the PDF readers…' : 'Read the model, the index and the PDF readers again.',
      actionLabel: this.loading ? 'Refreshing…' : 'Refresh status',
      disabled: this.loading,
      placement: 'header',
    })

    const modelLines = this.models.map(candidate => modelChoiceLine(candidate)).filter((line): line is string => Boolean(line))
    const groups = [
      {
        id: SEARCH_GROUP,
        title: 'Search by meaning',
        explainer: [
          'Mycl can find blocks by what they mean, not only by the words in them. To do that it turns each block into an embedding: a list of numbers that puts similar ideas near each other. A model on this computer makes them, and nothing is sent anywhere.',
          ...(modelLines.length ? ['The models:', { list: modelLines }] : []),
          'To set it up: choose a model, prepare it (a one-time download), then rebuild the index once. After that the index keeps itself up to date: about ten minutes after you stop editing, Mycl embeds what changed. Changing the model means rebuilding, because each model’s numbers only make sense to that model.',
        ],
      },
      {
        id: PDF_GROUP,
        title: 'Reading PDFs',
        explainer: [
          'When you import a PDF, Mycl turns its pages into text you can read, search and wire. Fast Text reads the text already in the file and needs nothing installed. Docling also reads scanned pages and complex layouts more accurately; it needs a one-time set-up that downloads its parts.',
        ],
      },
    ]

    const notes = [...(base.notes ?? [])]
    for (const key of LOAD_KEYS) {
      const message = this.errors.get(key)
      if (message) notes.push(`${key === 'pdf' ? 'PDF pipeline' : key === 'index' ? 'Semantic index' : key === 'model' || key === 'models' ? 'Embedding runtime' : key === 'approaches' ? 'Importer catalog' : 'Docling runtime'}: ${message}`)
    }
    const operationError = this.errors.get('operation')
    if (operationError) notes.push(`Last operation: ${operationError}`)
    if (this.doclingStatus?.supported === false && stringValue(this.doclingStatus.reason)) {
      notes.push(`Docling is unavailable on this platform: ${stringValue(this.doclingStatus.reason)}`)
    }

    return {
      ...base,
      wide: false,
      metrics,
      selects,
      jobs,
      notes,
      groups,
    }
  }
}
