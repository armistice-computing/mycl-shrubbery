/**
 * Drives the whole Door 1 dialog: capture (through VaultPreviewController),
 * then review, confirm, and the job to its end.
 *
 * Rules (see vault-import.ts):
 * - The import always makes a new graph. The person names it before review.
 * - Confirm sends only the review id and digest.
 * - Stop is offered while the job is accepted or building. After that the
 *   node may already have published, so the dialog never says "stopped"
 *   unless the node reports `abandoned`. A cancel answered with any other
 *   phase shows the node's explanation, never a success.
 * - An accepted or building job with no worker is interrupted. It is shown as
 *   not running, and nothing here offers to start it again.
 * - A review past its `expiresAt` is never sent: the person scans again.
 * - An unconfirmed preview is released when the dialog closes or another
 *   vault is chosen. Nothing is released once confirm has been sent, since
 *   release never cancels admitted work. Only the newest review id is kept.
 * - The new graph opens only when the job is published, names the expected
 *   graph and reports `destinationAvailable`. A missing graph is never made again.
 * - Recent imports come from list_vault_import_jobs, and a capture whose
 *   status names a committed `jobId` resumes that job instead of importing again.
 * - Publishing and uncertain are only ever re-checked. Nothing here retries
 *   a confirm or starts a second job.
 * - Every job report must name the bound job and graph (accept). A confirmed
 *   job binds to the review's graph; a resumed job binds to the requested id
 *   and, from a recent row, that row's graph. Anything else is not trusted.
 * - Every await is fenced by the generation it started in, on success and
 *   failure: a late reply never writes over a closed or newer import.
 * - Any remote confirm error is ambiguous: a job may exist now or later. The
 *   capture's committed job id or a recent job for the reviewed graph is
 *   followed when it appears; nothing confirms again or rescans on its own.
 */

import { VaultPreviewController, type VaultPreviewView } from './vault-preview-controller.js'
import type { VaultSourceKind } from './vault-capture.js'
import {
  VAULT_IMPORT_ERROR_TEXT,
  VaultImportError,
  vaultJobCancellable,
  vaultJobInterrupted,
  vaultJobOpenable,
  vaultJobTerminal,
  vaultReviewExpired,
  type VaultImportAdapter,
  type VaultJob,
  type VaultReview,
} from './vault-import.js'

export type VaultImportStep =
  | 'capture'
  | 'reviewing'
  | 'review'
  | 'review-failed'
  | 'starting'
  | 'job'
  | 'published'
  | 'abandoned'
  | 'recent'

export interface VaultImportView {
  /** Whether the dialog shows: a capture is open, or a job or the recent list is. */
  readonly open: boolean
  readonly capture: VaultPreviewView
  readonly step: VaultImportStep
  /** The new graph's name, as the person typed it. */
  readonly title: string
  readonly review: VaultReview | null
  readonly job: VaultJob | null
  /** True when this build's node can review and import (not only capture). */
  readonly importAvailable: boolean
  readonly stopping: boolean
  /** Set when Stop came too late: the node may already have published. */
  readonly stopRefused: boolean
  /** Why the node did not stop the job, in its words, when it said. */
  readonly stopExplanation: string
  /** The last check on the job failed. The job itself is unchanged. */
  readonly checkFailed: boolean
  readonly errorText: string
  /** Recent import jobs, newest first. Null until listed. */
  readonly recent: readonly VaultJob[] | null
  /** The list holds every recent job. */
  readonly recentComplete: boolean
  readonly recentLoading: boolean
  /** The new graph is openable: published, the expected graph, and still there. */
  readonly canOpenGraph: boolean
  /**
   * The node can no longer use this scan (after a restart, a capture must be
   * chosen again in the native chooser). The dialog offers the chooser.
   */
  readonly needsReselect: boolean
  /** A confirm's reply was lost: a job may or may not exist. Mycl is finding out. */
  readonly confirmUnknown: boolean
}

export interface VaultImportControllerOptions {
  readonly adapter: VaultImportAdapter
  readonly render: (view: VaultImportView) => void
  /** Opens a graph. Called only for a verified, published import. */
  readonly openGraph: (graphId: string) => void
  /** False when the node can capture but cannot import yet. */
  readonly importAvailable?: boolean
  readonly pollMs?: number
  /** Slower checks while the outcome is uncertain. */
  readonly uncertainPollMs?: number
  readonly wait?: (ms: number) => Promise<void>
  /** The clock for review expiry, in ms since the epoch. */
  readonly now?: () => number
}

