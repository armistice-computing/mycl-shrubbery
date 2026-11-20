import { describe, expect, it } from 'vitest'
import { historyRelativeTime, historyTierLabel } from '../history-time.js'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const ago = (ms: number) => NOW - ms
const MIN = 60_000
const HR = 60 * MIN
const DAY = 24 * HR

describe('history time words', () => {
  it('spells tiers out in lowercase', () => {
    expect(historyTierLabel('20min')).toBe('20 min')
    expect(historyTierLabel('2h')).toBe('2 hr')
    expect(historyTierLabel('12h')).toBe('12 hr')
    expect(historyTierLabel('daily')).toBe('1 day')
    expect(historyTierLabel('weekly')).toBe('1 week')
    expect(historyTierLabel(null)).toBe('snapshot')
  })

  it('says how long ago in words', () => {
    expect(historyRelativeTime(ago(20 * 1000), NOW)).toBe('just now')
    expect(historyRelativeTime(ago(20 * MIN), NOW)).toBe('20 min ago')
    expect(historyRelativeTime(ago(3 * HR), NOW)).toBe('3 hr ago')
    expect(historyRelativeTime(ago(DAY + HR), NOW)).toBe('yesterday')
    expect(historyRelativeTime(ago(3 * DAY), NOW)).toBe('3 days ago')
    expect(historyRelativeTime(ago(21 * DAY), NOW)).toBe('3 weeks ago')
  })
})
