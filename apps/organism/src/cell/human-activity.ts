/**
 * The owner's last-opened record, kept by gardend (garden cb51242):
 *
 *   POST /activity/{graph}/opened   {"documentId"} → {ok, recorded}
 *   GET  /activity/{graph}/recent?limit=N → {graphId, documents: [{documentId,
 *        title|null, lastOpenedAt (epoch ms), openCount}]}, newest first
 *
 * Both routes are owner-only, so an agent reading a document never counts as
 * the human opening it. A repeat open within 30 s is coalesced server-side.
 *
 * A gardend older than cb51242 has neither route (404). The client then
 * stops asking about that graph for the rest of the session, and Home keeps
 * its local list. The flag is per graph because gardend also answers 404 for
 * a graph it does not know.
 */

import { cellRequestHeaders, graphCellUrl } from './rest-helpers.js'
import type { CellContract } from './session-store.js'

export interface HumanRecentDocument {
  readonly documentId: string
  /** Epoch milliseconds. */
  readonly lastOpenedAt: number
  readonly openCount: number
}

/** Parse a /recent answer; rows without an id or a usable time are dropped. */
export function parseHumanRecent(value: unknown): HumanRecentDocument[] {
  const documents = (value as { documents?: unknown } | null)?.documents
  if (!Array.isArray(documents)) return []
  const rows: HumanRecentDocument[] = []
  for (const candidate of documents) {
    if (!candidate || typeof candidate !== 'object') continue
    const row = candidate as Record<string, unknown>
    const documentId = typeof row.documentId === 'string' ? row.documentId.trim() : ''
    const lastOpenedAt = typeof row.lastOpenedAt === 'number' && Number.isFinite(row.lastOpenedAt) && row.lastOpenedAt >= 0
      ? row.lastOpenedAt
      : null
    if (!documentId || lastOpenedAt === null) continue
    const openCount = typeof row.openCount === 'number' && Number.isFinite(row.openCount) ? row.openCount : 1
    rows.push({ documentId, lastOpenedAt, openCount })
  }
  return rows
}

export class HumanActivityClient {
  /** Graphs gardend answered 404 for (no activity routes): stop asking. */
  private readonly unsupported = new Set<string>()

  available(graphId: string): boolean {
    return !this.unsupported.has(graphId)
  }

  /** Record that the owner opened a document. Never throws. */
  async recordOpened(contract: CellContract, graphId: string, documentId: string): Promise<void> {
    if (!this.available(graphId)) return
    try {
      const response = await fetch(graphCellUrl(contract, graphId, `/activity/${encodeURIComponent(graphId)}/opened`), {
        method: 'POST',
        headers: { ...cellRequestHeaders(contract), 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
        cache: 'no-store',
      })
      if (response.status === 404) this.unsupported.add(graphId)
    } catch {
      // The local list already has the open; a lost post costs one entry.
    }
  }

  /** The owner's recent opens, newest first, or null when gardend cannot say. */
  async recent(contract: CellContract, graphId: string, limit = 40): Promise<HumanRecentDocument[] | null> {
    if (!this.available(graphId)) return null
    try {
      const response = await fetch(
        graphCellUrl(contract, graphId, `/activity/${encodeURIComponent(graphId)}/recent?limit=${limit}`),
        { headers: cellRequestHeaders(contract), cache: 'no-store' },
      )
      if (response.status === 404) {
        this.unsupported.add(graphId)
        return null
      }
      if (!response.ok) return null
      return parseHumanRecent(await response.json())
    } catch {
      return null
    }
  }
}
