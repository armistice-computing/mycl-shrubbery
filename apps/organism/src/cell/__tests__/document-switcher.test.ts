import { describe, expect, it } from 'vitest'
import { CommandRegistryImpl, type CommandContext } from '@shrubbery/nucleus'
import type { SidebarSection } from '@shrubbery/runtime'
import {
  documentSwitcherBlockItemsFromRows,
  documentSwitcherBlocksSparql,
  documentSwitcherActionRows,
  documentSwitcherDocumentsFromSidebar,
  documentSwitcherItems,
  loadDocumentSwitcherSalience,
  loadDocumentSwitcherBlocks,
  reciprocalRankFuseDocumentSwitcherBlocks,
  withDocumentSwitcherSalienceNudge,
} from '../document-switcher.js'
import type { MnDocumentSwitcherBlockItem } from '@shrubbery/components'

const ctx: CommandContext = {
  selection: null,
  graphId: 'graph-a',
  documentId: 'doc-open',
  rightPanelMode: 'none',
  posture: 'application',
}

const sections: SidebarSection[] = [
  {
    id: 'documents',
    label: 'Documents',
    nodes: [
      {
        id: 'folder-research',
        label: 'Research',
        kind: 'folder',
        children: [
          { id: 'doc-alpha', label: 'Alpha Notes', kind: 'document' },
          {
            id: 'folder-deep',
            label: 'Deep',
            kind: 'folder',
            children: [{ id: 'doc-beta', label: 'Beta Plan', kind: 'document' }],
          },
        ],
      },
      { id: 'doc-root', label: 'Root Doc', kind: 'document' },
    ],
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    nodes: [{ id: 'artifact-a', label: 'Image', kind: 'artifact' }],
  },
]