export const VAULT_TITLE_MAX = 120

/** How many times an ambiguous confirm is looked for on its own before only Check again does. */
export const VAULT_RECONCILE_TRIES = 60

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const EMPTY = {
  step: 'capture' as VaultImportStep,
  title: '',
  review: null,
  job: null,
  stopping: false,
  stopRefused: false,
  stopExplanation: '',
  checkFailed: false,
  errorText: '',
  recent: null,
  recentComplete: false,
  recentLoading: false,
  needsReselect: false,
  confirmUnknown: false,
}

type ControllerState = Omit<VaultImportView, 'capture' | 'importAvailable' | 'open' | 'canOpenGraph'>

export class VaultImportController {
  private captureView: VaultPreviewView
  private state: ControllerState = EMPTY
  private readonly preview: VaultPreviewController
  /** Bumped whenever the flow restarts, so an old poll stops itself. */
  private generation = 0
  private readonly pollMs: number
  private readonly uncertainPollMs: number
  private readonly wait: (ms: number) => Promise<void>
  private readonly now: () => number
  private lastGraphId = ''
  /** A published report named another graph. Nothing more is trusted from this job. */
  private mismatch = false
  /** The graph every report must name: the review's, a recent row's, or a resumed job's first. */
  private expectedGraphId = ''
  /** The job every report must name, once known. Frozen after the first report. */
  private expectedJobId: string | null = null
  /** The capture a confirm came from, to read its committed job if the reply is lost. */
  private confirmScan: { readonly graphId: string; readonly scanId: string } | null = null
  /** The generation whose follow loop is running, so a check never starts a second one. */
  private following: number | null = null
  /** The newest review that was never confirmed. Released on close or a new choice. */
  private liveReviewId: string | null = null
  /** The dialog shows a job or the recent list without an open capture. */
  private standalone = false
  /** The committed job a capture named, once resumed. */
  private resumedJobId: string | null = null

  constructor(private readonly options: VaultImportControllerOptions) {
    this.pollMs = options.pollMs ?? 1000
    this.uncertainPollMs = options.uncertainPollMs ?? 5000
    this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = options.now ?? (() => Date.now())
    this.preview = new VaultPreviewController({
      client: options.adapter.capture,
      wait: this.wait,
      pollMs: this.pollMs,
      render: view => {
        this.captureView = view
        this.emit()
        // A capture that was already imported resumes its job, never a second import.
        const committed = view.committedJobId
        if (committed && this.state.step === 'capture' && this.resumedJobId !== committed) {
          this.resumedJobId = committed
          void this.resume(committed)
        }
      },
    })
    this.captureView = this.preview.current
  }

  get current(): VaultImportView {
    const job = this.state.job
    return {
      ...this.state,
      open: this.captureView.open || this.standalone,
      capture: this.captureView,
      importAvailable: this.options.importAvailable ?? true,
      canOpenGraph: this.state.step === 'published' && !!job && !this.mismatch
        && job.jobId === this.expectedJobId
        && vaultJobOpenable(job, this.expectedGraphId),
    }
  }

  /** Frees a preview handle that will never be confirmed. Fire and forget. */
  private release(reviewId: string | null): void {
    if (reviewId) void this.options.adapter.releaseReview(reviewId).catch(() => {})
  }

  /** Frees the newest unconfirmed preview. Failing to free it harms nothing. */
  private releaseLiveReview(): void {
    const reviewId = this.liveReviewId
    this.liveReviewId = null
    this.release(reviewId)
  }

  private emit(): void {
    this.options.render(this.current)
  }

