/**
 * A scripted VaultImportAdapter for tests and for the dev server's
 * `?vault-mock` preview. It never touches a real vault or graph. The app
 * itself uses NativeVaultImportAdapter.
 */

import type { VaultCancelResult, VaultCaptureEntry, VaultCaptureStatus, VaultSelection, VaultSourceKind } from './vault-capture.js'
import type { VaultCaptureApi, VaultImportAdapter, VaultJob, VaultJobPhase, VaultRecentJobs, VaultReview } from './vault-import.js'

export interface MockVaultScript {
  readonly entries?: readonly VaultCaptureEntry[]
  /** Status reads that answer `capturing` before the capture is ready. */
  readonly captureReads?: number
  readonly review?: Partial<VaultReview>
  /** Thrown by review, to show a refused review. */
  readonly reviewError?: Error
  /** Thrown by confirm. */
  readonly confirmError?: Error
  /** What successive job status reads return. The last repeats. */
  readonly phases?: readonly VaultJobPhase[]
  /** Status reads that throw before answering, to show a lost check. */
  readonly statusErrors?: number
  /**
   * What Stop does: abandon the job; throw (the node refused outright); or
   * answer with the job's unchanged phase and an explanation, as the node
   * does once publication has begun.
   */
  readonly cancel?: 'abandoned' | 'refused' | 'unchanged' | 'pending'
  /** The phase an `unchanged` cancel reports. Defaults to publishing. */
  readonly cancelPhase?: VaultJobPhase
  /** Job reports say no worker is running: an interrupted job. */
  readonly interrupted?: boolean
  /** The node's words on uncertain reports. */
  readonly uncertainError?: string
  /** A published job whose graph was deleted or replaced since. */
  readonly destinationGone?: boolean
  /** The capture status names this already-committed job. */
  readonly committedJobId?: string
  /** What list_vault_import_jobs returns. */
  readonly recent?: readonly VaultJob[]
  /** The graph id job reports name, when it should differ from the review's. */
  readonly jobGraphId?: string
}

export interface MockVaultCall {
  readonly step: string
  readonly args: Record<string, unknown>
}

export const MOCK_VAULT_ENTRIES: readonly VaultCaptureEntry[] = [
  { index: 0, path: 'Daily', kind: 'directory', bytes: 0, sha256: '' },
  { index: 1, path: 'Daily/2026-11-18.md', kind: 'note', bytes: 1840, sha256: 'a' },
  { index: 2, path: 'Reading/As We May Think.md', kind: 'note', bytes: 5210, sha256: 'b' },
  { index: 3, path: 'Reading', kind: 'directory', bytes: 0, sha256: '' },
  { index: 4, path: 'Projects/Garden.md', kind: 'note', bytes: 3302, sha256: 'c' },
  { index: 5, path: 'attachments/memex.png', kind: 'attachment', bytes: 204800, sha256: 'd' },
]

export const MOCK_VAULT_REVIEW: VaultReview = {
  reviewId: 'review-1',
  digest: 'digest-1',
  destinationGraphId: 'vault-import-1',
  title: 'My vault',
  counts: { sourceNotes: 3, generatedTagHubs: 2, attachments: 1, folders: 3, wires: 9 },
  warnings: [
    { path: 'Projects/Garden.md', message: 'A link to "Garden#Old plans" names a heading the note no longer has, so it stays as written.' },
    { path: 'Daily/2026-11-18.md', message: 'A block with inline HTML was kept as written.' },
  ],
  omittedWarnings: 0,
  supportedRefs: 7,
  unmappedRefs: 1,
  tagReferences: 5,
  originalsPreserved: true,
  expiresAt: null,
}

export class MockVaultImportAdapter implements VaultImportAdapter {
  readonly calls: MockVaultCall[] = []
  private captureReads = 0
  private statusReads = 0
  private statusErrors = 0
  private cancelled = false
  private cancelPending = false
  private reviews = 0
  private reviewedTitle = MOCK_VAULT_REVIEW.title
  readonly capture: VaultCaptureApi

