/**
 * home-life.ts — what Home shows beyond the document lists: the newest verse
 * of the graph's Song, the blocks that have become important, and one
 * "Remember this?" document (Home workshop with Eschaton, 2026-10-02; first
 * pass 2026-10-09).
 *
 * "Remember this?" is a liminal zone (Eschaton, 2026-10-14): valued blocks
 * from documents that are neither new nor in view, in two cards. "Slipping
 * away" comes from the recently created, as it falls out of attention;
 * "From further back" from anywhere. See `rememberExcluded`.
 *
 * Every read goes through the cell's own MCP tools, so Home scores blocks the
 * way agents are scored: `get_important_blocks` is the same ranking an agent
 * gets in attunement (her ruling, 2026-10-02: one score, not a human one).
 *
 * Every part may be empty. A fresh graph has no Song and no valued blocks, and
 * Home then hides those sections rather than showing empty boxes.
 */

export type HomeLifeCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>

export interface HomeLifeBlock {
  readonly documentId: string
  readonly blockId: string
  readonly documentTitle: string
  readonly text: string
  readonly importance: number
  readonly valence: number
  readonly wires: number
}

export interface HomeLifeRemember {
  /** 'recent': slipping away, from the recently created. 'past': from further back. */
  readonly kind: 'recent' | 'past'
  readonly documentId: string
  readonly title: string
  /** The document's most important block, quoted. */
  readonly quote: string
  readonly blockId: string
  readonly importance: number
  /** When the document was last written, or created when never written since; null when unknown. */
  readonly timestamp: number | null
  readonly how: 'written' | 'created'
}

export interface HomeLife {
  /** The newest verse, one entry per line. Empty when the graph has no Song. */
  readonly verse: readonly HomeVerseLine[]
  readonly important: readonly HomeLifeBlock[]
  /** At most one of each kind, 'recent' first. */
  readonly remember: readonly HomeLifeRemember[]
  /** False when any read failed, e.g. while the cell is still starting; retry soon. */
  readonly complete: boolean
}

export const EMPTY_HOME_LIFE: HomeLife = Object.freeze({ verse: [], important: [], remember: [], complete: false })

/** A document as "Remember this?" needs it: from the sidebar projection. */
export interface RememberDocument {
  readonly id: string
  readonly title: string
  readonly readOnly?: boolean
  readonly createdAt?: number
  readonly updatedAt?: number
}

