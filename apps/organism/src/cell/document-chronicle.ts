/**
 * document-chronicle.ts — who made this document, who has touched it since, and
 * whether anyone wrote past what they had last read.
 *
 * The Chronicle (garden 1c3b240, design doc `settlement-chronicle-design-2026-08-26`
 * Parts 2-3) is the cell's authorship record. gardend always kept
 * `created_at` / `updated_at` / `revision` on a `DocumentRecord`; the Chronicle
 * added the PRINCIPAL behind each of those, an honest clock across archive
 * import, and a trail of writes that overrode the staleness guard.
 *
 * ── WHY THIS IS AN MCP READ AND NOT A SPARQL ONE ────────────────────────────
 * The obvious route is RDF: `document_storage_metadata_triples`
 * (document_meaningful_object.rs:341-424) emits `createdBy` / `updatedBy` /
 * `revision` on the bare document subject, and the Chronicle commit message says
 * so. Measured on 2026-09-06 against a gardend built from 85461b2, those triples
 * ARE NOT IN THE STORE — a freshly created-and-written document carries only
 * `doc:createdAt` / `doc:updatedAt` / `doc:order` / `doc:section` /
 * `doc:readOnly` / `dcterms:title` / `rdf:type` in the workspace projection, and
 * nothing under `https://mnemosyne.local/ns#` in any named graph.
 * `apps/organism/scripts/chronicle-graph-probe.mts` is that measurement; it
 * prints every triple on the subject, so the empty answer is not an artifact of
 * a wrong GRAPH clause. A SPARQL chronicle reader therefore compiles, runs, and
 * quietly reports that nobody has ever touched anything — which is worse than no
 * feature, because it looks like one.
 *
 * ── WHY read_document, AND WHY IT IS CHEAP ──────────────────────────────────
 * Three surfaces carry chronicle fields. `get_workspace` entries have
 * updatedAt/revision/updatedBy but no `createdBy`; `list_documents` has both
 * principals but reads EVERY document in the graph cold and pages at 100 — the
 * wrong shape for one selected document in a 1,000-document graph. Only
 * `read_document` carries the whole thing: `recentAuthors`, `createdAtSource`,
 * and the forced-write trail exist on no other surface.
 *
 * Its cost is bounded, which is the part worth knowing: `format: 'markdown'` is
 * paginated, so `maxChars: 1` returns the full chronicle envelope with the body
 * clipped away — ~1KB regardless of how long the document is. (`format:
 * 'ids_only'` is smaller still and carries NO chronicle at all, so it is not the
 * cheaper option; it is a different answer.) Measured by
 * `apps/organism/scripts/chronicle-surface-probe.mts`.
 *
 * ── WHAT ABSENCE MEANS ──────────────────────────────────────────────────────
 * `null` from the reader means no record answered — a hosted deployment, or a
 * document this cell does not have. A chronicle whose `createdBy` is null means
 * the record answered and does NOT KNOW: documents written before 1c3b240 read
 * back exactly that way, and the cell's own rule is that an unknown creator is
 * never guessed. Render "unknown", or render nothing. Never fill it in.
 */

/** Who performed a write (document_chronicle.rs:53-96). */
export interface ChronicleActor {
  /** `human`, `agent`, `system` — or '' when the label had no separator. */
  readonly kind: string
  /** The principal within that kind: `owner`, an agent's token label, a system path. */
  readonly name: string
  /** How the principal was established (`master-token`, `client-token:<id>`), when known. */
  readonly via: string | null
  /** The raw `kind:name` the cell recorded. */
  readonly label: string
}

/** One author's run of writes, as the record keeps it (cap 8, most recent first). */
export interface ChronicleAuthorEntry {
  readonly actor: ChronicleActor
  readonly firstAt: number | null
  readonly lastAt: number | null
  readonly lastRevision: number | null
  readonly writes: number
}

export interface DocumentChronicle {
  readonly title: string | null
  readonly createdAt: number | null
  readonly updatedAt: number | null
  readonly revision: number | null
  readonly createdBy: ChronicleActor | null
  readonly updatedBy: ChronicleActor | null
  readonly recentAuthors: readonly ChronicleAuthorEntry[]
  /**
   * How `createdAt` was arrived at: `archive-chronicle` (the archive knew),
   * `archive-catalog` (inferred from the catalog), `import` (the import instant,
   * i.e. a guess). Null on documents born here. This is the honesty flag — a
   * `createdAt` sourced from `import` is a birthday the machine made up.
   */
  readonly createdAtSource: string | null
  /** The staleness-guard override trail. `forcedWrites` is 0 on a clean document. */
  readonly lastForcedAt: number | null
  readonly lastForcedBy: ChronicleActor | null
  readonly forcedWrites: number
}

export interface DocumentChronicleReader {
  load(graphId: string, documentId: string): Promise<DocumentChronicle | null>
}

