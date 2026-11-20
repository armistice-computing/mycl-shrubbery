/**
 * Door 1's whole flow, behind one typed adapter: choose a vault, capture it,
 * review what an import would make, confirm, then follow the job to its end.
 *
 * Real today: choosing and capturing (select_vault_source,
 * get_vault_capture_status, cancel_vault_capture; garden
 * docs/door1-native-capture.md). Not registered yet: review, confirm, job
 * status and job cancel. Epsilon owns those commands. Their names and the
 * field names below were agreed by Epsilon and Delta (dispatch msg-a128c20b).
 * Until the node registers them, the native adapter reports each one as
 * unavailable instead of falling back to the legacy import.vault route.
 *
 * Contract rules the UI depends on (Epsilon, dispatch msg-68da562a and
 * msg-a128c20b):
 * - Every import makes a NEW graph. The source graph is permission context
 *   only, and the vault folder is never modified.
 * - Confirm sends only the review id and its digest. Never the plan, the
 *   content or a path.
 * - A ready capture is not an import, and a complete page of entries is not
 *   a complete job.
 * - Job phases come from garden src-tauri/src/vault_job.rs `State`. Building
 *   is a durable phase, not proof that a worker runs. Publishing and
 *   uncertain reconcile; they never retry or make another graph.
 * - Cancel is allowed before publication only. Nothing is rolled back after.
 *   A cancel during publishing or uncertain returns the unchanged phase and
 *   an explanation, never a false success.
 * - A durable `accepted` or `building` job with `workerActive` false is
 *   interrupted: nothing is running it, so the UI must not show progress.
 * - Errors arrive as safe `{code, message}`. The node's message is what the
 *   person reads; the static sentences are only for an unstructured failure
 *   or a structured one with no message (see VaultImportError).
 * - A job is `published` history. Only `destinationAvailable` says its graph
 *   still exists; a deleted or replaced graph is never recreated.
 * - release_vault_review frees a preview before confirm. It never cancels
 *   admitted work, so nothing calls it after confirm. A second review
 *   replaces the first token: only the newest reviewId is kept.
 * - list_vault_import_jobs lists recent jobs (default 20, at most 50) so a
 *   closed dialog can find a running import again.
 */

import {
  VaultCaptureClient,
  type VaultCancelResult,
  type VaultCaptureStatus,
  type VaultInvoke,
  type VaultSelection,
  type VaultSourceKind,
} from './vault-capture.js'

/** Agreed by Epsilon and Delta (dispatch msg-a128c20b). */
export const VAULT_IMPORT_COMMANDS = {
  review: 'review_vault_import',
  confirm: 'commit_vault_import',
  status: 'get_vault_import_status',
  cancel: 'cancel_vault_import',
  release: 'release_vault_review',
  recent: 'list_vault_import_jobs',
} as const

/** list_vault_import_jobs bounds (dispatch msg-4bf65b57). */
export const VAULT_RECENT_DEFAULT = 20
export const VAULT_RECENT_MAX = 50

export interface VaultReviewCounts {
  readonly sourceNotes: number
  readonly generatedTagHubs: number
  readonly attachments: number
  /** Folders in the vault. The generated import folder and Tags folder are not counted. */
  readonly folders: number
  /** Wires the new graph will hold: from links, tags and explicit exports. Not reference occurrences. */
  readonly wires: number
}

export interface VaultReviewWarning {
  /** Relative to the vault root, when the warning is about one file. Text only. */
  readonly path: string | null
  readonly message: string
}

export interface VaultReview {
  readonly reviewId: string
  readonly digest: string
  /** The id the new graph will have. The UI goes there only after `published`. */
  readonly destinationGraphId: string
  readonly title: string
  readonly counts: VaultReviewCounts
  /** Bounded by the node. `omittedWarnings` says how many more there were. */
  readonly warnings: readonly VaultReviewWarning[]
  readonly omittedWarnings: number
  /**
   * References the import resolved, counted per occurrence. Some resolve as a
   * document-level wire rather than an inline chip, so the UI says
   * "resolved", never "clickable".
   */
  readonly supportedRefs: number
  /**
   * References kept as written: missing or ambiguous targets, fragments,
   * embeds and old endpoints. Counted after preparation, per occurrence.
   */
  readonly unmappedRefs: number
  /** How many tag uses the tag pages gather, when the node reports it. */
  readonly tagReferences: number | null
  /** Each document keeps its original file, byte for byte. */
  readonly originalsPreserved: boolean
  /**
   * When this review stops being confirmable, in ms since the epoch. Never
   * later than the capture's consent or the registry's expiry.
   */
  readonly expiresAt: number | null
}

/** True once the review can no longer be confirmed. */
export function vaultReviewExpired(review: VaultReview, now: number): boolean {
  return review.expiresAt !== null && now >= review.expiresAt
}

export type VaultJobPhase = 'accepted' | 'building' | 'publishing' | 'uncertain' | 'published' | 'abandoned'

export const VAULT_JOB_PHASES: readonly VaultJobPhase[] = [
  'accepted', 'building', 'publishing', 'uncertain', 'published', 'abandoned',
]