describe('document switcher shell projection', () => {
  it('flattens sidebar document rows with graph ids and folder paths', () => {
    expect(documentSwitcherDocumentsFromSidebar(sections, 'graph-a')).toEqual([
      {
        kind: 'document',
        id: 'doc-alpha',
        documentId: 'doc-alpha',
        graphId: 'graph-a',
        label: 'Alpha Notes',
        path: 'Research',
        readOnly: false,
      },
      {
        kind: 'document',
        id: 'doc-beta',
        documentId: 'doc-beta',
        graphId: 'graph-a',
        label: 'Beta Plan',
        path: 'Research / Deep',
        readOnly: false,
      },
      {
        kind: 'document',
        id: 'doc-root',
        documentId: 'doc-root',
        graphId: 'graph-a',
        label: 'Root Doc',
        path: null,
        readOnly: false,
      },
    ])
  })

  it('filters and sorts document switcher items without inventing block rows synchronously', () => {
    const docs = documentSwitcherDocumentsFromSidebar(sections, 'graph-a')

    expect(documentSwitcherItems(docs, 'plan', 'all', 'smart').map((item) => item.id)).toEqual(['doc-beta'])
    expect(documentSwitcherItems(docs, 'research', 'documents', 'smart').map((item) => item.id)).toEqual([
      'doc-alpha',
      'doc-beta',
    ])
    expect(documentSwitcherItems(docs, 'alpha notes', 'all', 'exact').map((item) => item.id)).toEqual(['doc-alpha'])
    expect(documentSwitcherItems(docs, '', 'blocks', 'smart')).toEqual([])
    expect(documentSwitcherItems(docs, '', 'actions', 'smart')).toEqual([])
  })

  it('matches a curly apostrophe in a title with a straight one typed, and the reverse', () => {
    const doc = (id: string, label: string) => ({
      kind: 'document' as const, id, documentId: id, graphId: 'graph-a', label, path: null, readOnly: false,
    })
    const docs = [doc('doc-curly', 'what’s next for Mycl'), doc('doc-straight', "What's here")]
    expect(documentSwitcherItems(docs, "what's next", 'all', 'smart').map((item) => item.id)).toEqual(['doc-curly'])
    expect(documentSwitcherItems(docs, 'what’s here', 'all', 'smart').map((item) => item.id)).toEqual(['doc-straight'])
  })

  it('orders an empty query by last opened, then newest created; A-Z and typed queries ignore recency', () => {
    const docs = documentSwitcherDocumentsFromSidebar(sections, 'graph-a')
    const recency = {
      openedIds: ['doc-beta'],
      createdAt: new Map([['doc-alpha', 10], ['doc-root', 20]]),
    }
    expect(documentSwitcherItems(docs, '', 'all', 'smart', recency).map((item) => item.id))
      .toEqual(['doc-beta', 'doc-root', 'doc-alpha'])
    expect(documentSwitcherItems(docs, '', 'all', 'alphabetical', recency).map((item) => item.id))
      .toEqual(['doc-alpha', 'doc-beta', 'doc-root'])
    expect(documentSwitcherItems(docs, 'research', 'documents', 'smart', recency).map((item) => item.id))
      .toEqual(['doc-alpha', 'doc-beta'])
    // Without recency (no record yet), the empty query stays A-Z.
    expect(documentSwitcherItems(docs, '', 'all', 'smart').map((item) => item.id))
      .toEqual(['doc-alpha', 'doc-beta', 'doc-root'])
  })

  it('projects graph-scoped block rows into switcher block items', async () => {
    const rows = [
      {
        block: '<urn:mnemosyne:local:document:doc-beta#block-block-plan>',
        docId: '"doc-beta"',
        blockId: '"block-plan"',
        text: '"Launch plan and invoice workflow"',
        type: '<http://mnemosyne.dev/doc#Paragraph>',
      },
      {
        block: '<urn:mnemosyne:local:document:doc-alpha#block-block-heading>',
        docId: '"doc-alpha"',
        blockId: '"block-heading"',
        text: '"Invoice architecture"',
        type: '<http://mnemosyne.dev/doc#Heading>',
      },
    ]
    const titles = new Map([
      ['doc-alpha', 'Alpha Notes'],
      ['doc-beta', 'Beta Plan'],
    ])
    const resolveTitle = (documentId: string) => titles.get(documentId) ?? null

    const projected = documentSwitcherBlockItemsFromRows(rows, 'graph-a', 'invoice', 'smart', resolveTitle)
    expect(projected.map((item) => item.id)).toEqual(['doc-alpha:block-heading', 'doc-beta:block-plan'])
    expect(projected.map((item) => item.label)).toEqual(['Alpha Notes', 'Beta Plan'])
    expect(projected.map((item) => item.path)).toEqual(['Alpha Notes / Heading', 'Beta Plan / Paragraph'])
    expect(projected.map((item) => item.matchSource)).toEqual(['lexical', 'lexical'])
    // Continuous relevance: a prefix hit at offset 0 in a short heading beats
    // a mid-paragraph substring hit — no more tier ties collapsing to a-z.
    expect(projected[0]!.score!).toBeGreaterThan(projected[1]!.score!)
    expect(projected[0]!.compositeScore).toBe(projected[0]!.score)

    const sparql = documentSwitcherBlocksSparql('graph-a', 'invoice')
    expect(sparql).toContain('urn:mnemosyne:local:graph:graph-a:projection:document:')
    expect(sparql).toContain('doc:textContent')
    expect(sparql).not.toContain('projection:workspace')

    const calls: Array<{ graphId: string; sparql: string }> = []
    const loaded = await loadDocumentSwitcherBlocks(
      {
        async query(graphId, query) {
          calls.push({ graphId, sparql: query })
          return { rows }
        },
      },
      'graph-a',
      'invoice',
      'smart',
      resolveTitle,
    )
    expect(calls).toHaveLength(1)
    expect(loaded.map((item) => item.id)).toEqual(['doc-alpha:block-heading', 'doc-beta:block-plan'])

    expect(await loadDocumentSwitcherBlocks({ async query() { throw new Error('should not query') } }, 'graph-a', 'i', 'smart')).toEqual([])
  })

  it('fuses lexical and semantic ranks with RRF, nudging smart by salience', () => {
    const mk = (
      id: string,
      score: number,
      matchSource: MnDocumentSwitcherBlockItem['matchSource'] = 'lexical',
    ): MnDocumentSwitcherBlockItem => {
      const [documentId, blockId] = id.split(':') as [string, string]
      return {
        kind: 'block',
        id,
        documentId,
        blockId,
        graphId: 'graph-a',
        label: id,
        snippet: '',
        path: null,
        matchSource,
        score,
      }
    }
    const lexical = [mk('doc-a:block-b1', 90), mk('doc-b:block-b2', 80), mk('doc-c:block-b3', 70)]
    const semantic = [
      mk('doc-c:block-b3', 0.9, 'semantic'),
      mk('doc-a:block-b1', 0.8, 'semantic'),
      mk('doc-d:block-b4', 0.7, 'semantic'),
    ]

    const fused = reciprocalRankFuseDocumentSwitcherBlocks(lexical, semantic)
    // b1: lex rank 0 + sem rank 1. b3: lex rank 2 + sem rank 0. b1 wins by a hair.
    expect(fused.map((item) => item.id)).toEqual([
      'doc-a:block-b1',
      'doc-c:block-b3',
      'doc-b:block-b2',
      'doc-d:block-b4',
    ])
    expect(fused[0]!.matchSource).toBe('both')
    expect(fused[1]!.matchSource).toBe('both')
    expect(fused[2]!.matchSource).toBe('lexical')
    expect(fused[3]!.matchSource).toBe('semantic')
    expect(fused[0]!.score!).toBeCloseTo(1 / 61 + 1 / 62, 6)

    // exact: salience changes nothing.
    const nudges = new Map([['doc-c:block-b3', 1]])
    expect(withDocumentSwitcherSalienceNudge(fused, nudges, 'exact').map((item) => item.id)).toEqual(
      fused.map((item) => item.id),
    )
    // smart: the bounded nudge (capped at 0.004) lifts the valuated block above the tie.
    const smart = withDocumentSwitcherSalienceNudge(fused, nudges, 'smart')
    expect(smart[0]!.id).toBe('doc-c:block-b3')
    expect(smart[0]!.compositeScore!).toBeCloseTo(1 / 63 + 1 / 61 + 0.004, 6)
  })

  it('projects palette commands into action rows through the command registry', () => {
    const registry = new CommandRegistryImpl()
    registry.register([
      {
        id: 'panel.toggle.chat',
        label: 'Toggle Chat Panel',
        category: 'View',
        icon: 'message-circle',
        shortcut: 'Mod+Shift+C',
        keywords: ['assistant'],
        surfaces: ['palette'],
        run: () => {},
      },
      {
        id: 'document.history',
        label: 'Open Version History',
        category: 'Document',
        icon: 'clock',
        keywords: ['snapshots'],
        surfaces: ['palette'],
        run: () => {},
      },
      {
        id: 'hidden.context',
        label: 'Hidden Context Command',
        category: 'Hidden',
        surfaces: ['context'],
        run: () => {},
      },
    ])

    expect(documentSwitcherActionRows(registry, 'assistant', ctx)).toEqual([
      {
        id: 'panel.toggle.chat',
        label: 'Toggle Chat Panel',
        category: 'View',
        icon: 'message-circle',
        shortcut: 'Mod+Shift+C',
        disabled: false,
      },
    ])
    expect(documentSwitcherActionRows(registry, '', ctx).map((action) => action.id)).toEqual([
      'panel.toggle.chat',
      'document.history',
    ])
  })
})

