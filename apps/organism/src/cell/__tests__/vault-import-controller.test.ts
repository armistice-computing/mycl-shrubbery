import { describe, expect, it } from 'vitest'
import { VaultImportController, type VaultImportView } from '../vault-import-controller.js'
import { MockVaultImportAdapter, type MockVaultScript } from '../vault-import-mock.js'
import { VAULT_IMPORT_ERROR_TEXT, VaultImportError, VaultImportUnavailableError } from '../vault-import.js'

function setup(script: MockVaultScript = {}, onWait?: (controller: VaultImportController) => Promise<void>, now?: () => number) {
  const adapter = new MockVaultImportAdapter(script)
  const views: VaultImportView[] = []
  const opened: string[] = []
  const controller: VaultImportController = new VaultImportController({
    adapter,
    render: view => views.push(view),
    openGraph: id => opened.push(id),
    wait: async () => { if (onWait) await onWait(controller) },
    now,
  })
  return { adapter, views, opened, controller }
}

/** Calls `act` once, the first time the job reaches `phase`. */
function during(phase: string, act: (c: VaultImportController) => Promise<void>) {
  let done = false
  return async (c: VaultImportController) => {
    if (done || c.current.job?.phase !== phase) return
    done = true
    await act(c)
  }
}

async function toReview(controller: VaultImportController, title = 'My vault') {
  await controller.choose('home', 'folder')
  controller.setTitle(title)
  await controller.startReview()
}

