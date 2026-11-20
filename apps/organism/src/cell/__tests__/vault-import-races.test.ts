/**
 * Door 1 races, made deterministic: every adapter call returns a promise the
 * test settles by hand, so a reply can be made to land after a close, after a
 * newer import, or out of order (Epsilon's review, dispatch msg-3bc8da04).
 */
import { describe, expect, it } from 'vitest'
import { VaultImportController } from '../vault-import-controller.js'
import { MOCK_VAULT_ENTRIES, MOCK_VAULT_REVIEW } from '../vault-import-mock.js'
import type { VaultCaptureStatus } from '../vault-capture.js'
import { VaultImportError, type VaultImportAdapter, type VaultJob, type VaultJobPhase, type VaultRecentJobs, type VaultReview } from '../vault-import.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Lets every settled promise run its continuations. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function job(jobId: string, phase: VaultJobPhase, destinationGraphId: string, extra: Partial<VaultJob> = {}): VaultJob {
  return {
    jobId, phase, destinationGraphId, title: 'T', error: null, workerActive: true,
    cancelRequested: false, destinationAvailable: phase === 'published', ...extra,
  }
}

class DeferredAdapter implements VaultImportAdapter {
  readonly reviews: Deferred<VaultReview>[] = []
  readonly confirms: Deferred<VaultJob>[] = []
  readonly statuses: { jobId: string; d: Deferred<VaultJob> }[] = []
  readonly cancels: Deferred<VaultJob>[] = []
  readonly released: string[] = []
  readonly captureReads: Deferred<VaultCaptureStatus>[] = []
  /** When set, capture status reads after the first wait on `captureReads`. */
  deferCaptureAfterReady = false
  private readyServed = false
  recent: VaultJob[] = []

  readonly capture = {
    select: async (graphId: string) => ({ state: 'capturing' as const, scanId: 'scan-1', graphId }),
    status: async (): Promise<VaultCaptureStatus> => {
      if (this.readyServed && this.deferCaptureAfterReady) {
        const d = deferred<VaultCaptureStatus>()
        this.captureReads.push(d)
        return d.promise
      }
      this.readyServed = true
      return {
        state: 'ready', expiresAt: null, fingerprint: 'f', error: null, totalEntries: MOCK_VAULT_ENTRIES.length,
        entries: [...MOCK_VAULT_ENTRIES], nextOffset: null, complete: true, jobId: null,
      }
    },
    cancel: async () => ({ state: 'cancelled' as const, cancelled: true }),
  }

  review(): Promise<VaultReview> { const d = deferred<VaultReview>(); this.reviews.push(d); return d.promise }
  confirm(): Promise<VaultJob> { const d = deferred<VaultJob>(); this.confirms.push(d); return d.promise }
  jobStatus(jobId: string): Promise<VaultJob> { const d = deferred<VaultJob>(); this.statuses.push({ jobId, d }); return d.promise }
  cancelJob(): Promise<VaultJob> { const d = deferred<VaultJob>(); this.cancels.push(d); return d.promise }
  async releaseReview(reviewId: string): Promise<void> { this.released.push(reviewId) }
  async recentJobs(): Promise<VaultRecentJobs> { return { jobs: this.recent, complete: true } }
}

function captureWith(jobId: string | null): VaultCaptureStatus {
  return {
    state: 'ready', expiresAt: null, fingerprint: 'f', error: null, totalEntries: 0, entries: [],
    nextOffset: null, complete: true, jobId,
  }
}

/** A controller whose polling waits forever, so only the test's checks run. */
function setup(adapter = new DeferredAdapter()) {
  const opened: string[] = []
  const controller = new VaultImportController({
    adapter,
    render: () => {},
    openGraph: id => opened.push(id),
    wait: () => new Promise(() => {}),
  })
  return { adapter, controller, opened }
}

async function toReview(controller: VaultImportController, adapter: DeferredAdapter, reviewId = 'review-1') {
  await controller.choose('home', 'folder')
  controller.setTitle('My vault')
  const pending = controller.startReview()
  adapter.reviews.at(-1)!.resolve({ ...MOCK_VAULT_REVIEW, reviewId })
  await pending
}

