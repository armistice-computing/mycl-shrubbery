/**
 * Time words for version history, spelled out and lowercase: "20 min",
 * "2 hr", "3 days ago". The compact "20M" and "3d" read as codes
 * (Eschaton, 2026-11-18).
 */

const TIER_LABELS: Record<string, string> = {
  '20min': '20 min',
  '2h': '2 hr',
  '12h': '12 hr',
  daily: '1 day',
  weekly: '1 week',
}

/** The label for a snapshot tier: how far apart its snapshots are kept. */
export function historyTierLabel(tier: string | null | undefined): string {
  if (!tier) return 'snapshot'
  return TIER_LABELS[tier] ?? tier
}

/** How long ago, from `then` (ms since the epoch) to `now`. */
export function historyRelativeTime(then: number, now: number = Date.now()): string {
  if (!then) return 'unknown time'
  const min = Math.floor(Math.max(0, now - then) / 60_000)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (hr < 24) return `${hr} hr ago`
  if (day === 1) return 'yesterday'
  if (day < 14) return `${day} days ago`
  return `${Math.floor(day / 7)} weeks ago`
}
