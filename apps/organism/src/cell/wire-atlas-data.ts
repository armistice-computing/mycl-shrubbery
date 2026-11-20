import type { AtlasSnapshot, AtlasState, AtlasWire } from '@shrubbery/components'
import { isPdfAnnotationCompanionDocumentId } from './sidebar-documents.js'

export const ATLAS_ROW_LIMIT = 20_000
const DOC = 'urn:mnemosyne:local:document:'
/**
 * A file at the end of a file link shows in the atlas as a stub node with this
 * id prefix (Eschaton, 2026-11-17: the wire stays reachable after its chip is
 * deleted). It has no document to open; the shell checks the prefix.
 */
export const ATLAS_FILE_NODE_PREFIX = 'file:'

/** Accept serialized RDF terms, not unescaped fragments interpolated into queries. */
export function atlasTerm(value: unknown): string {
  if (typeof value !== 'string') return ''
  if (value.startsWith('<') && value.endsWith('>')) return value.slice(1, -1)
  if (!value.startsWith('"')) return value
  const literal = value.match(/^"(?:\\.|[^"\\])*"/)
  if (!literal) throw new Error('Malformed RDF literal in atlas result')
  return JSON.parse(literal[0]) as string
}

function iri(value: string): string {
  if (/[\s<>"{}|^`\\\x00-\x1f]/.test(value)) throw new Error('Unsafe atlas IRI')
  return `<${value}>`
}

/** One store snapshot, no per-document queries or folder edges. Never install a partial result. */
export function atlasSnapshotQuery(graphId: string): string {
  return `PREFIX doc: <http://mnemosyne.dev/doc#>
PREFIX mnemo: <http://mnemosyne.ai/vocab#>
PREFIX dcterms: <http://purl.org/dc/terms/>
SELECT ?kind ?id ?title ?source ?target ?sourceBlock ?targetBlock ?predicate ?bidirectional ?targetGraph
WHERE { GRAPH ${iri(`urn:mnemosyne:local:graph:${graphId}:projection:workspace`)} {
  { ?id a doc:TipTapDocument . BIND("document" AS ?kind)
    OPTIONAL { ?id dcterms:title ?title }
  } UNION {
    ?id a mnemo:Wire ; mnemo:sourceDocument ?source ; mnemo:targetDocument ?target .
    BIND("wire" AS ?kind)
    OPTIONAL { ?id mnemo:sourceBlock ?sourceBlock }
    OPTIONAL { ?id mnemo:targetBlock ?targetBlock }
    OPTIONAL { ?id mnemo:predicate ?predicate }
    OPTIONAL { ?id mnemo:bidirectional ?bidirectional }
    OPTIONAL { ?id mnemo:targetGraph ?targetGraph }
  } UNION {
    ?id a mnemo:Wire ; mnemo:sourceDocument ?source ; mnemo:targetArtifact ?target .
    BIND("filewire" AS ?kind)
    OPTIONAL { ?id mnemo:sourceBlock ?sourceBlock }
    OPTIONAL { ?id mnemo:predicate ?predicate }
    OPTIONAL { ?id mnemo:targetTitle ?title }
  }
} } ORDER BY ?kind ?id`
}

function documentId(term: unknown): string {
  const value = atlasTerm(term)
  if (!value.startsWith(DOC)) throw new Error('Unrecognized document reference in atlas')
  return value.slice(DOC.length)
}

function endpoint(document: unknown, block: unknown) {
  const id = documentId(document)
  const value = atlasTerm(block)
  const prefix = `${DOC}${id}#block-`
  if (value && !value.startsWith(prefix)) throw new Error('Block endpoint does not belong to its document')
  return { documentId: id, ...(value ? { blockId: value.slice(prefix.length) } : {}) }
}

function withoutPdfAnnotationCompanions<T extends AtlasSnapshot>(snapshot: T): T {
  const hidden = new Set(snapshot.documents.filter(document => isPdfAnnotationCompanionDocumentId(document.id)).map(document => document.id))
  return {
    ...snapshot,
    documents: snapshot.documents.filter(document => !isPdfAnnotationCompanionDocumentId(document.id)),
    wires: snapshot.wires.filter(wire => !hidden.has(wire.source.documentId) && !hidden.has(wire.target.documentId)),
  }
}

export function decodeAtlasSnapshot(graphId: string, value: unknown): AtlasSnapshot & { graphId: string; omittedExternalWires: number } {
  const result = value as { rows?: Record<string, unknown>[]; warnings?: string[] }
  if (!result || !Array.isArray(result.rows)) throw new Error('Atlas query returned no rows')
  if (result.rows.length >= ATLAS_ROW_LIMIT || result.warnings?.length) throw new Error(`Atlas query incomplete: ${(result.warnings ?? ['row ceiling reached']).join('; ')}`)
  const documents: AtlasSnapshot['documents'][number][] = []
  const wires: AtlasWire[] = []
  let omittedExternalWires = 0
  const fileNodes = new Set<string>()
  for (const row of result.rows) {
    if (atlasTerm(row.kind) === 'document') documents.push({ id: documentId(row.id), title: atlasTerm(row.title) || 'Untitled' })
    else if (atlasTerm(row.kind) === 'filewire') {
      const target = atlasTerm(row.target)
      const marker = ':artifact:'
      const at = target.indexOf(marker)
      if (at < 0) throw new Error('Unrecognized file reference in atlas')
      const fileNodeId = `${ATLAS_FILE_NODE_PREFIX}${target.slice(at + marker.length)}`
      if (!fileNodes.has(fileNodeId)) {
        fileNodes.add(fileNodeId)
        documents.push({ id: fileNodeId, title: `${atlasTerm(row.title) || 'File'} (file)` })
      }
      wires.push({ id: atlasTerm(row.id), source: endpoint(row.source, row.sourceBlock), target: { documentId: fileNodeId },
        predicate: atlasTerm(row.predicate) || 'relatedTo', bidirectional: false })
    }
    else if (atlasTerm(row.kind) === 'wire') {
      const targetGraph = atlasTerm(row.targetGraph)
      if (targetGraph && targetGraph !== graphId) { omittedExternalWires++; continue }
      wires.push({ id: atlasTerm(row.id), source: endpoint(row.source, row.sourceBlock), target: endpoint(row.target, row.targetBlock),
        predicate: atlasTerm(row.predicate) || 'relatedTo', bidirectional: ['true', '1'].includes(atlasTerm(row.bidirectional)) })
    } else throw new Error('Unknown atlas row kind')
  }
  return withoutPdfAnnotationCompanions({ graphId, documents, wires, omittedExternalWires })
}

/** Layout state is a disposable browser preference, never a source of graph content. */
export function decodeSavedAtlas(raw: string | null, graphId: string): AtlasState | null {
  if (!raw || raw.length > 4_000_000) return null
  try {
    const value = JSON.parse(raw)
    const s = value.state as AtlasState
    if (value.version !== 1 || value.graphId !== graphId || !s || !Array.isArray(s.snapshot?.documents) || !Array.isArray(s.snapshot?.wires)) return null
    if (typeof s.pending !== 'boolean' || ![s.addedDocuments, s.changedWires].every(n => Number.isSafeInteger(n) && n >= 0)) return null
    if (!s.positions || typeof s.positions !== 'object' || Array.isArray(s.positions)) return null
    if (s.snapshot.documents.some(d => typeof d.id !== 'string' || typeof d.title !== 'string')) return null
    if (new Set(s.snapshot.documents.map(d => d.id)).size !== s.snapshot.documents.length) return null
    if (s.snapshot.wires.some(w => typeof w.id !== 'string' || typeof w.predicate !== 'string' ||
      ![w.source, w.target].every(e => e && typeof e.documentId === 'string' && (e.blockId === undefined || typeof e.blockId === 'string')))) return null
    if (new Set(s.snapshot.wires.map(w => w.id)).size !== s.snapshot.wires.length) return null
    if (Object.values(s.positions).some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e7 || Math.abs(p.y) > 1e7)) return null
    return { ...s, snapshot: withoutPdfAnnotationCompanions(s.snapshot) }
  } catch { return null }
}

export function decodeSavedAtlasView(raw: string | null, graphId: string): { zoom: number; left: number; top: number; centerOnSelect?: boolean; showPredicates?: boolean } | undefined {
  if (!raw || raw.length > 4_000_000) return undefined
  try {
    const data = JSON.parse(raw), v = data.view
    if (data.graphId !== graphId || data.version !== 1 || !v) return undefined
    if (typeof v.zoom !== 'number' || !Number.isFinite(v.zoom) || v.zoom < .04 || v.zoom > 2) return undefined
    if (![v.left, v.top].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1e8)) return undefined
    if (v.centerOnSelect !== undefined && typeof v.centerOnSelect !== 'boolean') return undefined
    if (v.showPredicates !== undefined && typeof v.showPredicates !== 'boolean') return undefined
    return { zoom: v.zoom, left: v.left, top: v.top, ...(v.centerOnSelect !== undefined ? { centerOnSelect: v.centerOnSelect } : {}), ...(v.showPredicates !== undefined ? { showPredicates: v.showPredicates } : {}) }
  } catch { return undefined }
}

export function atlasExcerptQuery(graphId: string, documentId: string, blockId?: string): string {
  const graph = iri(`urn:mnemosyne:local:graph:${graphId}:projection:document:${documentId}`)
  const subject = blockId ? `${iri(`${DOC}${documentId}#block-${blockId}`)} doc:textContent ?text .` : '?s doc:textContent ?text . OPTIONAL { ?s doc:siblingOrder ?order }'
  return `PREFIX doc: <http://mnemosyne.dev/doc#> SELECT ?text ?order WHERE { GRAPH ${graph} { ${subject} } } ORDER BY ?order LIMIT ${blockId ? 1 : 4}`
}