type McpCaller = (name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Epoch-millisecond decimal strings, the cell's one clock format (clock.rs:3-12).
 * The numeric and ISO branches are tolerance, not expectation: a
 * chronicle-restored document carries whatever its archive recorded, and the
 * archive predates the convention.
 */
export function parseChronicleTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = text(value)
  if (!raw) return null
  if (/^\d+$/.test(raw)) {
    const millis = Number(raw)
    return Number.isFinite(millis) ? millis : null
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

function parseCount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = text(value)
  if (!raw || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

/**
 * Actors arrive either as the object form (`{kind, name, via, label}`) or as the
 * flat `kind:name` string, depending on which field of the envelope you read —
 * `read_document` returns both. Both are accepted, and a label with no separator
 * keeps its whole text as `name` rather than being dropped: provenance is never
 * a reason to fail a read, and a label we cannot decompose is still evidence.
 */
export function parseChronicleActor(value: unknown): ChronicleActor | null {
  const object = record(value)
  if (object) {
    const label = text(object.label)
    const kind = text(object.kind)
    const name = text(object.name)
    if (!label && !name) return null
    return {
      kind: kind ?? '',
      name: name ?? label ?? '',
      via: text(object.via),
      label: label ?? [kind, name].filter(Boolean).join(':'),
    }
  }
  const label = text(value)
  if (!label) return null
  const split = label.indexOf(':')
  if (split <= 0 || split === label.length - 1) return { kind: '', name: label, via: null, label }
  return { kind: label.slice(0, split), name: label.slice(split + 1), via: null, label }
}

function parseAuthorEntry(value: unknown): ChronicleAuthorEntry | null {
  const entry = record(value)
  if (!entry) return null
  const actor = parseChronicleActor(entry.actor ?? entry.label)
  if (!actor) return null
  return {
    actor,
    firstAt: parseChronicleTimestamp(entry.firstAt ?? entry.first_at),
    lastAt: parseChronicleTimestamp(entry.lastAt ?? entry.last_at),
    lastRevision: parseCount(entry.lastRevision ?? entry.last_revision),
    writes: parseCount(entry.writes) ?? 0,
  }
}

/** Parse a `read_document` envelope into a chronicle. Null when it carries none. */
export function parseDocumentChronicle(value: unknown): DocumentChronicle | null {
  const envelope = record(value)
  if (!envelope) return null
  const chronicle = record(envelope.chronicle)
  // The flat fields and the nested block are the same facts twice over; either
  // one appearing is enough to say the cell answered. A hosted gateway sends
  // neither, and that is the null case.
  const hasAny =
    chronicle !== null ||
    envelope.createdBy !== undefined ||
    envelope.created_by !== undefined ||
    envelope.revision !== undefined
  if (!hasAny) return null

  const authors = chronicle?.recentAuthors ?? chronicle?.recent_authors
  return {
    title: text(envelope.title),
    createdAt: parseChronicleTimestamp(envelope.createdAt ?? envelope.created_at),
    updatedAt: parseChronicleTimestamp(envelope.updatedAt ?? envelope.updated_at),
    revision: parseCount(envelope.revision),
    // Prefer the nested block: it carries `via`, which the flat string drops.
    createdBy: parseChronicleActor(
      chronicle?.createdBy ?? chronicle?.created_by ?? envelope.createdBy ?? envelope.created_by,
    ),
    updatedBy: parseChronicleActor(
      chronicle?.updatedBy ?? chronicle?.updated_by ?? envelope.updatedBy ?? envelope.updated_by,
    ),
    recentAuthors: Array.isArray(authors)
      ? authors.map(parseAuthorEntry).filter((entry): entry is ChronicleAuthorEntry => entry !== null)
      : [],
    createdAtSource: text(chronicle?.createdAtSource ?? chronicle?.created_at_source),
    lastForcedAt: parseChronicleTimestamp(chronicle?.lastForcedAt ?? chronicle?.last_forced_at),
    lastForcedBy: parseChronicleActor(chronicle?.lastForcedBy ?? chronicle?.last_forced_by),
    forcedWrites: parseCount(chronicle?.forcedWrites ?? chronicle?.forced_writes) ?? 0,
  }
}

/**
 * `maxChars: 1` is the whole trick — see the header. Do not "simplify" it away
 * by dropping the argument; on a long document that turns a 1KB metadata read
 * into a full-text one, on every selection change.
 */
export function makeDocumentChronicleReader(callTool: McpCaller): DocumentChronicleReader {
  return {
    async load(graphId: string, documentId: string): Promise<DocumentChronicle | null> {
      if (!graphId || !documentId) return null
      const value = await callTool('read_document', {
        graphId,
        documentId,
        format: 'markdown',
        maxChars: 1,
      })
      return parseDocumentChronicle(value)
    },
  }
}
