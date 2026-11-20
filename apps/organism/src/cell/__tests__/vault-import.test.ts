import { describe, expect, it } from 'vitest'
import { VAULT_IMPORT_ENABLED } from '@shrubbery/nucleus'
import type { VaultInvoke } from '../vault-capture.js'
import {
  NativeVaultImportAdapter,
  VAULT_IMPORT_COMMANDS,
  VAULT_WARNING_LIMIT,
  VAULT_IMPORT_ERROR_TEXT,
  VaultImportError,
  VaultImportUnavailableError,
  vaultJobFrom,
  vaultJobInterrupted,
  vaultJobOpenable,
  vaultRecentJobsFrom,
  vaultReviewExpired,
  vaultReviewFrom,
} from '../vault-import.js'

function recorder(answer: (command: string) => unknown) {
  const calls: { command: string; args: Record<string, unknown> }[] = []
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args: args ?? {} })
    const value = answer(command)
    if (value instanceof Error) throw value
    return value
  }) as VaultInvoke
  return { calls, adapter: new NativeVaultImportAdapter(invoke) }
}

describe('Door 1 switch', () => {
  it('is on in this release, so the import menu offers a whole vault', () => {
    expect(VAULT_IMPORT_ENABLED).toBe(true)
  })
})

describe('NativeVaultImportAdapter', () => {
  it('confirms with only the review id and digest', async () => {
    const { calls, adapter } = recorder(() => ({ jobId: 'j', phase: 'accepted', destinationGraphId: 'g2', title: 'T' }))
    await adapter.confirm('r1', 'd1')
    expect(calls).toEqual([{ command: VAULT_IMPORT_COMMANDS.confirm, args: { reviewId: 'r1', digest: 'd1' } }])
  })

  it('reports a step the node lacks as unavailable, without trying another route', async () => {
    const { calls, adapter } = recorder(() => new Error('Command review_vault_import not found'))
    await expect(adapter.review('g', 's', 'T')).rejects.toBeInstanceOf(VaultImportUnavailableError)
    expect(calls.map(c => c.command)).toEqual([VAULT_IMPORT_COMMANDS.review])
  })

  it('passes other errors through as they are', async () => {
    const { adapter } = recorder(() => new Error('The scan has expired'))
    await expect(adapter.review('g', 's', 'T')).rejects.toThrow('The scan has expired')
  })

  it('shows the node\'s own message for a structured refusal, never static copy over it', async () => {
    const refusal = recorder(() => { throw { code: 'stale_source', message: 'The source graph changed. Create a new preview.' } })
    await expect(refusal.adapter.review('g', 's', 'T')).rejects.toBeInstanceOf(VaultImportError)
    await expect(refusal.adapter.review('g', 's', 'T')).rejects.toThrow('The source graph changed. Create a new preview.')
    // Unavailable keeps the node's words too, not "This build can't import".
    const unavailable = recorder(() => { throw { code: 'unavailable', message: 'That preview is no longer available. Create a new preview.' } })
    await expect(unavailable.adapter.confirm('r', 'd')).rejects.toThrow('That preview is no longer available.')
    // A code with no message falls back to the static sentence; busy is not budget.
    const busy = recorder(() => { throw { code: 'busy', message: '' } })
    await expect(busy.adapter.review('g', 's', 'T')).rejects.toMatchObject({ code: 'busy', message: VAULT_IMPORT_ERROR_TEXT.busy })
    expect(VAULT_IMPORT_ERROR_TEXT.busy).not.toBe(VAULT_IMPORT_ERROR_TEXT.budget)
    const json = recorder(() => new Error(JSON.stringify({ code: 'expired', message: 'review r1 expired' })))
    await expect(json.adapter.confirm('r', 'd')).rejects.toMatchObject({ code: 'expired', detail: 'review r1 expired' })
  })

  it('has one plain sentence for every structured code', () => {
    for (const code of ['expired', 'revoked', 'stale_source', 'budget', 'busy', 'unsupported', 'unavailable'] as const) {
      expect(new VaultImportError(code, '').message).toBe(VAULT_IMPORT_ERROR_TEXT[code])
      expect(VAULT_IMPORT_ERROR_TEXT[code].split('. ').length).toBeLessThanOrEqual(2)
    }
  })

  it('releases a preview by id, and lists recent jobs with the limit kept to 1 through 50', async () => {
    const { calls, adapter } = recorder(command => command === VAULT_IMPORT_COMMANDS.recent
      ? { jobs: [{ jobId: 'j1', phase: 'published', destinationGraphId: 'g1', title: 'A', destinationAvailable: true }, { phase: 'building' }], complete: false }
      : { released: true })
    await adapter.releaseReview('r1')
    const list = await adapter.recentJobs()
    await adapter.recentJobs(500)
    await adapter.recentJobs(0)
    expect(calls.map(c => [c.command, c.args])).toEqual([
      [VAULT_IMPORT_COMMANDS.release, { reviewId: 'r1' }],
      [VAULT_IMPORT_COMMANDS.recent, { limit: 20 }],
      [VAULT_IMPORT_COMMANDS.recent, { limit: 50 }],
      [VAULT_IMPORT_COMMANDS.recent, { limit: 1 }],
    ])
    expect(list.jobs.map(j => j.jobId)).toEqual(['j1'])
    expect(list.complete).toBe(false)
  })

  it('keeps capture on the real commands', async () => {
    const { calls, adapter } = recorder(() => ({ state: 'capturing', scanId: 's', graphId: 'g' }))
    await adapter.capture.select('g', 'folder')
    expect(calls[0].command).toBe('select_vault_source')
  })
})