const score = (documentId: string, blockId: string, compositeScore: number): import('@shrubbery/nucleus').BlockScore => ({
  documentId, blockId, compositeScore,
  cumulativeImportance: 100, cumulativeValence: 0,
  rawImportanceSum: 0, rawValenceSum: 0, importanceCount: 0, valenceCount: 0,
  blockWireCount: 0, docWireCount: 0, lastValuatedAt: null,
  userImportance: null, userValence: null,
})

describe('Smart composite salience', () => {
  it('reads typed backend composites, groups documents, and retains unvalued baselines and bare block ids', async () => {
    const calls: string[] = []
    const composites = await loadDocumentSwitcherSalience({
      getScores: async (graph, doc, blockIds) => {
        expect(blockIds).toEqual(['bare', 'block-b'])
        expect(graph).toBe('g')
        calls.push(doc)
        return [score(doc, 'bare', 0.3), { ...score(doc, 'block-b', 0.7), rawImportanceSum: 8, importanceCount: 2, userImportance: 3 },
          score(doc, 'not-a-candidate', 1), score('wrong-doc', 'bare', 1)]
      },
    }, 'g', [{ documentId: 'd', blockId: 'bare' }, { documentId: 'd', blockId: 'block-b' }])
    expect(calls).toEqual(['d'])
    expect([...composites]).toEqual([['d:bare', 0.3], ['d:block-b', 0.7]])
    const items: MnDocumentSwitcherBlockItem[] = ['bare', 'block-b'].map((blockId) => ({
      kind: 'block', id: `d:${blockId}`, documentId: 'd', blockId,
      label: blockId, snippet: '', score: 0.02, compositeScore: 0.02,
    }))
    const smart = withDocumentSwitcherSalienceNudge(items, composites, 'smart')
    expect(smart.map((item) => item.blockId)).toEqual(['block-b', 'bare'])
    expect(smart[0]!.compositeScore).toBeCloseTo(0.02 + 0.004 * 0.7)
    expect(withDocumentSwitcherSalienceNudge(items, composites, 'exact')).toEqual(items)
    expect(withDocumentSwitcherSalienceNudge(items, composites, 'alphabetical')).toEqual(items)
  })

  it('requests candidate ids before limiting, including forgotten and unvalued blocks below the top 1000', async () => {
    const stored = Array.from({ length: 1000 }, (_, i) => score('d', String(i), 0.9))
    stored.push(score('d', 'never-valued', 0.12), { ...score('d', 'forgotten', 0.08), userImportance: 0 })
    const composites = await loadDocumentSwitcherSalience({ getScores: async (_, doc, ids) => {
      expect(ids).toEqual(['never-valued', 'forgotten'])
      return stored.filter((block) => block.documentId === doc && (!ids || ids.includes(block.blockId))).slice(0, 1000)
    } }, 'g', [
      { documentId: 'd', blockId: 'never-valued' },
      { documentId: 'd', blockId: 'forgotten' },
    ])
    expect([...composites]).toEqual([['d:never-valued', 0.12], ['d:forgotten', 0.08]])
  })

  it('matches the MCP composite clamp and rejects nonfinite values', () => {
    const items: MnDocumentSwitcherBlockItem[] = [-1, 0, 0.5, 1, 2, NaN, Infinity].map((value, i) => ({
      kind: 'block', id: String(i), documentId: 'd', blockId: String(i),
      label: String(i), score: 0.02, compositeScore: 0.02,
    }))
    const nudges = new Map([-1, 0, 0.5, 1, 2, NaN, Infinity].map((value, i) => [String(i), value]))
    const actual = new Map(withDocumentSwitcherSalienceNudge(items, nudges, 'smart').map((item) => [item.id, item.compositeScore]))
    for (const [i, boost] of [0, 0, 0.002, 0.004, 0.004, 0, 0].entries()) {
      expect(actual.get(String(i))).toBeCloseTo(0.02 + boost)
    }
  })

  it('bounds concurrency and candidates, tolerates failures, and ignores nonfinite scores', async () => {
    let active = 0
    let peak = 0
    let calls = 0
    const candidates = Array.from({ length: 60 }, (_, i) => ({ documentId: `d${i}`, blockId: 'b' }))
    const composites = await loadDocumentSwitcherSalience({ getScores: async (_, doc) => {
      calls++
      peak = Math.max(peak, ++active)
      await new Promise((resolve) => setTimeout(resolve, 0))
      active--
      if (doc === 'd0') throw new Error('unavailable')
      return [score(doc, 'b', doc === 'd1' ? NaN : 0.4)]
    } }, 'g', candidates)
    expect(calls).toBe(40)
    expect(peak).toBe(4)
    expect(composites.size).toBe(38)
  })

  it('discards late responses and stops queued reads after the scope becomes stale', async () => {
    let stale = false
    let calls = 0
    const candidates = Array.from({ length: 10 }, (_, i) => ({ documentId: `d${i}`, blockId: 'b' }))
    const composites = await loadDocumentSwitcherSalience({ getScores: async (_, doc) => {
      calls++
      await Promise.resolve()
      stale = true
      return [score(doc, 'b', 0.9)]
    } }, 'g', candidates, () => stale)
    expect(calls).toBe(4)
    expect(composites.size).toBe(0)
    calls = 0
    await loadDocumentSwitcherSalience({ getScores: async () => { calls++; return [] } }, 'g', candidates, () => true)
    expect(calls).toBe(0)
  })
})
