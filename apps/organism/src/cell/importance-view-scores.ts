/**
 * importance-view-scores.ts — the scores of the blocks the importance view
 * quotes, read in one graph-wide query.
 *
 * The view (gardend geist_important_blocks.rs) quotes up to 30 blocks from
 * different documents, and its value controls show and change each source
 * block's rating. The per-document salience route costs ~3.5 s a document
 * (measured by Zeta, 2026-10-02), so the shell reads the cell's
 * :projection:salience graph once, for all the sources together.
 *
 * Block IRIs are `<document>#block-<block id as stored>` (gardend
 * salience_rdf_materializer.rs), with no prefix added: older imported blocks
 * have ids like `92498883`, not `block-…`.
 *
 * The composite score is computed at query time in gardend and is not in RDF,
 * so it reads 0 here, as do the wire counts. The view's own text shows each
 * composite; the controls use the ratings, sums, counts and last-valued time.
 */
import type { BlockScore } from '@shrubbery/nucleus'
import { graphSubject, sourceScoreKey } from '@shrubbery/runtime'

export interface ImportanceSource {
  readonly documentId: string
  readonly blockId: string
}

const LOCAL = 'https://mnemosyne.local/ns#'
const DOC = 'http://mnemosyne.dev/doc#'

export function blockIri(documentId: string, blockId: string): string {
  return `urn:mnemosyne:local:document:${documentId}#block-${blockId}`
}

/** Only ids gardend could have written; anything else would break the query. */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(id)
}

export function importanceSourceScoresSparql(graphId: string, sources: readonly ImportanceSource[]): string | null {
  const values = sources
    .filter(source => safeId(source.documentId) && safeId(source.blockId))
    .map(source => `<${blockIri(source.documentId, source.blockId)}>`)
  if (values.length === 0) return null
  return [
    `PREFIX local: <${LOCAL}>`,
    `PREFIX doc: <${DOC}>`,
    'SELECT ?target ?imp ?val ?rawImp ?rawVal ?impCount ?valCount ?userImp ?userVal ?last',
    'WHERE {',
    `  VALUES ?target { ${values.join(' ')} }`,
    `  GRAPH <${graphSubject(graphId)}:projection:salience> {`,
    '    ?valuation a local:BlockValuation .',
    '    ?valuation local:targetsBlock ?target .',
    '    OPTIONAL { ?valuation local:cumulativeImportance ?imp . }',
    '    OPTIONAL { ?valuation local:cumulativeValence ?val . }',
    '    OPTIONAL { ?valuation doc:userImportance ?userImp . }',
    '    OPTIONAL { ?valuation doc:userValence ?userVal . }',
    '    OPTIONAL { ?valuation local:lastValuatedAt ?last . }',
    '    OPTIONAL { ?valuation doc:rawImportanceSum ?rawImp . }',
    '    OPTIONAL { ?valuation doc:rawValenceSum ?rawVal . }',
    '    OPTIONAL { ?valuation doc:importanceCount ?impCount . }',
    '    OPTIONAL { ?valuation doc:valenceCount ?valCount . }',
    '  }',
    '}',
  ].join('\n')
}

function iri(term: string | undefined): string {
  if (!term) return ''
  return term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term
}

/** The lexical value of an N-Triples literal term, or null. */
function literal(term: string | undefined): string | null {
  if (!term || term[0] !== '"') return null
  const end = term.lastIndexOf('"')
  return end > 0 ? term.slice(1, end) : null
}

function number(term: string | undefined): number | null {
  const value = literal(term)
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function importanceSourceScoresFromRows(
  rows: readonly Record<string, string>[],
  sources: readonly ImportanceSource[],
): Map<string, BlockScore> {
  const byIri = new Map(sources.map(source => [blockIri(source.documentId, source.blockId), source]))
  const scores = new Map<string, BlockScore>()
  for (const row of rows) {
    const source = byIri.get(iri(row.target))
    if (!source) continue
    scores.set(sourceScoreKey(source.documentId, source.blockId), {
      documentId: source.documentId,
      blockId: source.blockId,
      cumulativeImportance: number(row.imp) ?? 0,
      cumulativeValence: number(row.val) ?? 0,
      rawImportanceSum: number(row.rawImp) ?? 0,
      rawValenceSum: number(row.rawVal) ?? 0,
      importanceCount: number(row.impCount) ?? 0,
      valenceCount: number(row.valCount) ?? 0,
      compositeScore: 0,
      blockWireCount: 0,
      docWireCount: 0,
      lastValuatedAt: literal(row.last),
      userImportance: number(row.userImp),
      userValence: number(row.userVal),
    })
  }
  return scores
}

export async function loadImportanceSourceScores(
  rest: { query(graphId: string, sparql: string): Promise<unknown> },
  graphId: string,
  sources: readonly ImportanceSource[],
): Promise<Map<string, BlockScore>> {
  const sparql = importanceSourceScoresSparql(graphId, sources)
  if (!sparql) return new Map()
  const result = (await rest.query(graphId, sparql)) as { rows?: Record<string, string>[] }
  return importanceSourceScoresFromRows(result.rows ?? [], sources)
}
