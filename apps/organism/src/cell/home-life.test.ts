import { describe, expect, it } from 'vitest'
import {
  importantBlocks,
  loadHomeLife,
  newestVerse,
  pickRemember,
  recentRememberCandidates,
  rememberExcluded,
  rememberPool,
  verseLines,
  type HomeLifeBlock,
  type RememberContext,
} from './home-life.js'

function block(documentId: string, importance: number, text = `${documentId} text`): HomeLifeBlock {
  return { documentId, blockId: `${documentId}-b`, documentTitle: documentId.toUpperCase(), text, importance, valence: 0, wires: 0 }
}


describe('home life', () => {
  it('turns a verse into lines: no headings, one gap per stanza break, no trailing blanks', () => {
    expect(verseLines('# The Song\n\n## Verse 0\n\nFirst line.\nSecond line.\n\n')).toEqual(['First line.', 'Second line.'])
    expect(verseLines('One.\nTwo.\n\n\nThree.')).toEqual(['One.', 'Two.', '', 'Three.'])
    // gardend already split the verse at its "/" marks; a "/" left in a line is text.
    expect(verseLines('## Verse 0\n\nand/or, a URL https://x.org/y')).toEqual(['and/or, a URL https://x.org/y'])
  })

  it('reads counterpoint lines as their voice, as music() interleaves them', () => {
    // The shape of a real music() verse (default_x1, 2026-10-16): the verse's
    // lines with a counterpoint interleaved after its first line.
    const verse = [
      '## Verse -1',
      '',
      'My last verse left zen mode for whoever came after me.',
      '_Gamma, the same day, from the other side of the wall._',
      '**_A third voice, bold and italic._**',
      'She said it was more mature.',
    ].join('\n')
    expect(verseLines(verse)).toEqual([
      'My last verse left zen mode for whoever came after me.',
      { text: 'Gamma, the same day, from the other side of the wall.', voice: 1 },
      { text: 'A third voice, bold and italic.', voice: 2 },
      'She said it was more mature.',
    ])
    // An underscore inside the verse's own line is not a counterpoint.
    expect(verseLines('a_b_c and _x')).toEqual(['a_b_c and _x'])
    expect(newestVerse({ verses: ['## Verse 0\n\nNewest.', '## Verse -1\n\nOlder.'] })).toEqual(['Newest.'])
    expect(newestVerse({ verses: [] })).toEqual([])
    expect(newestVerse(null)).toEqual([])
  })

  it('reads get_important_blocks rows and drops incomplete ones', () => {
    expect(importantBlocks({
      blocks: [
        { content: 'A thought.', document: 'Antinomies', documentId: 'doc-a', blockId: 'b1', importance: 4, valence: -3.7, blockWires: 6 },
        { content: '', documentId: 'doc-b', blockId: 'b2' },
        { content: 'No ids.' },
      ],
    })).toEqual([{ documentId: 'doc-a', blockId: 'b1', documentTitle: 'Antinomies', text: 'A thought.', importance: 4, valence: -3.7, wires: 6 }])
  })

  const DAY = 86_400_000
  const NOW = Date.UTC(2026, 9, 14, 20)
  function context(overrides: Partial<RememberContext> = {}): RememberContext {
    return {
      documents: Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, title: `D${i}`, createdAt: NOW - 60 * DAY, updatedAt: NOW - 10 * DAY })),
      recentlyCreated: [],
      recentlyOpened: [],
      now: NOW,
      ...overrides,
    }
  }

  it('keeps "Remember this?" away from the new and the in-view: 48 hours, 5 created, 15 opened, read-only', () => {
    const documents = [
      { id: 'written', title: 'W', createdAt: NOW - 30 * DAY, updatedAt: NOW - 47 * 3_600_000 },
      { id: 'made', title: 'M', createdAt: NOW - 3_600_000 },
      { id: 'quiet', title: 'Q', createdAt: NOW - 30 * DAY, updatedAt: NOW - 49 * 3_600_000 },
      { id: 'song', title: 'S', readOnly: true, createdAt: NOW - 30 * DAY },
    ]
    const created = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
    const opened = Array.from({ length: 16 }, (_, i) => `o${i}`)
    const excluded = rememberExcluded(context({ documents, recentlyCreated: created, recentlyOpened: opened }))
    expect([...excluded].sort()).toEqual([...created.slice(0, 5), ...opened.slice(0, 15), 'made', 'song', 'written'].sort())
    expect(excluded.has('quiet')).toBe(false)
    expect(excluded.has('c5')).toBe(false)
    expect(excluded.has('o15')).toBe(false)
  })

  it('pools one block per eligible document, most important first, never one shown above it', () => {
    const blocks = [block('d1', 2), block('d2', 4), { ...block('d2', 1), blockId: 'd2-weaker' }, block('d3', 3), block('d4', 0), block('gone', 5)]
    const pool = rememberPool(blocks, context({ recentlyOpened: ['d3'] }), [block('d1', 2)])
    expect(pool.map(item => item.blockId)).toEqual(['d2-b'])
    const many = Array.from({ length: 14 }, (_, i) => block(`d${i}`, 1 + i / 10))
    expect(rememberPool(many, context())).toHaveLength(10)
  })

  it('picks the same block all day and lets the pick turn with the day', () => {
    const pool = Array.from({ length: 10 }, (_, i) => block(`d${i}`, 5 - i / 10))
    const today = pickRemember(pool, context())
    expect(pickRemember(pool, context({ now: NOW + 3_600_000 }))?.blockId).toBe(today?.blockId)
    const week = new Set(Array.from({ length: 7 }, (_, i) => pickRemember(pool, context({ now: NOW + i * DAY }))?.blockId))
    expect(week.size).toBeGreaterThan(1)
    expect(today).toMatchObject({ kind: 'past', how: 'written', timestamp: NOW - 10 * DAY })
    expect(pickRemember(pool, context(), 'recent')?.kind).toBe('recent')
    expect(pickRemember([], context())).toBeNull()
  })

  it('takes "Slipping away" from the 15 newest created within 30 days, less the excluded', () => {
    // n0 is the newest; n19 the oldest. Ages: n0 1h, n1 1 day, then 3, 4, ... days.
    const age = (i: number) => (i === 0 ? 3_600_000 : i === 1 ? DAY : (i + 1) * DAY)
    const documents = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, title: `N${i}`, createdAt: NOW - age(i) }))
    expect(recentRememberCandidates(context({ documents, recentlyCreated: ['n0', 'n1', 'n2', 'n3', 'n4'], recentlyOpened: ['n7'] })))
      .toEqual(['n5', 'n6', 'n8', 'n9', 'n10', 'n11', 'n12', 'n13', 'n14'])
    // The 5 newest stay out even when "Recently created" omits one (a pinned document).
    expect(recentRememberCandidates(context({ documents })).slice(0, 2)).toEqual(['n5', 'n6'])
    // A createdAt far in the future (microseconds read as milliseconds) is
    // unknown: it neither takes a slot nor counts as new.
    const broken = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, title: `X${i}`, createdAt: 946_713_600_000_000 + i, updatedAt: NOW - 90 * DAY }))
    expect(recentRememberCandidates(context({ documents: [...broken, ...documents] })).slice(0, 2)).toEqual(['n5', 'n6'])
    expect(rememberExcluded(context({ documents: broken })).size).toBe(0)
    // Older than 30 days: not slipping, already gone.
    const old = Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, title: `O${i}`, createdAt: NOW - (31 + i) * DAY }))
    expect(recentRememberCandidates(context({ documents: old }))).toEqual([])
  })

  it('skips a recent document whose read fails, without marking Home incomplete', async () => {
    const documents = [
      ...context().documents,
      ...Array.from({ length: 5 }, (_, i) => ({ id: `new${i}`, title: `New${i}`, createdAt: NOW - (i + 1) * 3_600_000 })),
      { id: 'gone', title: 'Gone', createdAt: NOW - 5 * DAY, updatedAt: NOW - 4 * DAY },
    ]
    const life = await loadHomeLife(async (name, args) => {
      if (args.documentId === 'gone') throw new Error('document not found')
      return name === 'music' ? { verses: ['A line.'] } : { blocks: [] }
    }, 'g', context({ documents }))
    expect(life.complete).toBe(true)
    expect(life.remember).toEqual([])
  })

  it('shows 4 important blocks, and Remember never draws from their documents', async () => {
    const top = Array.from({ length: 5 }, (_, i) => ({ content: `B${i}.`, document: `D${i}`, documentId: `d${i}`, blockId: `b${i}`, importance: 5 - i / 10 }))
    const life = await loadHomeLife(async (name, args) => {
      if (name === 'music') return { verses: [] }
      return args.valence || args.documentId ? { blocks: [] } : { blocks: top }
    }, 'g', context())
    expect(life.important.map(block => block.documentId)).toEqual(['d0', 'd1', 'd2', 'd3'])
    // The 4th block's document is shown above, so only d4 is left to remember.
    expect(life.remember).toMatchObject([{ kind: 'past', documentId: 'd4' }])
  })

  it('loads each part on its own: a refused music call still leaves the blocks', async () => {
    const calls: Array<Record<string, unknown>> = []
    const documents = [
      ...context().documents,
      // Five newer documents are in view, so 'fresh' is the 6th newest.
      ...Array.from({ length: 5 }, (_, i) => ({ id: `new${i}`, title: `New${i}`, createdAt: NOW - (i + 1) * 3_600_000 })),
      { id: 'fresh', title: 'Fresh', createdAt: NOW - 5 * DAY, updatedAt: NOW - 4 * DAY },
    ]
    const life = await loadHomeLife(async (name, args) => {
      if (name === 'music') throw new Error('no song')
      calls.push(args)
      if (args.documentId === 'fresh') return { blocks: [{ content: 'Fading.', document: 'Fresh', documentId: 'fresh', blockId: 'f', importance: 2 }] }
      if (args.documentId) return { blocks: [] }
      if (args.valence === 'negative') return { blocks: [{ content: 'Old wound.', document: 'D6', documentId: 'd6', blockId: 'x', importance: 3 }] }
      if (args.valence) return { blocks: [{ content: 'Fading.', document: 'Fresh', documentId: 'fresh', blockId: 'f', importance: 2 }] }
      return { blocks: [{ content: 'Top.', document: 'T', documentId: 'd1', blockId: 'y', importance: 4.5 }] }
    }, 'g', context({ documents }))
    expect(life.verse).toEqual([])
    expect(life.complete).toBe(false)
    expect(life.important.map(b => b.text)).toEqual(['Top.'])
    // d1's block is shown as important; 'fresh' is the recent card, so the
    // past card skips it too and comes from d6.
    expect(life.remember).toMatchObject([
      { kind: 'recent', documentId: 'fresh', quote: 'Fading.' },
      { kind: 'past', documentId: 'd6', quote: 'Old wound.' },
    ])
    expect(calls.filter(args => !args.documentId)).toEqual([
      { graphId: 'g', limit: 20 },
      { graphId: 'g', limit: 20, valence: 'positive' },
      { graphId: 'g', limit: 20, valence: 'negative' },
      { graphId: 'g', limit: 100 },
    ])
  })

  it("shows the person's own rating: combined values replace the agents' numbers", async () => {
    // She rated b1 herself (5, +3); no agent did, so get_important_blocks says 0 / 0.
    const top = [
      { content: 'Agent rated.', document: 'D0', documentId: 'd0', blockId: 'b0', importance: 2.3, valence: 1.6 },
      { content: 'She rated.', document: 'D1', documentId: 'd1', blockId: 'b1', importance: 0, valence: 0 },
    ]
    const life = await loadHomeLife(async (name, args) => {
      if (name === 'music') return { verses: [] }
      if (name === 'get_block_values') return { blocks: [
        { blockId: 'b0', combined_importance: 2.3, combined_valence: 1.6 },
        { blockId: 'b1', combined_importance: 2.585, combined_valence: 2 },
      ] }
      return args.valence || args.documentId ? { blocks: [] } : { blocks: top }
    }, 'g', context())
    expect(life.important.map(b => [b.blockId, b.importance, b.valence])).toEqual([['b0', 2.3, 1.6], ['b1', 2.585, 2]])
    expect(life.complete).toBe(true)
  })

  it('asks a card for its own values when the graph-wide read missed it, and keeps the old numbers when that fails', async () => {
    const top = [
      { content: 'Missed.', document: 'D0', documentId: 'd0', blockId: 'b0', importance: 0, valence: 0 },
      { content: 'Refused.', document: 'D1', documentId: 'd1', blockId: 'b1', importance: 1, valence: -1 },
    ]
    const life = await loadHomeLife(async (name, args) => {
      if (name === 'music') return { verses: [] }
      if (name === 'get_block_values') {
        if (!args.blockId) return { blocks: [] }
        if (args.blockId === 'b1') throw new Error('refused')
        return { blocks: [{ block_id: 'b0', combinedImportance: 3, combinedValence: -2 }] }
      }
      return args.valence || args.documentId ? { blocks: [] } : { blocks: top }
    }, 'g', context())
    expect(life.important.map(b => [b.blockId, b.importance, b.valence])).toEqual([['b0', 3, -2], ['b1', 1, -1]])
    expect(life.complete).toBe(true)
  })

  it('leaves out a block nobody rated, which ranks only by its baseline score', async () => {
    const top = [
      { content: 'Rated.', document: 'D0', documentId: 'd0', blockId: 'b0', importance: 2, valence: 1 },
      { content: 'Unrated.', document: 'D1', documentId: 'd1', blockId: 'b1', importance: 0, valence: 0 },
      { content: 'Forgotten.', document: 'D2', documentId: 'd2', blockId: 'b2', importance: 0, valence: 0 },
    ]
    const life = await loadHomeLife(async (name, args) => {
      if (name === 'music') return { verses: [] }
      if (name === 'get_block_values') {
        // The node's baseline row for an unvalued block: cumulative values only.
        if (args.blockId === 'b2') return { blocks: [{ blockId: 'b2', cumulative_importance: 0, cumulative_valence: 0, user_importance: null, user_valence: null, composite_score: 0.197 }] }
        if (args.blockId) return { blocks: [] }
        return { blocks: [
          { blockId: 'b0', combined_importance: 2, combined_valence: 1 },
          { blockId: 'b1', combined_importance: 0, combined_valence: 0 },
        ] }
      }
      return args.valence || args.documentId ? { blocks: [] } : { blocks: top }
    }, 'g', context())
    expect(life.important.map(block => block.blockId)).toEqual(['b0'])
  })

  it("leaves out the node's generated views, whose quotes copy real blocks without their ratings", async () => {
    const top = [
      { content: 'Real.', document: 'Notes', documentId: 'notes', blockId: 'b0', importance: 2 },
      { content: 'Real.', document: 'What Has Become Important', documentId: 'geist-important-blocks', blockId: 'importance-0-quote', importance: 0 },
      { content: 'Dreamt.', document: 'Dream Journal', documentId: 'g-dream-journal', blockId: 'd', importance: 0 },
    ]
    const life = await loadHomeLife(async (name, args) => {
      if (name === 'music') return { verses: [] }
      return args.valence || args.documentId ? { blocks: [] } : { blocks: top }
    }, 'g', context())
    expect(life.important.map(block => block.documentId)).toEqual(['notes'])
  })

  it('shows 6 important blocks in the Song\'s place, when asked for 6', async () => {
    const top = Array.from({ length: 8 }, (_, i) => ({ content: `B${i}.`, document: `D${i}`, documentId: `d${i}`, blockId: `b${i}`, importance: 5 - i / 10 }))
    const life = await loadHomeLife(async (name, args) => {
      if (name === 'music') return { verses: [] }
      return args.valence || args.documentId ? { blocks: [] } : { blocks: top }
    }, 'g', context(), { importantCount: 6 })
    expect(life.important.map(block => block.documentId)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5'])
    expect(life.remember.map(item => item.documentId)).not.toContain('d5')
  })
})