export interface VaultJob {
  readonly jobId: string
  readonly phase: VaultJobPhase
  readonly destinationGraphId: string
  readonly title: string
  /**
   * The node's words. For uncertain: why it needs reconciling. For a refused
   * cancel: why the job did not stop.
   */
  readonly error: string | null
  /** False when nothing is running the job right now. */
  readonly workerActive: boolean
  /** A Stop was asked for and the job has not settled yet. */
  readonly cancelRequested: boolean
  /**
   * For a published job: the new graph still exists as the import made it.
   * False when it was deleted or replaced; `error` then says so.
   */
  readonly destinationAvailable: boolean
}

export interface VaultRecentJobs {
  readonly jobs: readonly VaultJob[]
  /** Every recent job fit in this page. */
  readonly complete: boolean
}

/** Accepted or building with no worker: interrupted, not in progress. */
export function vaultJobInterrupted(job: VaultJob): boolean {
  return (job.phase === 'accepted' || job.phase === 'building') && !job.workerActive
}

/** A job phase where Stop can still mean "nothing was made". */
export function vaultJobCancellable(phase: VaultJobPhase): boolean {
  return phase === 'accepted' || phase === 'building'
}

export function vaultJobTerminal(phase: VaultJobPhase): boolean {
  return phase === 'published' || phase === 'abandoned'
}

/** The capture half, in the shape VaultPreviewController reads. */
export interface VaultCaptureApi {
  select(graphId: string, kind: VaultSourceKind): Promise<VaultSelection>
  status(graphId: string, scanId: string, offset?: number, limit?: number): Promise<VaultCaptureStatus>
  cancel(graphId: string, scanId: string): Promise<VaultCancelResult>
}

export interface VaultImportAdapter {
  readonly capture: VaultCaptureApi
  /** Prepares an import of a ready capture into a new graph called `title`. Writes nothing. */
  review(graphId: string, scanId: string, title: string): Promise<VaultReview>
  /** Starts the job. Sends only the review id and digest. */
  confirm(reviewId: string, digest: string): Promise<VaultJob>
  jobStatus(jobId: string): Promise<VaultJob>
  /** Asks to stop. The returned job says what actually happened. */
  cancelJob(jobId: string): Promise<VaultJob>
  /** Frees a preview that was never confirmed. Never call it after confirm. */
  releaseReview(reviewId: string): Promise<void>
  /** Recent import jobs, newest first. */
  recentJobs(limit?: number): Promise<VaultRecentJobs>
}

/** Thrown when this build's node has no command for a step yet. */
export class VaultImportUnavailableError extends Error {
  constructor(step: string) {
    super(`This build can't ${step} yet.`)
    this.name = 'VaultImportUnavailableError'
  }
}

/** The structured error codes the node enforces (dispatch msg-a128c20b, msg-4bf65b57). */
export type VaultImportErrorCode =
  | 'expired' | 'revoked' | 'stale_source' | 'budget' | 'busy' | 'unsupported' | 'unavailable'

/**
 * Fallback sentences, used only when a refusal has a code but no message.
 * A structured refusal's own message always wins.
 */
export const VAULT_IMPORT_ERROR_TEXT: Record<VaultImportErrorCode, string> = {
  expired: 'This review has expired. Scan the vault again to import it.',
  revoked: 'Mycl no longer has permission to read this vault. Choose it again.',
  stale_source: 'The vault changed after it was scanned. Scan it again so the import matches what is there.',
  budget: 'This vault is bigger than one import can take. Try a smaller folder.',
  busy: 'Mycl is doing another large job. Try again in a moment.',
  unsupported: 'Something in this vault is not something Mycl can import yet.',
  unavailable: "This build can't import vaults yet.",
}

const ERROR_CODES = Object.keys(VAULT_IMPORT_ERROR_TEXT) as VaultImportErrorCode[]

function errorCodeOf(value: unknown): VaultImportErrorCode | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (code === 'stale') return 'stale_source'
  return ERROR_CODES.includes(code as VaultImportErrorCode) ? code as VaultImportErrorCode : null
}

/**
 * A refusal the node gave a code. `message` is the node's own safe message,
 * or the fallback sentence for the code when the node sent none.
 */
export class VaultImportError extends Error {
  constructor(readonly code: VaultImportErrorCode, readonly detail: string) {
    super(detail.trim() || VAULT_IMPORT_ERROR_TEXT[code])
    this.name = 'VaultImportError'
  }
}

/**
 * Reads a structured refusal from what invoke rejected with: an object with
 * `code`, or a JSON string of one. Anything else is not structured.
 */
export function vaultImportErrorFrom(error: unknown): VaultImportError | null {
  let value: unknown = error
  if (error instanceof Error) value = error.message
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return null
    try { value = JSON.parse(trimmed) } catch { return null }
  }
  const raw = record(value)
  const code = errorCodeOf(raw.code)
  if (!code) return null
  return new VaultImportError(code, text(raw.message))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/** The most warnings the dialog lists, whatever the node sends. */
export const VAULT_WARNING_LIMIT = 50