  constructor(private readonly script: MockVaultScript = {}) {
    const self = this
    this.capture = {
      async select(graphId: string, kind: VaultSourceKind): Promise<VaultSelection> {
        self.calls.push({ step: 'select', args: { graphId, kind } })
        return { state: 'capturing', scanId: 'scan-1', graphId }
      },
      async status(graphId: string, scanId: string, offset = 0): Promise<VaultCaptureStatus> {
        self.calls.push({ step: 'capture-status', args: { graphId, scanId, offset } })
        if (self.captureReads++ < (self.script.captureReads ?? 1)) {
          return { state: 'capturing', expiresAt: null, fingerprint: null, error: null, totalEntries: 0, entries: [], nextOffset: null, complete: false, jobId: null }
        }
        const entries = self.script.entries ?? MOCK_VAULT_ENTRIES
        return { state: 'ready', expiresAt: null, fingerprint: 'f', error: null, totalEntries: entries.length, entries: [...entries], nextOffset: null, complete: true, jobId: self.script.committedJobId ?? null }
      },
      async cancel(graphId: string, scanId: string): Promise<VaultCancelResult> {
        self.calls.push({ step: 'capture-cancel', args: { graphId, scanId } })
        return { state: 'cancelled', cancelled: true }
      },
    }
  }

  private job(phase: VaultJobPhase): VaultJob {
    const review = { ...MOCK_VAULT_REVIEW, ...this.script.review }
    const destinationGraphId = this.script.jobGraphId ?? review.destinationGraphId
    const error = phase === 'uncertain'
      ? this.script.uncertainError ?? 'The publication step did not report back. Mycl is reconciling it with what was written.'
      : null
    const gone = phase === 'published' && !!this.script.destinationGone
    return {
      jobId: 'job-1',
      phase,
      destinationGraphId,
      title: this.reviewedTitle,
      error: gone ? 'This import was published, but its graph is no longer available or has been replaced.' : error,
      workerActive: !this.script.interrupted,
      cancelRequested: this.cancelPending && phase !== 'abandoned' && phase !== 'published',
      destinationAvailable: phase === 'published' && !gone,
    }
  }

  async review(graphId: string, scanId: string, title: string): Promise<VaultReview> {
    this.calls.push({ step: 'review', args: { graphId, scanId, title } })
    if (this.script.reviewError) throw this.script.reviewError
    this.reviewedTitle = title
    // Each review is a new token, as on the node: review-1, review-2, …
    const reviewId = `review-${++this.reviews}`
    return { ...MOCK_VAULT_REVIEW, title, reviewId, ...this.script.review }
  }

  async confirm(reviewId: string, digest: string): Promise<VaultJob> {
    this.calls.push({ step: 'confirm', args: { reviewId, digest } })
    if (this.script.confirmError) throw this.script.confirmError
    return this.job('accepted')
  }

  async jobStatus(jobId: string): Promise<VaultJob> {
    this.calls.push({ step: 'job-status', args: { jobId } })
    if (this.statusErrors++ < (this.script.statusErrors ?? 0)) throw new Error('The node did not answer.')
    if (this.cancelled) return this.job('abandoned')
    if (this.cancelPending) {
      // A requested stop settles on the next read.
      this.cancelled = true
      this.cancelPending = false
      return this.job('abandoned')
    }
    const phases = this.script.phases ?? ['building', 'publishing', 'published']
    const phase = phases[Math.min(this.statusReads++, phases.length - 1)]
    return this.job(phase)
  }

  async cancelJob(jobId: string): Promise<VaultJob> {
    this.calls.push({ step: 'job-cancel', args: { jobId } })
    if (this.script.cancel === 'refused') throw new Error('publication may have happened; cannot report cancellation')
    if (this.script.cancel === 'pending') {
      this.cancelPending = true
      return this.job('building')
    }
    if (this.script.cancel === 'unchanged') {
      return {
        ...this.job(this.script.cancelPhase ?? 'publishing'),
        error: 'Publication has already begun, so this import can no longer be stopped.',
      }
    }
    this.cancelled = true
    return this.job('abandoned')
  }

  async releaseReview(reviewId: string): Promise<void> {
    this.calls.push({ step: 'release', args: { reviewId } })
  }

  async recentJobs(limit = 20): Promise<VaultRecentJobs> {
    this.calls.push({ step: 'recent', args: { limit } })
    return { jobs: [...(this.script.recent ?? [])], complete: true }
  }
}