describe('VaultImportController', () => {
  it('captures, reviews, imports through every phase and opens the new graph only when asked', async () => {
    const { adapter, controller, opened, views } = setup()
    await toReview(controller)
    expect(controller.current.step).toBe('review')
    expect(controller.current.review?.title).toBe('My vault')
    await controller.confirm()
    const phases = views.filter(v => v.job).map(v => v.job!.phase)
    expect(phases).toEqual(expect.arrayContaining(['accepted', 'building', 'publishing', 'published']))
    expect(controller.current.step).toBe('published')
    expect(opened).toEqual([])
    controller.openNewGraph()
    expect(opened).toEqual(['vault-import-1'])
    expect(adapter.calls.filter(c => c.step === 'confirm')).toHaveLength(1)
  })

  it('reviews nothing until the capture is ready and the graph has a name', async () => {
    const { adapter, controller } = setup()
    await controller.choose('home', 'folder')
    await controller.startReview()
    expect(adapter.calls.some(c => c.step === 'review')).toBe(false)
    controller.setTitle('   ')
    await controller.startReview()
    expect(adapter.calls.some(c => c.step === 'review')).toBe(false)
  })

  it('sends confirm only the review id and digest', async () => {
    const { adapter, controller } = setup({ phases: ['published'] })
    await toReview(controller)
    await controller.confirm()
    expect(adapter.calls.find(c => c.step === 'confirm')?.args).toEqual({ reviewId: 'review-1', digest: 'digest-1' })
  })

  it('keeps checking while uncertain, without a second confirm, until the node settles it', async () => {
    const { adapter, controller } = setup({ phases: ['publishing', 'uncertain', 'uncertain', 'published'] })
    await toReview(controller)
    await controller.confirm()
    expect(controller.current.step).toBe('published')
    expect(adapter.calls.filter(c => c.step === 'confirm')).toHaveLength(1)
    expect(adapter.calls.filter(c => c.step === 'job-status').length).toBeGreaterThanOrEqual(4)
  })

  it('treats a failed check as a failed check, not a failed import', async () => {
    const { controller, views } = setup({ statusErrors: 2, phases: ['published'] })
    await toReview(controller)
    await controller.confirm()
    expect(views.some(v => v.checkFailed && v.step === 'job')).toBe(true)
    expect(controller.current.step).toBe('published')
  })

  it('stops a building import and reports it only once the node says abandoned', async () => {
    const { adapter, controller } = setup({ phases: ['building'] }, during('building', c => c.stopImport()))
    await toReview(controller)
    await controller.confirm()
    expect(adapter.calls.some(c => c.step === 'job-cancel')).toBe(true)
    expect(controller.current.step).toBe('abandoned')
  })

  it('offers no Stop once publishing has begun', async () => {
    const { adapter, controller } = setup(
      { phases: ['publishing', 'publishing', 'published'] },
      during('publishing', c => c.stopImport()),
    )
    await toReview(controller)
    await controller.confirm()
    expect(adapter.calls.some(c => c.step === 'job-cancel')).toBe(false)
    expect(controller.current.step).toBe('published')
  })

  it('a Stop the node refuses says so and keeps following the job', async () => {
    const { views, controller } = setup(
      { phases: ['building', 'publishing', 'published'], cancel: 'refused' },
      during('building', c => c.stopImport()),
    )
    await toReview(controller)
    await controller.confirm()
    expect(views.some(v => v.stopRefused)).toBe(true)
    expect(controller.current.step).toBe('published')
  })

  it('never opens a published graph that is not the one reviewed', async () => {
    const { controller, opened } = setup({ phases: ['published'], jobGraphId: 'other' })
    await toReview(controller)
    await controller.confirm()
    expect(controller.current.step).toBe('job')
    expect(controller.current.job?.phase).toBe('uncertain')
    controller.openNewGraph()
    expect(opened).toEqual([])
  })

  it('shows a refused review and lets the person go back', async () => {
    const { controller } = setup({ reviewError: new Error('The vault changed after it was scanned.') })
    await toReview(controller)
    expect(controller.current.step).toBe('review-failed')
    expect(controller.current.errorText).toContain('changed')
    controller.back()
    expect(controller.current.step).toBe('capture')
  })

  it('treats any confirm error as not yet confirmed, never as refused, and never confirms again', async () => {
    const { adapter, controller } = setup({ confirmError: new VaultImportUnavailableError('start an import') })
    await toReview(controller)
    await controller.confirm()
    expect(controller.current.step).toBe('job')
    expect(controller.current.confirmUnknown).toBe(true)
    expect(controller.current.job).toBeNull()
    expect(adapter.calls.filter(c => c.step === 'confirm')).toHaveLength(1)
  })

  it('reports an interrupted job with workerActive false on the view', async () => {
    const { controller, views } = setup({ phases: ['building'], interrupted: true }, async c => {
      if (c.current.job?.phase === 'building') c.close()
    })
    await toReview(controller)
    await controller.confirm()
    const job = views.map(v => v.job).find(j => j?.phase === 'accepted' || j?.phase === 'building')
    expect(job?.workerActive).toBe(false)
  })

  it('a cancel answered with the unchanged phase shows the explanation, not a stop', async () => {
    const { views, controller } = setup(
      { phases: ['building', 'publishing', 'published'], cancel: 'unchanged' },
      during('building', c => c.stopImport()),
    )
    await toReview(controller)
    await controller.confirm()
    const refused = views.find(v => v.stopRefused)
    expect(refused?.stopExplanation).toContain('can no longer be stopped')
    expect(views.some(v => v.step === 'abandoned')).toBe(false)
    expect(controller.current.step).toBe('published')
  })

  it('never sends a review that has expired, and asks for a new scan', async () => {
    const { adapter, controller } = setup({ review: { expiresAt: 1000 } }, undefined, () => 2000)
    await toReview(controller)
    await controller.confirm()
    expect(adapter.calls.some(c => c.step === 'confirm')).toBe(false)
    expect(controller.current.step).toBe('review-failed')
    expect(controller.current.errorText).toBe(VAULT_IMPORT_ERROR_TEXT.expired)
  })

  it('sends a review that has not expired yet', async () => {
    const { adapter, controller } = setup({ review: { expiresAt: 3000 }, phases: ['published'] }, undefined, () => 2000)
    await toReview(controller)
    await controller.confirm()
    expect(adapter.calls.filter(c => c.step === 'confirm')).toHaveLength(1)
  })

  it('offers no Open for a published graph that was deleted or replaced, and never makes it again', async () => {
    const { controller, opened, adapter } = setup({ phases: ['published'], destinationGone: true })
    await toReview(controller)
    await controller.confirm()
    expect(controller.current.step).toBe('published')
    expect(controller.current.canOpenGraph).toBe(false)
    expect(controller.current.job?.error).toContain('no longer available')
    controller.openNewGraph()
    expect(opened).toEqual([])
    expect(adapter.calls.filter(c => c.step === 'confirm')).toHaveLength(1)
  })

  it('shows a requested stop until the node settles it', async () => {
    const { views, controller } = setup({ phases: ['building'], cancel: 'pending' }, during('building', c => c.stopImport()))
    await toReview(controller)
    await controller.confirm()
    expect(views.some(v => v.job?.cancelRequested && v.step === 'job')).toBe(true)
    // A pending stop is not a refused one.
    expect(views.some(v => v.stopRefused)).toBe(false)
    expect(controller.current.step).toBe('abandoned')
  })

  it('releases an unconfirmed preview on close or a new choice, and never after confirm', async () => {
    const first = setup()
    await toReview(first.controller)
    first.controller.close()
    expect(first.adapter.calls.filter(c => c.step === 'release').map(c => c.args)).toEqual([{ reviewId: 'review-1' }])

    const second = setup()
    await toReview(second.controller)
    await second.controller.choose('home', 'folder')
    expect(second.adapter.calls.filter(c => c.step === 'release')).toHaveLength(1)

    const third = setup({ phases: ['building'] }, async c => { c.close() })
    await toReview(third.controller)
    await third.controller.confirm()
    third.controller.close()
    expect(third.adapter.calls.some(c => c.step === 'release')).toBe(false)
  })

  it('keeps only the newest review: confirm sends it, close releases only it', async () => {
    const { adapter, controller } = setup({ phases: ['published'] })
    await toReview(controller)
    controller.back()
    controller.setTitle('Renamed')
    await controller.startReview()
    expect(controller.current.review?.reviewId).toBe('review-2')
    controller.close()
    expect(adapter.calls.filter(c => c.step === 'release').map(c => c.args)).toEqual([{ reviewId: 'review-2' }])
  })

  it('lists recent imports and resumes one without importing again', async () => {
    const recent = [{ jobId: 'job-1', phase: 'building' as const, destinationGraphId: 'vault-import-1', title: 'Old', error: null, workerActive: true, cancelRequested: false, destinationAvailable: false }]
    const { adapter, controller, opened } = setup({ recent, phases: ['published'] })
    await controller.showRecent()
    expect(controller.current.open).toBe(true)
    expect(controller.current.step).toBe('recent')
    expect(controller.current.recent?.map(j => j.jobId)).toEqual(['job-1'])
    await controller.openRecent('job-1')
    expect(controller.current.step).toBe('published')
    expect(controller.current.canOpenGraph).toBe(true)
    controller.openNewGraph()
    expect(opened).toEqual(['vault-import-1'])
    expect(adapter.calls.some(c => c.step === 'confirm' || c.step === 'review')).toBe(false)
  })

  it('resumes the job a capture already committed, instead of reviewing it again', async () => {
    const { adapter, controller } = setup({ committedJobId: 'job-1', phases: ['published'] })
    await controller.choose('home', 'folder')
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(adapter.calls.some(c => c.step === 'job-status' && c.args.jobId === 'job-1')).toBe(true)
    expect(adapter.calls.some(c => c.step === 'review' || c.step === 'confirm')).toBe(false)
    expect(controller.current.step).toBe('published')
  })

  it('asks for the vault again when the node no longer holds the scan, as after a restart', async () => {
    const { controller } = setup({ reviewError: new VaultImportError('unavailable', 'Choose the source in this app session before creating a preview.') })
    await toReview(controller)
    expect(controller.current.step).toBe('review-failed')
    expect(controller.current.needsReselect).toBe(true)
    expect(controller.current.errorText).toBe('Choose the source in this app session before creating a preview.')
  })

  it('closing stops following the job and resets the dialog', async () => {
    const { controller } = setup({ phases: ['building'] })
    await toReview(controller)
    controller.close()
    expect(controller.current.step).toBe('capture')
    expect(controller.current.capture.open).toBe(false)
  })
})
