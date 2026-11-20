/**
 * sparql-terms.ts — the cell's term-construction + literal-escaping vocabulary, mirrored
 * host-side so the EditorServices adapters build SPARQL the cell will accept.
 *
 * Every function here is a faithful TS mirror of a Rust function in the cell, cited per
 * function. These are the GROUND-TRUTH term shapes — the wire materializer and the
 * workspace store materializer use them, so an adapter that wants its INSERT/DELETE to be
 * a first-class, re-materialization-safe quad MUST mint identical terms.
 *
 * ISLAND NOTE: editor-services/ subdir — outside the non-recursive island scan.
 */

/**
 * WIRE_NS = http://mnemosyne.ai/vocab# (runtime_config.rs:9) — the namespace WIRES
 * are minted in.
 *
 * CAUTION, and the reason this comment is longer than the constant: the cell
 * declares THREE namespaces and the one it actually names `MNEMO_NS` is NOT this
 * one. runtime_config.rs:7-9 is
 *
 *   MNEMO_NS = https://mnemosyne.local/ns#   ← storage metadata + the Chronicle
 *   MDOC_NS  = http://mnemosyne.dev/doc#     ← document structure
 *   WIRE_NS  = http://mnemosyne.ai/vocab#    ← wires (this constant)
 *
 * An earlier version of this line called WIRE_NS "the `mnemo:` namespace", which
 * is how a chronicle query written against it returns zero rows and reads as "the
 * cell isn't recording authorship." Bind the prefix you mean: {@link LOCAL_NS}.
 */
export const WIRE_NS = 'http://mnemosyne.ai/vocab#'
/**
 * LOCAL_NS = https://mnemosyne.local/ns# (runtime_config.rs:7, the cell's own
 * `MNEMO_NS`). The namespace of the DURABLE-STORE facts about a document —
 * `graphId`, `origin`, `localPath`, `schemaVersion`, and the Chronicle's
 * `createdAt` / `updatedAt` / `revision` / `createdBy` / `updatedBy`
 * (`document_storage_metadata_triples`, document_meaningful_object.rs:341-424).
 *
 * READ THIS BEFORE YOU WRITE THAT QUERY. Those triples are EMITTED by the
 * storage-metadata face and, as of 2026-09-06, are NOT IN THE STORE: on a
 * freshly created-and-written document the bare document subject carries
 * `doc:createdAt` / `doc:updatedAt` / `doc:order` / `doc:section` /
 * `doc:readOnly` / `dcterms:title` / `rdf:type` in the WORKSPACE projection and
 * nothing at all under this namespace — no `createdBy`, no `updatedBy`, no
 * `revision`, in any named graph. Measured against a gardend built from
 * 85461b2 by `apps/organism/scripts/chronicle-graph-probe.mts`, which prints
 * every triple on the subject so the result cannot be an artifact of a wrong
 * GRAPH clause. (Not tested after a full reindex: `reindex_graph` no-ops on a
 * node with no embedding model prepared.)
 *
 * The Chronicle itself is real and complete — it lives on the DocumentRecord and
 * comes back from `read_document`. It is only the RDF projection of it that is
 * missing, which means a SPARQL chronicle reader compiles, runs, and silently
 * answers "nobody, ever". Use the record.
 */
export const LOCAL_NS = 'https://mnemosyne.local/ns#'
/** XSD_NS = http://www.w3.org/2001/XMLSchema# (runtime_config.rs:12). */
export const XSD_NS = 'http://www.w3.org/2001/XMLSchema#'
/** RDF type predicate. */
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

/** graph_subject(graphId) = urn:mnemosyne:local:graph:{graphId} (rdf.rs:122-124). */
export function graphSubject(graphId: string): string {
  return `urn:mnemosyne:local:graph:${graphId}`
}

/**
 * workspace_projection_graph_iri(graphId) = {graph_subject}:projection:workspace
 * (rdf_authority.rs:7-9). The ONE named graph docs AND wires materialize into — the
 * graph EVERY adapter SELECT/INSERT/DELETE must be scoped to.
 */
export function workspaceProjectionGraphIri(graphId: string): string {
  return `${graphSubject(graphId)}:projection:workspace`
}

/**
 * document_projection_graph_iri(graphId, documentId) =
 * {graph_subject}:projection:document:{documentId} (rdf_authority.rs:11-16).
 *
 * The PER-DOCUMENT named graph. Distinct from the workspace projection: the doc
 * list, titles and wires live in {@link workspaceProjectionGraphIri}, while a
 * document's OWN storage-metadata and content faces materialize here
 * (document_meaningful_object.rs:304).
 */
export function documentProjectionGraphIri(graphId: string, documentId: string): string {
  return `${graphSubject(graphId)}:projection:document:${documentId}`
}

/** document_subject(id) = urn:mnemosyne:local:document:{id} (rdf.rs:126-128). */
export function documentSubject(documentId: string): string {
  return `urn:mnemosyne:local:document:${documentId}`
}

/**
 * document_ref_uri(id) (rdf_workspace_terms.rs:39-45): pass already-URN'd ids through;
 * else wrap a bare id as document_subject.
 */
export function documentRefUri(documentId: string): string {
  return documentId.startsWith('urn:mnemosyne:') ? documentId : documentSubject(documentId)
}

/**
 * block_ref_uri(documentId, blockId) (rdf_workspace_terms.rs:47-53): pass an already-
 * "#block-"-anchored URN through; else "{document_ref_uri}#block-{blockId}".
 */
export function blockRefUri(documentId: string, blockId: string): string {
  if (blockId.startsWith('urn:mnemosyne:') && blockId.includes('#block-')) return blockId
  return `${documentRefUri(documentId)}#block-${blockId}`
}

/**
 * wire_ref_uri(graphId, wireId) (rdf_workspace_terms.rs:31-37): pass an already-URN'd
 * wireId through; else workspace_entity_subject(graphId,"wire",wireId).
 */
export function wireRefUri(graphId: string, wireId: string): string {
  return wireId.startsWith('urn:mnemosyne:')
    ? wireId
    : `urn:mnemosyne:local:graph:${graphId}:wire:${wireId}`
}

/**
 * wire_predicate_uri(predicate) (rdf_workspace_terms.rs:66-75): absolute (http/https/urn)
 * → as-is; bare name → {WIRE_NS}{name}.
 */
export function wirePredicateUri(predicate: string): string {
  return predicate.startsWith('http://') ||
    predicate.startsWith('https://') ||
    predicate.startsWith('urn:')
    ? predicate
    : `${WIRE_NS}${predicate}`
}

/**
 * sparql_string_literal(value) (rdf.rs:130-138): escape \ , " , \n, \r, \t and wrap in
 * double quotes. ALL FIVE escapes — the prior host version missed \r and \t.
 *
 * Order matters: the backslash escape MUST run first (else it would double-escape the
 * backslashes introduced by the later replacements).
 */
export function escapeLiteral(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}