export function vaultReviewFrom(value: unknown): VaultReview {
  const raw = record(value)
  const counts = record(raw.counts)
  const reviewId = text(raw.reviewId)
  const digest = text(raw.digest)
  const destinationGraphId = text(raw.destinationGraphId)
  if (!reviewId || !digest || !destinationGraphId) throw new Error('The import review came back incomplete.')
  const rawWarnings = Array.isArray(raw.warnings) ? raw.warnings : []
  const warnings = rawWarnings
    .map(item => {
      const w = record(item)
      const message = text(w.message)
      return message ? { path: text(w.path) || null, message } : null
    })
    .filter((w): w is VaultReviewWarning => w !== null)
  const kept = warnings.slice(0, VAULT_WARNING_LIMIT)
  return {
    reviewId,
    digest,
    destinationGraphId,
    title: text(raw.title),
    counts: {
      sourceNotes: count(counts.sourceNotes),
      generatedTagHubs: count(counts.generatedTagHubs),
      attachments: count(counts.attachments),
      folders: count(counts.folders),
      wires: count(counts.wires),
    },
    warnings: kept,
    omittedWarnings: count(raw.omittedWarnings) + (rawWarnings.length - kept.length),
    supportedRefs: count(raw.supportedRefs),
    unmappedRefs: count(raw.unmappedRefs),
    tagReferences: typeof raw.tagReferences === 'number' ? count(raw.tagReferences) : null,
    originalsPreserved: raw.originalsPreserved === true,
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : null,
  }
}

export function vaultJobFrom(value: unknown): VaultJob {
  const raw = record(value)
  const jobId = text(raw.jobId)
  if (!jobId) throw new Error('The import job came back without an id.')
  const phase = VAULT_JOB_PHASES.includes(raw.phase as VaultJobPhase)
    ? raw.phase as VaultJobPhase
    // An unknown phase is never read as success. Uncertain keeps the UI checking.
    : 'uncertain'
  return {
    jobId,
    phase,
    destinationGraphId: text(raw.destinationGraphId),
    title: text(raw.title),
    error: text(raw.error) || null,
    // Absent means no proof a worker runs, so the UI never claims progress.
    workerActive: raw.workerActive === true,
    cancelRequested: raw.cancelRequested === true,
    // Absent means no proof the graph exists, so the UI never offers to open it.
    destinationAvailable: raw.destinationAvailable === true,
  }
}

export function vaultRecentJobsFrom(value: unknown): VaultRecentJobs {
  const raw = record(value)
  const jobs: VaultJob[] = []
  for (const item of Array.isArray(raw.jobs) ? raw.jobs : []) {
    try { jobs.push(vaultJobFrom(item)) } catch { /* a row without an id is skipped */ }
  }
  return { jobs, complete: raw.complete === true }
}

/** A published job whose graph is still there, as the import made it. */
export function vaultJobOpenable(job: VaultJob, expectedGraphId: string): boolean {
  return job.phase === 'published' && job.destinationAvailable
    && job.destinationGraphId !== '' && job.destinationGraphId === expectedGraphId
}

function unregistered(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not found|unknown command|not allowed|isn't registered|is not registered/i.test(message)
}

/**
 * The adapter the app uses. Capture is real. The four later steps call the
 * proposed commands and report "unavailable" while the node lacks them.
 */
export class NativeVaultImportAdapter implements VaultImportAdapter {
  readonly capture: VaultCaptureApi

  constructor(private readonly invoke: VaultInvoke) {
    this.capture = new VaultCaptureClient(invoke)
  }

  private async call(step: string, command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.invoke(command, args)
    } catch (error) {
      const structured = vaultImportErrorFrom(error)
      if (structured) throw structured
      if (unregistered(error)) throw new VaultImportUnavailableError(step)
      throw error
    }
  }

  async review(graphId: string, scanId: string, title: string): Promise<VaultReview> {
    return vaultReviewFrom(await this.call('prepare an import', VAULT_IMPORT_COMMANDS.review, { graphId, scanId, title }))
  }

  async confirm(reviewId: string, digest: string): Promise<VaultJob> {
    return vaultJobFrom(await this.call('start an import', VAULT_IMPORT_COMMANDS.confirm, { reviewId, digest }))
  }

  async jobStatus(jobId: string): Promise<VaultJob> {
    return vaultJobFrom(await this.call('check on an import', VAULT_IMPORT_COMMANDS.status, { jobId }))
  }

  async cancelJob(jobId: string): Promise<VaultJob> {
    return vaultJobFrom(await this.call('stop an import', VAULT_IMPORT_COMMANDS.cancel, { jobId }))
  }

  async releaseReview(reviewId: string): Promise<void> {
    await this.call('release a preview', VAULT_IMPORT_COMMANDS.release, { reviewId })
  }

  async recentJobs(limit = VAULT_RECENT_DEFAULT): Promise<VaultRecentJobs> {
    const bounded = Math.min(VAULT_RECENT_MAX, Math.max(1, Math.floor(limit)))
    return vaultRecentJobsFrom(await this.call('list recent imports', VAULT_IMPORT_COMMANDS.recent, { limit: bounded }))
  }
}