describe('review and job parsing', () => {
  it('refuses a review without its id, digest or new graph id', () => {
    expect(() => vaultReviewFrom({ reviewId: 'r', digest: 'd' })).toThrow()
  })

  it('bounds warnings and counts the rest as omitted', () => {
    const warnings = Array.from({ length: VAULT_WARNING_LIMIT + 5 }, (_, i) => ({ path: `n${i}.md`, message: 'm' }))
    const review = vaultReviewFrom({ reviewId: 'r', digest: 'd', destinationGraphId: 'g', warnings, omittedWarnings: 10 })
    expect(review.warnings).toHaveLength(VAULT_WARNING_LIMIT)
    expect(review.omittedWarnings).toBe(15)
  })

  it('reads workerActive, and treats a missing one as no worker', () => {
    expect(vaultJobFrom({ jobId: 'j', phase: 'building', workerActive: true }).workerActive).toBe(true)
    const missing = vaultJobFrom({ jobId: 'j', phase: 'building' })
    expect(missing.workerActive).toBe(false)
    expect(vaultJobInterrupted(missing)).toBe(true)
    expect(vaultJobInterrupted(vaultJobFrom({ jobId: 'j', phase: 'publishing' }))).toBe(false)
  })

  it('opens a published graph only when it is the expected one and still there', () => {
    const job = vaultJobFrom({ jobId: 'j', phase: 'published', destinationGraphId: 'g', destinationAvailable: true })
    expect(vaultJobOpenable(job, 'g')).toBe(true)
    expect(vaultJobOpenable(job, 'other')).toBe(false)
    const gone = vaultJobFrom({ jobId: 'j', phase: 'published', destinationGraphId: 'g', destinationAvailable: false, error: 'replaced' })
    expect(vaultJobOpenable(gone, 'g')).toBe(false)
    expect(vaultJobOpenable(vaultJobFrom({ jobId: 'j', phase: 'published', destinationGraphId: 'g' }), 'g')).toBe(false)
    expect(vaultJobFrom({ jobId: 'j', phase: 'building', cancelRequested: true }).cancelRequested).toBe(true)
    expect(vaultRecentJobsFrom({}).jobs).toEqual([])
  })

  it('reads expiresAt and the optional tag use count', () => {
    const review = vaultReviewFrom({ reviewId: 'r', digest: 'd', destinationGraphId: 'g', expiresAt: 5000, tagReferences: 12 })
    expect(review.tagReferences).toBe(12)
    expect(vaultReviewExpired(review, 4999)).toBe(false)
    expect(vaultReviewExpired(review, 5000)).toBe(true)
    expect(vaultReviewFrom({ reviewId: 'r', digest: 'd', destinationGraphId: 'g' }).tagReferences).toBeNull()
  })

  it('never reads an unknown job phase as success', () => {
    expect(vaultJobFrom({ jobId: 'j', phase: 'done' }).phase).toBe('uncertain')
    expect(vaultJobFrom({ jobId: 'j', phase: 'published' }).phase).toBe('published')
  })
})
