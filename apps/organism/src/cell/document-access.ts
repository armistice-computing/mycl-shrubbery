/**
 * document-access.ts — who is allowed to edit this document, according to the cell.
 *
 * ━━ WHY THIS IS NOT READ FROM THE SIDEBAR ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * The sidebar loads through SPARQL and can see `doc:readOnly`. That predicate is
 * not sufficient and using it alone produced a real failure: `readOnly` is the
 * mutable WORKSPACE FLAG, and `make_document_editable` clears it. So a
 * server-owned Geist view looked identical to an ordinary imported document, the
 * app offered Make Editable on the Song, the flag cleared, typing was accepted,
 * and every save was refused by the backend. Nothing was lost — gardend's
 * enforcement held — but it appeared to work, which is worse than a disabled
 * button and much worse than an error.
 *
 * gardend now answers the real question. Per garden
 * `docs/workspace-derived-access.md`, every document surface carries three
 * fields describing EFFECTIVE access:
 *
 *     readOnly       effective, not the raw workspace flag
 *     derived        server-owned view, from registration/capabilities
 *     readOnlyOwner  'geist' for Song/archive views, null otherwise
 *
 * A stale `false` workspace flag still reports `readOnly: true, derived: true`.
 * A forged `derived` on an ordinary document cannot claim ownership. Ownership
 * is never inferred from a document id — the live Song is `geist-song`, while
 * the ids named in the original design note (`geist-song-native`) turned out to
 * be the import-era ones, so an id match would have silently matched nothing.
 *
 * ━━ WHY read_document AND NOT get_workspace ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * `derived` is computed, not a projection triple, so it cannot reach the
 * SPARQL path the sidebar already uses. It rides document surfaces instead —
 * and only documents actually OPEN in a pane need it, not every sidebar row.
 *
 * `format: 'markdown', maxChars: 1` is the cheap envelope: markdown is
 * paginated, so the body clips to nothing while the envelope arrives whole,
 * roughly a kilobyte regardless of how long the document is. The same trick the
 * Chronicle reader uses, for the same reason.
 */

export interface DocumentAccessFacts {
  readonly readOnly: boolean
  readonly derived: boolean
  readonly readOnlyOwner: string | null
}

export const OPEN_ACCESS: DocumentAccessFacts = {
  readOnly: false,
  derived: false,
  readOnlyOwner: null,
}

export type AccessCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Parse the three fields out of a document envelope.
 *
 * ABSENT IS NOT FALSE for `readOnly` when the cell predates these fields — but
 * it is treated as false here deliberately, because the alternative is
 * locking every document on an older cell. The backend refuses writes either
 * way; the cost of guessing wrong in this direction is a button that fails,
 * and the cost of guessing wrong in the other is an app that edits nothing.
 */
export function parseDocumentAccess(payload: unknown): DocumentAccessFacts {
  const record = asRecord(payload)
  if (!record) return OPEN_ACCESS
  const owner = record.readOnlyOwner
  return {
    readOnly: record.readOnly === true,
    derived: record.derived === true,
    readOnlyOwner: typeof owner === 'string' && owner ? owner : null,
  }
}

/**
 * Ask the cell about one document. Resolves to OPEN_ACCESS on any failure:
 * a missing answer must not silently freeze a document the user can edit.
 */
export async function loadDocumentAccess(
  call: AccessCaller,
  graphId: string,
  documentId: string,
): Promise<DocumentAccessFacts> {
  if (!graphId || !documentId) return OPEN_ACCESS
  try {
    const payload = await call('read_document', {
      graphId,
      documentId,
      format: 'markdown',
      maxChars: 1,
    })
    return parseDocumentAccess(payload)
  } catch {
    return OPEN_ACCESS
  }
}
