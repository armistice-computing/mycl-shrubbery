import { describe, expect, it } from 'vitest'
import {
  blockIri,
  importanceSourceScoresFromRows,
  importanceSourceScoresSparql,
  loadImportanceSourceScores,
} from '../importance-view-scores.js'

const sources = [
  { documentId: 'garden-design-antinomies', blockId: 'block-ea3e3474' },
  // An older imported block: its id has no "block-" prefix.
  { documentId: '44d23e7f-7143-4e3a-88f3-27323c46345a', blockId: '92498883' },
]

describe('importance view source scores', () => {
  it('names each block by its stored id, adding no prefix', () => {
    expect(blockIri('doc', 'block-a')).toBe('urn:mnemosyne:local:document:doc#block-block-a')
    expect(blockIri('doc', '92498883')).toBe('urn:mnemosyne:local:document:doc#block-92498883')
    const sparql = importanceSourceScoresSparql('default_x1', sources)!
    expect(sparql).toContain('<urn:mnemosyne:local:document:44d23e7f-7143-4e3a-88f3-27323c46345a#block-92498883>')
    expect(sparql).not.toContain('#block-block-92498883')
    expect(sparql).toContain('GRAPH <urn:mnemosyne:local:graph:default_x1:projection:salience>')
  })

  it('refuses ids that could break out of an IRI', () => {
    expect(importanceSourceScoresSparql('g', [{ documentId: 'doc>', blockId: 'x' }])).toBeNull()
    expect(importanceSourceScoresSparql('g', [])).toBeNull()
  })

  it('reads ratings, sums, counts and the last-valued time per source', () => {
    const rows = [{
      target: `<${blockIri('44d23e7f-7143-4e3a-88f3-27323c46345a', '92498883')}>`,
      imp: '"4.858"^^<http://www.w3.org/2001/XMLSchema#double>',
      val: '"4.7004"^^<http://www.w3.org/2001/XMLSchema#double>',
      rawImp: '"12"^^<http://www.w3.org/2001/XMLSchema#double>',
      impCount: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>',
      userImp: '"5"^^<http://www.w3.org/2001/XMLSchema#integer>',
      last: '"1790972107609"',
    }]
    const scores = importanceSourceScoresFromRows(rows, sources)
    const score = scores.get('44d23e7f-7143-4e3a-88f3-27323c46345a:92498883')!
    expect(score.blockId).toBe('92498883')
    expect(score.cumulativeImportance).toBeCloseTo(4.858)
    expect(score.rawImportanceSum).toBe(12)
    expect(score.importanceCount).toBe(3)
    expect(score.userImportance).toBe(5)
    expect(score.userValence).toBeNull()
    expect(score.lastValuatedAt).toBe('1790972107609')
    expect(scores.has('garden-design-antinomies:block-ea3e3474')).toBe(false)
  })

  it('reads all sources in one query', async () => {
    const calls: string[] = []
    const rest = { query: async (_graphId: string, sparql: string) => { calls.push(sparql); return { rows: [] } } }
    await loadImportanceSourceScores(rest, 'default_x1', sources)
    expect(calls).toHaveLength(1)
  })
})