/** What "Remember this?" must stay away from. */
export interface RememberContext {
  readonly documents: readonly RememberDocument[]
  /** Home's "Recently created" list, newest first. */
  readonly recentlyCreated: readonly string[]
  /** This device's open history for the graph, newest first. */
  readonly recentlyOpened: readonly string[]
  readonly now: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * One line of a verse. A string is the verse's own voice; '' is a stanza gap.
 * A counterpoint line names its voice: 1 for the first counterpoint, 2 for
 * the second and third.
 */
export type HomeVerseLine = string | { readonly text: string; readonly voice: 1 | 2 }

/**
 * A verse as lines, from a `music` answer. gardend has already done the line
 * work (geist_song_projection.rs, render_song_verse_markdown): it splits the
 * verse into lines with parse_song_lines (a newline ends a line, a blank line
 * is a stanza; older verses' "/" marks still read), writes a stanza break as
 * a blank line, and interleaves the counterpoints line by line, the first as
 * `_line_` and the others as `**_line_**`. Here headings go ("# The Song",
 * "## Verse 0"), a blank line stays as one stanza gap, and the counterpoint
 * marks become a voice.
 */
export function verseLines(verse: string): HomeVerseLine[] {
  const out: HomeVerseLine[] = []
  for (const raw of verse.split('\n')) {
    if (/^\s*#/.test(raw)) continue
    const line = raw.trim()
    if (line.length === 0) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    const second = /^\*\*_(.+)_\*\*$/.exec(line)
    const first = second ? null : /^_(.+)_$/.exec(line)
    if (second) out.push({ text: second[1]!.trim(), voice: 2 })
    else if (first) out.push({ text: first[1]!.trim(), voice: 1 })
    else out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/** The newest verse from a `music` answer: `verses[0]`. */
export function newestVerse(payload: unknown): HomeVerseLine[] {
  const verses = asRecord(payload)?.verses
  if (!Array.isArray(verses) || verses.length === 0) return []
  return verseLines(text(verses[0]))
}

/** Blocks from a `get_important_blocks` answer, in its order. */
export function importantBlocks(payload: unknown): HomeLifeBlock[] {
  const blocks = asRecord(payload)?.blocks
  if (!Array.isArray(blocks)) return []
  const out: HomeLifeBlock[] = []
  for (const raw of blocks) {
    const block = asRecord(raw)
    if (!block) continue
    const documentId = text(block.documentId)
    const blockId = text(block.blockId)
    const content = text(block.content).trim()
    if (!documentId || !blockId || !content) continue
    out.push({
      documentId,
      blockId,
      documentTitle: text(block.document) || documentId,
      text: content,
      importance: number(block.importance),
      valence: number(block.valence),
      wires: number(block.blockWires),
    })
  }
  return out
}

/**
 * A block's values with the person's own rating counted in. `get_important_blocks`
 * ranks by the composite score, which includes her rating, but reports only
 * the agents' cumulative importance and valence (garden
 * salience_important_blocks.rs, the `importance` and `valence` fields). So a
 * block she rated herself came out on Home as 0 / 0 (Eschaton, 2026-11-19).
 * `get_block_values` reports `combined_importance` and `combined_valence`,
 * which are hers and the agents' together: those are what Home shows.
 */
export interface CombinedValues {
  readonly importance: number
  readonly valence: number
}

/** blockId → combined values, from a `get_block_values` answer. Rows without combined values are skipped. */
export function combinedValues(payload: unknown): Map<string, CombinedValues> {
  const out = new Map<string, CombinedValues>()
  const blocks = asRecord(payload)?.blocks
  if (!Array.isArray(blocks)) return out
  for (const raw of blocks) {
    const row = asRecord(raw)
    if (!row) continue
    const blockId = text(row.blockId) || text(row.block_id)
    // A block nobody rated comes back as a baseline row with cumulative values
    // only. With no rating of hers in it, cumulative is the combined value.
    const unratedByPerson = (row.user_importance ?? row.userImportance ?? null) === null
      && (row.user_valence ?? row.userValence ?? null) === null
    const importance = row.combined_importance ?? row.combinedImportance
      ?? (unratedByPerson ? row.cumulative_importance ?? row.cumulativeImportance : undefined)
    const valence = row.combined_valence ?? row.combinedValence
      ?? (unratedByPerson ? row.cumulative_valence ?? row.cumulativeValence : undefined)
    if (!blockId || typeof importance !== 'number' || typeof valence !== 'number') continue
    if (!Number.isFinite(importance) || !Number.isFinite(valence)) continue
    out.set(blockId, { importance, valence })
  }
  return out
}

/** The same blocks, with combined values where they are known. */
export function withCombinedValues<T extends { readonly blockId: string; readonly importance: number; readonly valence: number }>(
  blocks: readonly T[],
  values: ReadonlyMap<string, CombinedValues>,
): T[] {
  return blocks.map(block => {
    const combined = values.get(block.blockId)
    return combined ? { ...block, importance: combined.importance, valence: combined.valence } : block
  })
}

/**
 * The node's own generated views (the importance view, a Diary, the dream
 * journal) quote other documents' blocks. Their quotes are ranked like any
 * block but carry no ratings of their own, so on Home one showed as a copy of
 * a real card with 0 / 0. Home leaves them out; the real block is there.
 */
export function isGeneratedView(documentId: string): boolean {
  return documentId.startsWith('geist-') || documentId.endsWith('-dream-journal')
}

/** "What has become important" under the Song: 4 cards. */
export const IMPORTANT_COUNT = 4
/** In the Song's place, when the Song is hidden: 6 cards. */
export const IMPORTANT_COUNT_WITHOUT_SONG = 6

/** A document created or written this recently is still new: 48 hours. */
export const REMEMBER_QUIET_MS = 48 * 60 * 60 * 1000
/** How many of the newest created documents are in view. */
export const REMEMBER_SKIP_CREATED = 5
/** How many of the newest opened documents are in view. */
export const REMEMBER_SKIP_OPENED = 15
/** How many of the most important eligible documents take turns, one a day. */
export const REMEMBER_ROTATION = 10
/** "Slipping away" draws from this many of the newest created documents... */
export const REMEMBER_RECENT_COUNT = 15
/** ...created within this window: 30 days. */
export const REMEMBER_RECENT_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The documents "Remember this?" may not show (Eschaton, 2026-10-14):
 * - created or written in the last 48 hours, by anyone;
 * - among the 5 newest in Home's "Recently created";
 * - among the 15 most recently opened on this device;
 * - read-only views the system made, such as the Song.
 *
 * A stopgap: the open history is per device and short. Replace it with the
 * graph's own record of opens when gardend keeps one.
 */
/**
 * A timestamp Home can trust: one not more than a day ahead of now. Some
 * imported documents carry createdAt in microseconds, which reads as tens of
 * thousands of years from now; Home's "Recently created" already drops those
 * (home-activity.ts, latestAcceptedTimestamp). Unknown otherwise.
 */
function plausible(timestamp: number | undefined, now: number): number | undefined {
  return timestamp !== undefined && Number.isFinite(timestamp) && timestamp <= now + 86_400_000 ? timestamp : undefined
}

export function rememberExcluded(context: RememberContext): Set<string> {
  const excluded = new Set<string>([
    ...context.recentlyCreated.slice(0, REMEMBER_SKIP_CREATED),
    ...context.recentlyOpened.slice(0, REMEMBER_SKIP_OPENED),
  ])
  const since = context.now - REMEMBER_QUIET_MS
  for (const document of context.documents) {
    if (document.readOnly) excluded.add(document.id)
    const touched = Math.max(plausible(document.createdAt, context.now) ?? 0, plausible(document.updatedAt, context.now) ?? 0)
    if (touched > since) excluded.add(document.id)
  }
  return excluded
}

/**
 * The eligible blocks, one per document (its most important), most important
 * first, at most REMEMBER_ROTATION. A document whose block Home already shows
 * under "What has become important" is left out, so the two never repeat.
 */
export function rememberPool(
  blocks: readonly HomeLifeBlock[],
  context: RememberContext,
  shown: readonly HomeLifeBlock[] = [],
): HomeLifeBlock[] {
  const excluded = rememberExcluded(context)
  for (const block of shown) excluded.add(block.documentId)
  const known = new Set(context.documents.map(document => document.id))
  const best = new Map<string, HomeLifeBlock>()
  for (const block of blocks) {
    if (block.importance <= 0 || excluded.has(block.documentId) || !known.has(block.documentId)) continue
    const current = best.get(block.documentId)
    if (!current || block.importance > current.importance) best.set(block.documentId, block)
  }
  return [...best.values()]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, REMEMBER_ROTATION)
}

/**
 * The "Slipping away" candidates: the 15 newest documents by creation, if
 * created within 30 days, less the 5 newest and those `rememberExcluded`
 * keeps out: in practice the 6th to the 15th.
 */
export function recentRememberCandidates(context: RememberContext): string[] {
  const excluded = rememberExcluded(context)
  const since = context.now - REMEMBER_RECENT_MS
  return context.documents
    .map(document => ({ id: document.id, readOnly: document.readOnly, createdAt: plausible(document.createdAt, context.now) }))
    .filter((document): document is { id: string; readOnly: boolean | undefined; createdAt: number } =>
      !document.readOnly && document.createdAt !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, REMEMBER_RECENT_COUNT)
    // The 5 newest are in view even when "Recently created" leaves one out
    // (a pinned document shows as pinned instead).
    .slice(REMEMBER_SKIP_CREATED)
    .filter(document => document.createdAt >= since && !excluded.has(document.id))
    .map(document => document.id)
}

/** The local calendar day of `now`, as YYYY-MM-DD: the rotation's seed. */
export function rememberDay(now: number): string {
  const date = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayIndex(day: string, size: number): number {
  let hash = 0
  for (const char of day) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % size
}

/** Today's pick from the pool: the same all day, another tomorrow. Null when the pool is empty. */
export function pickRemember(
  pool: readonly HomeLifeBlock[],
  context: RememberContext,
  kind: HomeLifeRemember['kind'] = 'past',
): HomeLifeRemember | null {
  if (pool.length === 0) return null
  const block = pool[dayIndex(rememberDay(context.now), pool.length)]!
  const document = context.documents.find(item => item.id === block.documentId)
  const written = document?.updatedAt ?? null
  const created = document?.createdAt ?? null
  return {
    kind,
    documentId: block.documentId,
    title: document?.title || block.documentTitle,
    quote: block.text,
    blockId: block.blockId,
    importance: block.importance,
    timestamp: written ?? created,
    how: written !== null ? 'written' : 'created',
  }
}

/**
 * Read everything Home needs from the cell. Each part fails alone: a refused
 * `music` call still leaves the important blocks.
 *
 * `get_important_blocks` returns at most 20, so the "From further back" pool
 * is the top 20 overall plus the top 20 of each valence. Its first 4 (6 when
 * the Song is hidden, `importantCount`) are "What has become important".
 * "Slipping away" asks each recent candidate for its best block, at most 10
 * calls.
 */
export async function loadHomeLife(
  call: HomeLifeCaller,
  graphId: string,
  context: RememberContext,
  options: { readonly importantCount?: number } = {},
): Promise<HomeLife> {
  const importantCount = options.importantCount ?? IMPORTANT_COUNT
  let complete = true
  const failed = <T>(fallback: T) => (): T => {
    complete = false
    return fallback
  }
  const blocks = (args: Record<string, unknown>) =>
    call('get_important_blocks', { graphId, limit: 20, ...args }).then(importantBlocks, failed<HomeLifeBlock[]>([]))
  const recent = recentRememberCandidates(context)
  const [verse, rawTop, rawPositive, rawNegative, rawRecentBest, values] = await Promise.all([
    call('music', { graphId }).then(newestVerse, failed<HomeVerseLine[]>([])),
    blocks({}),
    blocks({ valence: 'positive' }),
    blocks({ valence: 'negative' }),
    // A document that fails alone (deleted since the sidebar read, say) is
    // skipped and does not mark the read incomplete: that would re-read
    // everything every five seconds for as long as Home is open.
    Promise.all(recent.map(documentId =>
      call('get_important_blocks', { graphId, documentId, limit: 1 })
        .then(payload => importantBlocks(payload)[0] ?? null, () => null),
    )),
    // The person's ratings, counted in (see CombinedValues). The 100 highest
    // composite scores cover every block above, which are ranked the same
    // way. A refusal leaves the agents' numbers and does not mark Home
    // incomplete, which would re-read everything every five seconds.
    call('get_block_values', { graphId, limit: 100 }).then(combinedValues, () => new Map<string, CombinedValues>()),
  ])
  const top = withCombinedValues(rawTop.filter(block => !isGeneratedView(block.documentId)), values)
  const positive = withCombinedValues(rawPositive, values)
  const negative = withCombinedValues(rawNegative, values)
  const recentBest = rawRecentBest.map(block => block ? withCombinedValues([block], values)[0]! : null)
  // A block nobody rated still has a baseline composite score, so it can rank
  // here; with its values known to be 0 / 0 it has not become important.
  const unrated = (block: HomeLifeBlock) => block.importance <= 0 && block.valence === 0
  const candidates = top.filter(block => !(values.has(block.blockId) && unrated(block)))
  // A card the graph-wide read did not reach asks for its own values. One
  // whose read fails keeps the agents' numbers rather than disappearing.
  const checked = await Promise.all(candidates.slice(0, importantCount).map(block => values.has(block.blockId)
    ? block
    : call('get_block_values', { graphId, documentId: block.documentId, blockId: block.blockId })
      .then(payload => {
        const own = combinedValues(payload)
        const next = withCombinedValues([block], own)[0]!
        return own.has(block.blockId) && unrated(next) ? null : next
      }, () => block)))
  const important = checked.filter((block): block is HomeLifeBlock => block !== null)
  const recentPool = rememberPool(recentBest.filter((block): block is HomeLifeBlock => block !== null), context, important)
  const slipping = pickRemember(recentPool, context, 'recent')
  // The past card never repeats the recent card's document.
  const slippingBlock = recentPool.find(block => block.blockId === slipping?.blockId)
  const past = pickRemember(
    rememberPool([...top, ...positive, ...negative], context, slippingBlock ? [...important, slippingBlock] : important),
    context,
    'past',
  )
  return { verse, important, remember: [slipping, past].filter((item): item is HomeLifeRemember => item !== null), complete }
}
