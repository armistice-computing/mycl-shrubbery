import { describe, expect, it, vi } from 'vitest'
import {
  addGettingStarted,
  gettingStartedGraphId,
  wipeAndStartOver,
  wipeConfirmationMatches,
  type HelpGraphOps,
} from '../help-actions.js'

const NOW = new Date(2026, 10, 18, 9, 30)

function fakeOps(ids: string[], options: { failSeed?: boolean; failDelete?: string } = {}) {
  const calls: string[] = []
  const graphs = new Set(ids)
  const ops: HelpGraphOps = {
    seed: vi.fn(async (graphId: string) => {
      calls.push(`seed:${graphId}`)
      if (options.failSeed) throw new Error('archive missing')
      graphs.add(graphId)
    }),
    listGraphIds: vi.fn(async () => [...graphs]),
    switchTo: vi.fn(async (graphId: string) => { calls.push(`switch:${graphId}`) }),
    deleteGraph: vi.fn(async (graphId: string) => {
      calls.push(`delete:${graphId}`)
      if (graphId === options.failDelete) throw new Error('busy')
      graphs.delete(graphId)
    }),
  }
  return { ops, calls, graphs }
}

describe('Settings → Help graph actions', () => {
  it('names the new graph by date, and never reuses an id', () => {
    expect(gettingStartedGraphId([], NOW)).toBe('start-2026-11-18')
    expect(gettingStartedGraphId(['start-2026-11-18'], NOW)).toBe('start-2026-11-18-2')
    expect(gettingStartedGraphId(['start-2026-11-18', 'start-2026-11-18-2'], NOW))
      .toBe('start-2026-11-18-3')
  })

  it('adds the Getting Started pages as a new graph and touches nothing else', async () => {
    const { ops, calls } = fakeOps(['default_x1', 'notes'])
    expect(await addGettingStarted(ops, NOW)).toBe('start-2026-11-18')
    expect(calls).toEqual(['seed:start-2026-11-18'])
  })

  it('wipes by seeding and opening the new graph before deleting the others', async () => {
    const { ops, calls, graphs } = fakeOps(['default_x1', 'notes'])
    const result = await wipeAndStartOver(ops, NOW)
    expect(calls).toEqual([
      'seed:start-2026-11-18',
      'switch:start-2026-11-18',
      'delete:default_x1',
      'delete:notes',
    ])
    expect(result).toEqual({ graphId: 'start-2026-11-18', deleted: ['default_x1', 'notes'], failed: [] })
    expect([...graphs]).toEqual(['start-2026-11-18'])
  })

  it('deletes nothing when the new graph cannot be made', async () => {
    const { ops, calls } = fakeOps(['default_x1'], { failSeed: true })
    await expect(wipeAndStartOver(ops, NOW)).rejects.toThrow('archive missing')
    expect(calls).toEqual(['seed:start-2026-11-18'])
    expect(ops.deleteGraph).not.toHaveBeenCalled()
  })

  it('keeps going past a graph that will not delete, and reports it', async () => {
    const { ops } = fakeOps(['a', 'b', 'c'], { failDelete: 'b' })
    const result = await wipeAndStartOver(ops, NOW)
    expect(result.deleted).toEqual(['a', 'c'])
    expect(result.failed).toEqual([{ graphId: 'b', reason: 'busy' }])
  })

  it('arms the last step only on the word delete', () => {
    expect(wipeConfirmationMatches('delete')).toBe(true)
    expect(wipeConfirmationMatches('  DELETE ')).toBe(true)
    expect(wipeConfirmationMatches('delet')).toBe(false)
    expect(wipeConfirmationMatches('delete everything')).toBe(false)
  })
})