  private set(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  /** Forgets which job and graph the dialog is bound to. */
  private unbind(): void {
    this.mismatch = false
    this.expectedGraphId = ''
    this.expectedJobId = null
    this.confirmScan = null
  }

  async choose(graphId: string, kind: VaultSourceKind): Promise<void> {
    this.releaseLiveReview()
    this.generation++
    this.state = EMPTY
    this.unbind()
    this.standalone = false
    this.resumedJobId = null
    this.lastGraphId = graphId
    await this.preview.choose(graphId, kind)
  }

  /** Capture-phase intents pass straight through. */
  showMore(): Promise<void> { return this.preview.showMore() }
  stopCapture(): Promise<void> { return this.preview.stop() }

  async chooseAgain(): Promise<void> {
    const kind = this.captureView.sourceKind
    const graphId = this.lastGraphId
    this.close()
    if (graphId) await this.choose(graphId, kind)
  }

  setTitle(title: string): void {
    if (this.state.step !== 'capture') return
    this.set({ title: title.slice(0, VAULT_TITLE_MAX) })
  }

  /** Asks the node what an import of the ready capture would make. Writes nothing. */
  async startReview(): Promise<void> {
    const scan = this.preview.readyScan
    const title = this.state.title.trim()
    if (!scan || !title || this.state.step !== 'capture') return
    const generation = ++this.generation
    this.set({ step: 'reviewing', errorText: '' })
    try {
      const review = await this.options.adapter.review(scan.graphId, scan.scanId, title)
      if (generation !== this.generation) {
        // The dialog closed, went back or chose another vault while this was
        // prepared. Nobody will confirm this handle: free it now, not at its TTL.
        this.release(review.reviewId)
        return
      }
      // A new review replaces the old token on the node. Keep only the newest.
      this.liveReviewId = review.reviewId
      this.set({ step: 'review', review })
    } catch (error) {
      if (generation !== this.generation) return
      // A structured `unavailable` on review means the node no longer holds the
      // chosen source, as after a restart: the vault must be chosen again.
      const needsReselect = error instanceof VaultImportError && error.code === 'unavailable'
      this.set({ step: 'review-failed', errorText: messageOf(error), review: null, needsReselect })
    }
  }

  /** From the review (or a refused review) back to the capture, to rename or rethink. */
  back(): void {
    if (this.state.step !== 'review' && this.state.step !== 'review-failed') return
    this.generation++
    this.set({ step: 'capture', review: null, errorText: '', needsReselect: false })
  }

  async confirm(): Promise<void> {
    const review = this.state.review
    if (!review || this.state.step !== 'review') return
    if (vaultReviewExpired(review, this.now())) {
      // An expired review would be refused. Send nothing: scan again.
      this.generation++
      this.set({ step: 'review-failed', errorText: VAULT_IMPORT_ERROR_TEXT.expired, review: null })
      return
    }
    const generation = ++this.generation
    // From here the review may be admitted work: it is never released again.
    this.liveReviewId = null
    this.unbind()
    this.expectedGraphId = review.destinationGraphId
    this.confirmScan = this.preview.readyScan
    this.set({ step: 'starting', errorText: '', confirmUnknown: false })
    let job: VaultJob
    try {
      job = await this.options.adapter.confirm(review.reviewId, review.digest)
    } catch (error) {
      if (generation !== this.generation) return
      // Every confirm error is ambiguous, whatever its code: the node may
      // have admitted the review, or may admit it later (a worker can wait on
      // a lease before admission). Only the local expiry check above is a
      // definite refusal. Never confirm again: look for the job instead.
      this.set({ step: 'job', job: null, confirmUnknown: true, checkFailed: true, errorText: messageOf(error) })
      await this.reconcileConfirm(generation)
      return
    }
    if (generation !== this.generation) return
    if (!this.accept(job)) return
    if (!vaultJobTerminal(job.phase)) await this.follow(generation)
  }

  /**
   * After a confirm whose outcome is unknown: keeps looking for the job, on
   * its own for a while and then whenever the person asks. No sign of a job is
   * never read as "nothing started"; the dialog only says Mycl hasn't
   * confirmed the import yet.
   */
  private async reconcileConfirm(generation: number): Promise<void> {
    for (let tries = 0; tries < VAULT_RECONCILE_TRIES; tries++) {
      if (await this.probeAdmitted(generation)) return
      if (generation !== this.generation || !this.state.confirmUnknown) return
      await this.wait(this.uncertainPollMs)
      if (generation !== this.generation || !this.state.confirmUnknown) return
    }
  }

  /**
   * One look for the job an ambiguous confirm may have made: the capture's
   * committed job id, then a recent job bound for the reviewed graph. A job
   * found is bound and followed; returns true then, or when this look is stale.
   */
  private async probeAdmitted(generation: number): Promise<boolean> {
    let found: string | null = null
    let failure = ''
    const scan = this.confirmScan
    if (scan) {
      try {
        found = (await this.options.adapter.capture.status(scan.graphId, scan.scanId, 0, 1)).jobId
      } catch (error) {
        failure = messageOf(error)
      }
      if (generation !== this.generation) return true
    }
    if (!found && this.expectedGraphId) {
      try {
        const recent = await this.options.adapter.recentJobs()
        found = recent.jobs.find(job => job.destinationGraphId === this.expectedGraphId)?.jobId ?? null
      } catch (error) {
        failure ||= messageOf(error)
      }
      if (generation !== this.generation) return true
    }
    if (!this.state.confirmUnknown || this.expectedJobId) return true
    if (!found) {
      this.set({ checkFailed: !!failure, errorText: failure })
      return false
    }
    this.expectedJobId = found
    this.set({ confirmUnknown: false, errorText: '' })
    await this.firstStatus(generation, found)
    return true
  }

  /**
   * Holds every job report to the job and graph the dialog is bound to.
   * Binds the job id on the first report that has none yet, and the graph
   * only for a resumed job with no known row. A report that names anything
   * else is not trusted: the dialog stops following and never opens it.
   */
  private accept(job: VaultJob): boolean {
    if (this.mismatch) return false
    if (this.expectedJobId && job.jobId !== this.expectedJobId) {
      return this.reject(job, 'The node answered about a different import than the one Mycl is following. Mycl will not use that answer.')
    }
    if (!this.expectedJobId) this.expectedJobId = job.jobId
    if (!this.expectedGraphId) this.expectedGraphId = job.destinationGraphId
    if (!job.destinationGraphId || job.destinationGraphId !== this.expectedGraphId) {
      return this.reject(job, 'The import reported a different graph than the one reviewed. Mycl will not open it.')
    }
    this.settle(job)
    return true
  }

  private reject(job: VaultJob, errorText: string): false {
    this.mismatch = true
    this.set({ step: 'job', job: { ...job, phase: 'uncertain' }, errorText, stopping: false })
    return false
  }

  /** Records a job report that `accept` already checked. */
  private settle(job: VaultJob): void {
    if (job.phase === 'published') {
      this.set({ step: 'published', job, checkFailed: false, stopping: false, confirmUnknown: false })
      return
    }
    if (job.phase === 'abandoned') {
      this.set({ step: 'abandoned', job, checkFailed: false, stopping: false, confirmUnknown: false })
      return
    }
    this.set({ step: 'job', job, checkFailed: false, confirmUnknown: false })
  }

  /** The job the dialog follows: the reported one, or the one requested before any report. */
  private followedJobId(): string | null {
    return this.state.job?.jobId ?? this.expectedJobId
  }

  private async follow(generation: number): Promise<void> {
    if (this.following === generation) return
    this.following = generation
    try {
      for (;;) {
        const job = this.state.job
        if (!job || this.state.step !== 'job' || this.mismatch) return
        // Uncertain and interrupted jobs change slowly, if at all: check less often.
        const slow = job.phase === 'uncertain' || vaultJobInterrupted(job)
        await this.wait(slow ? this.uncertainPollMs : this.pollMs)
        if (generation !== this.generation) return
        const jobId = this.followedJobId()
        if (!jobId) return
        try {
          const next = await this.options.adapter.jobStatus(jobId)
          if (generation !== this.generation) return
          if (!this.accept(next) || vaultJobTerminal(next.phase)) return
        } catch {
          if (generation !== this.generation) return
          // A failed check says nothing about the job. Keep its phase and look again.
          this.set({ checkFailed: true })
        }
      }
    } finally {
      if (this.following === generation) this.following = null
    }
  }

  /**
   * The first status of a job the dialog did not start: it must name the
   * requested job. On failure the requested id is kept, so Check again retries.
   */
  private async firstStatus(generation: number, jobId: string): Promise<void> {
    let job: VaultJob
    try {
      job = await this.options.adapter.jobStatus(jobId)
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ checkFailed: true, errorText: messageOf(error) })
      return
    }
    if (generation !== this.generation) return
    if (!this.accept(job)) return
    if (!vaultJobTerminal(job.phase)) await this.follow(generation)
  }

  /** Looks again now, for uncertain or a failed check. Never re-imports. */
  async checkNow(): Promise<void> {
    if (this.state.step !== 'job' || this.mismatch) return
    const generation = this.generation
    if (this.state.confirmUnknown) {
      await this.probeAdmitted(generation)
      return
    }
    const jobId = this.followedJobId()
    if (!jobId) return
    if (!this.state.job) {
      // No report yet (the first status failed): retry it as a first status.
      await this.firstStatus(generation, jobId)
      return
    }
    try {
      const next = await this.options.adapter.jobStatus(jobId)
      if (generation !== this.generation) return
      if (this.accept(next) && !vaultJobTerminal(next.phase)) void this.follow(generation)
    } catch {
      if (generation !== this.generation) return
      this.set({ checkFailed: true })
    }
  }

  async stopImport(): Promise<void> {
    const job = this.state.job
    if (!job || this.state.step !== 'job' || this.mismatch || !vaultJobCancellable(job.phase) || this.state.stopping) return
    const generation = this.generation
    const jobId = this.followedJobId()
    if (!jobId) return
    this.set({ stopping: true })
    try {
      const next = await this.options.adapter.cancelJob(jobId)
      if (generation !== this.generation) return
      this.set({ stopping: false })
      if (!this.accept(next)) return
      // Only `abandoned` means stopped. A stop the node accepted but has not
      // settled (cancelRequested, still before publication) is pending, not
      // refused. Any other answer is the job as it is.
      const pending = next.cancelRequested && vaultJobCancellable(next.phase)
      if (next.phase !== 'abandoned' && !pending) this.set({ stopRefused: true, stopExplanation: next.error ?? '' })
    } catch (error) {
      if (generation !== this.generation) return
      // The node refused: publication may have begun. Keep following the job.
      const detail = error instanceof VaultImportError ? error.message : ''
      this.set({ stopping: false, stopRefused: true, stopExplanation: detail })
    }
  }

  openNewGraph(): void {
    const job = this.state.job
    if (!this.current.canOpenGraph || !job) return
    const graphId = job.destinationGraphId
    this.close()
    this.options.openGraph(graphId)
  }

  /**
   * Closes the dialog. A running capture is stopped. A running import job is
   * not: it keeps going on the node, and the dialog stops following it.
   */
  close(): void {
    this.releaseLiveReview()
    this.generation++
    this.state = EMPTY
    this.unbind()
    this.standalone = false
    this.resumedJobId = null
    this.preview.close()
  }

  /** Shows recent imports, from the import menu or from inside the dialog. */
  async showRecent(): Promise<void> {
    this.releaseLiveReview()
    const generation = ++this.generation
    this.unbind()
    this.standalone = true
    this.set({ step: 'recent', recent: null, recentLoading: true, errorText: '', job: null, confirmUnknown: false })
    try {
      const list = await this.options.adapter.recentJobs()
      if (generation !== this.generation) return
      this.set({ recent: list.jobs, recentComplete: list.complete, recentLoading: false })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ recent: [], recentLoading: false, errorText: messageOf(error) })
    }
  }

  /** Opens one recent job and follows it. Never starts a new import. */
  async openRecent(jobId: string): Promise<void> {
    const job = this.state.recent?.find(item => item.jobId === jobId)
    if (!job || this.state.step !== 'recent') return
    this.standalone = true
    await this.resume(job.jobId, job)
  }

  /**
   * Follows an existing job by id: from the recent list, or a capture's
   * committed link. The id is bound now; a known row also binds its graph,
   * so a failed first status and a later Check again cannot mismatch.
   */
  private async resume(jobId: string, known?: VaultJob): Promise<void> {
    this.releaseLiveReview()
    const generation = ++this.generation
    this.unbind()
    this.expectedJobId = jobId
    if (known && known.jobId === jobId && known.destinationGraphId) this.expectedGraphId = known.destinationGraphId
    this.set({ step: 'job', job: null, review: null, errorText: '', checkFailed: false,
      stopping: false, stopRefused: false, stopExplanation: '', confirmUnknown: false })
    await this.firstStatus(generation, jobId)
  }
}