describe('Door 1 races', () => {
  it('a late status after close changes nothing', async () => {
    const { adapter, controller } = setup()
    adapter.recent = [job('job-1', 'building', 'g1')]
    await controller.showRecent()
    const resumed = controller.openRecent('job-1')
    adapter.statuses[0].d.resolve(job('job-1', 'building', 'g1'))
    void resumed // it goes on following, and its waits never end here
    await flush()
    const check = controller.checkNow()
    controller.close()
    adapter.statuses.at(-1)!.d.resolve(job('job-1', 'published', 'g1'))
    await check
    await flush()
    expect(controller.current.step).toBe('capture')
    expect(controller.current.job).toBeNull()
    expect(controller.current.open).toBe(false)
  })

  it('a late cancel error after a newer import never marks the new one refused', async () => {
    const { adapter, controller } = setup()
    adapter.recent = [job('job-1', 'building', 'g1'), job('job-2', 'building', 'g2')]
    await controller.showRecent()
    const first = controller.openRecent('job-1')
    adapter.statuses[0].d.resolve(job('job-1', 'building', 'g1'))
    void first
    await flush()
    const stop = controller.stopImport()
    await controller.showRecent()
    const second = controller.openRecent('job-2')
    adapter.statuses.at(-1)!.d.resolve(job('job-2', 'building', 'g2'))
    void second
    await flush()
    adapter.cancels[0].reject(new Error('late failure for job-1'))
    await stop
    await flush()
    expect(controller.current.job?.jobId).toBe('job-2')
    expect(controller.current.stopRefused).toBe(false)
    expect(controller.current.stopping).toBe(false)
  })

  it('a review handle that lands after close is released, not dropped', async () => {
    const { adapter, controller } = setup()
    await controller.choose('home', 'folder')
    controller.setTitle('My vault')
    const pending = controller.startReview()
    controller.close()
    adapter.reviews[0].resolve({ ...MOCK_VAULT_REVIEW, reviewId: 'late-review' })
    await pending
    await flush()
    expect(adapter.released).toEqual(['late-review'])
    expect(controller.current.review).toBeNull()
  })

  it('a review handle that lands after another vault is chosen is released', async () => {
    const { adapter, controller } = setup()
    await controller.choose('home', 'folder')
    controller.setTitle('My vault')
    const pending = controller.startReview()
    await controller.choose('home', 'folder')
    adapter.reviews[0].resolve({ ...MOCK_VAULT_REVIEW, reviewId: 'stale-review' })
    await pending
    await flush()
    expect(adapter.released).toEqual(['stale-review'])
    expect(controller.current.step).toBe('capture')
  })

  it('a resumed job whose first reply names another job is not trusted', async () => {
    const { adapter, controller, opened } = setup()
    adapter.recent = [job('job-1', 'building', 'g1')]
    await controller.showRecent()
    const resumed = controller.openRecent('job-1')
    adapter.statuses[0].d.resolve(job('job-9', 'published', 'g1'))
    await resumed
    expect(controller.current.step).toBe('job')
    expect(controller.current.job?.phase).toBe('uncertain')
    expect(controller.current.canOpenGraph).toBe(false)
    controller.openNewGraph()
    expect(opened).toEqual([])
    await controller.checkNow()
    expect(adapter.statuses).toHaveLength(1)
  })

  it('a report naming another graph mid-import stops the follow, before publication too', async () => {
    const { adapter, controller } = setup()
    adapter.recent = [job('job-1', 'building', 'g1')]
    await controller.showRecent()
    const resumed = controller.openRecent('job-1')
    adapter.statuses[0].d.resolve(job('job-1', 'building', 'other-graph'))
    await resumed
    expect(controller.current.job?.phase).toBe('uncertain')
    expect(controller.current.errorText).toContain('different graph')
    await controller.stopImport()
    expect(adapter.cancels).toHaveLength(0)
  })

  it('a failed first status keeps the requested job, and Check again really retries it', async () => {
    const { adapter, controller, opened } = setup()
    adapter.recent = [job('job-1', 'building', 'g1')]
    await controller.showRecent()
    const resumed = controller.openRecent('job-1')
    adapter.statuses[0].d.reject(new Error('no answer'))
    await resumed
    expect(controller.current.step).toBe('job')
    expect(controller.current.job).toBeNull()
    expect(controller.current.checkFailed).toBe(true)
    const check = controller.checkNow()
    expect(adapter.statuses).toHaveLength(2)
    expect(adapter.statuses[1].jobId).toBe('job-1')
    adapter.statuses[1].d.resolve(job('job-1', 'published', 'g1'))
    await check
    expect(controller.current.step).toBe('published')
    expect(controller.current.canOpenGraph).toBe(true)
    controller.openNewGraph()
    expect(opened).toEqual(['g1'])
  })

  it('a lost confirm reply is not "nothing started": the committed job is followed, and nothing confirms again', async () => {
    const adapter = new DeferredAdapter()
    adapter.deferCaptureAfterReady = true
    const { controller } = setup(adapter)
    await toReview(controller, adapter)
    const confirming = controller.confirm()
    adapter.confirms[0].reject(new Error('The connection closed before the reply.'))
    await flush()
    expect(controller.current.step).toBe('job')
    expect(controller.current.confirmUnknown).toBe(true)
    adapter.captureReads[0].resolve({
      state: 'ready', expiresAt: null, fingerprint: 'f', error: null, totalEntries: 0, entries: [],
      nextOffset: null, complete: true, jobId: 'job-7',
    })
    await flush()
    expect(adapter.statuses.map(s => s.jobId)).toEqual(['job-7'])
    adapter.statuses[0].d.resolve(job('job-7', 'published', MOCK_VAULT_REVIEW.destinationGraphId))
    await confirming
    expect(controller.current.step).toBe('published')
    expect(controller.current.canOpenGraph).toBe(true)
    expect(adapter.confirms).toHaveLength(1)
    expect(adapter.released).toEqual([])
  })

  it('no committed job yet is never read as nothing started: the dialog keeps looking', async () => {
    const adapter = new DeferredAdapter()
    adapter.deferCaptureAfterReady = true
    const { controller } = setup(adapter)
    await toReview(controller, adapter)
    void controller.confirm()
    adapter.confirms[0].reject(new VaultImportError('budget', 'too many open files'))
    await flush()
    adapter.captureReads[0].resolve(captureWith(null))
    await flush()
    expect(controller.current.step).toBe('job')
    expect(controller.current.confirmUnknown).toBe(true)
    expect(controller.current.errorText).not.toContain('No import started')
    expect(adapter.confirms).toHaveLength(1)
  })

  it('a job that is admitted later is found by Check again through the capture link, and followed', async () => {
    const adapter = new DeferredAdapter()
    adapter.deferCaptureAfterReady = true
    const { controller, opened } = setup(adapter)
    await toReview(controller, adapter)
    void controller.confirm()
    adapter.confirms[0].reject(new Error('The connection closed before the reply.'))
    await flush()
    adapter.captureReads[0].resolve(captureWith(null))
    await flush()
    expect(controller.current.confirmUnknown).toBe(true)
    // The worker waited on its lease, then admitted: the link now names the job.
    void controller.checkNow()
    await flush()
    adapter.captureReads[1].resolve(captureWith('job-late'))
    await flush()
    expect(adapter.statuses.map(s => s.jobId)).toEqual(['job-late'])
    adapter.statuses[0].d.resolve(job('job-late', 'published', MOCK_VAULT_REVIEW.destinationGraphId))
    await flush()
    expect(controller.current.step).toBe('published')
    expect(controller.current.canOpenGraph).toBe(true)
    controller.openNewGraph()
    expect(opened).toEqual([MOCK_VAULT_REVIEW.destinationGraphId])
    expect(adapter.confirms).toHaveLength(1)
  })

  it('a job admitted later is also found among recent jobs bound for the reviewed graph', async () => {
    const adapter = new DeferredAdapter()
    adapter.deferCaptureAfterReady = true
    const { controller } = setup(adapter)
    await toReview(controller, adapter)
    void controller.confirm()
    adapter.confirms[0].reject(new Error('lost'))
    await flush()
    adapter.captureReads[0].resolve(captureWith(null))
    await flush()
    adapter.recent = [job('job-other', 'published', 'some-other-graph'), job('job-mine', 'building', MOCK_VAULT_REVIEW.destinationGraphId)]
    void controller.checkNow()
    await flush()
    adapter.captureReads[1].resolve(captureWith(null))
    await flush()
    expect(adapter.statuses.map(s => s.jobId)).toEqual(['job-mine'])
    adapter.statuses[0].d.resolve(job('job-mine', 'building', MOCK_VAULT_REVIEW.destinationGraphId))
    await flush()
    expect(controller.current.job?.jobId).toBe('job-mine')
    expect(controller.current.confirmUnknown).toBe(false)
  })

  it('a lost confirm reply whose reconcile also fails leaves Check again, which reads the capture again', async () => {
    const adapter = new DeferredAdapter()
    adapter.deferCaptureAfterReady = true
    const { controller } = setup(adapter)
    await toReview(controller, adapter)
    const confirming = controller.confirm()
    adapter.confirms[0].reject(new Error('lost'))
    await flush()
    adapter.captureReads[0].reject(new Error('still no answer'))
    void confirming // it keeps looking, and its waits never end here
    await flush()
    expect(controller.current.confirmUnknown).toBe(true)
    expect(controller.current.checkFailed).toBe(true)
    const check = controller.checkNow()
    await flush()
    expect(adapter.captureReads).toHaveLength(2)
    adapter.captureReads[1].resolve({
      state: 'ready', expiresAt: null, fingerprint: 'f', error: null, totalEntries: 0, entries: [],
      nextOffset: null, complete: true, jobId: 'job-7',
    })
    await flush()
    adapter.statuses[0].d.resolve(job('job-7', 'building', MOCK_VAULT_REVIEW.destinationGraphId))
    void check
    await flush()
    expect(controller.current.job?.jobId).toBe('job-7')
    expect(adapter.confirms).toHaveLength(1)
  })
})
