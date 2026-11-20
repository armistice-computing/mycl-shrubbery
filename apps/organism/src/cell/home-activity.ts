/** Graph-scoped home activity persisted by the shell, never inferred by components. */

import type { WorkspaceHomeDocument, WorkspaceHomeOptions } from '@shrubbery/runtime'

export interface HomeDocumentSource {
  readonly id: string
  readonly title: string
  readonly readOnly?: boolean
  /** Authoritative projected creation time, as epoch milliseconds. */
  readonly createdAt?: number
  /** The last write to the document, by anyone, as epoch milliseconds. */
  readonly updatedAt?: number
  /** The folder holding it; null when it sits at the top level (unfiled). */
  readonly folder?: string | null
}

interface TimedDocumentRef {
  readonly documentId: string
  readonly timestamp: number
}

interface GraphActivity {
  readonly pinned: readonly string[]
  readonly recent: readonly TimedDocumentRef[]
  readonly created: readonly TimedDocumentRef[]
  readonly lastOpened: TimedDocumentRef | null
}

interface StoredActivity {
  readonly version: 1
  readonly graphs: Readonly<Record<string, GraphActivity>>
}

export interface HomeProjection extends Pick<WorkspaceHomeOptions, 'resume' | 'pinned' | 'newlyCreated' | 'recent' | 'dreamJournal'> {
  /** The documents written to most recently, by anyone (doc:updatedAt), newest first. */
  readonly recentlyUpdated: readonly WorkspaceHomeDocument[]
}

const EMPTY_GRAPH: GraphActivity = Object.freeze({ pinned: [], recent: [], created: [], lastOpened: null })
const MAX_ACTIVITY = 40

function finiteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseTimedRefs(value: unknown): TimedDocumentRef[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const rows: TimedDocumentRef[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const row = candidate as Record<string, unknown>
    const documentId = typeof row.documentId === 'string' ? row.documentId.trim() : ''
    const timestamp = finiteTimestamp(row.timestamp)
    if (!documentId || timestamp === null || seen.has(documentId)) continue
    seen.add(documentId)
    rows.push({ documentId, timestamp })
  }
  return rows.slice(0, MAX_ACTIVITY)
}

function parseGraph(value: unknown): GraphActivity {
  if (!value || typeof value !== 'object') return EMPTY_GRAPH
  const row = value as Record<string, unknown>
  const pinned = Array.isArray(row.pinned)
    ? [...new Set(row.pinned.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim()))]
    : []
  const recent = parseTimedRefs(row.recent)
  const created = parseTimedRefs(row.created)
  const last = parseTimedRefs(row.lastOpened ? [row.lastOpened] : [])[0] ?? null
  return { pinned, recent, created, lastOpened: last }
}

function parseStored(raw: string | null): StoredActivity {
  if (!raw) return { version: 1, graphs: {} }
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object') return { version: 1, graphs: {} }
    const graphsValue = (value as Record<string, unknown>).graphs
    if (!graphsValue || typeof graphsValue !== 'object' || Array.isArray(graphsValue)) return { version: 1, graphs: {} }
    const graphs: Record<string, GraphActivity> = {}
    for (const [graphId, graph] of Object.entries(graphsValue as Record<string, unknown>)) {
      if (graphId.trim()) graphs[graphId] = parseGraph(graph)
    }
    return { version: 1, graphs }
  } catch {
    return { version: 1, graphs: {} }
  }
}

export class HomeActivityStore {
  private state: StoredActivity

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    private readonly key = 'shrubbery.organism.home-activity.v1',
  ) {
    this.state = parseStored(storage?.getItem(key) ?? null)
  }

  private graph(graphId: string): GraphActivity {
    return this.state.graphs[graphId] ?? EMPTY_GRAPH
  }

  private write(graphId: string, graph: GraphActivity): void {
    this.state = { version: 1, graphs: { ...this.state.graphs, [graphId]: graph } }
    try { this.storage?.setItem(this.key, JSON.stringify(this.state)) } catch { /* persistence is best effort */ }
  }

  markOpened(graphId: string, documentId: string, timestamp = Date.now()): void {
    const graph = this.graph(graphId)
    const ref = { documentId, timestamp }
    this.write(graphId, {
      ...graph,
      recent: [ref, ...graph.recent.filter(item => item.documentId !== documentId)].slice(0, MAX_ACTIVITY),
      lastOpened: ref,
    })
  }

  /**
   * Merge gardend's last-opened record (newest first) into this graph's
   * recent list. gardend's record outlives this browser's storage, so it
   * fills the list; a local open newer than gardend's copy (its post still in
   * flight) keeps its place. Returns whether anything changed.
   */
  adoptRecent(graphId: string, rows: readonly { readonly documentId: string; readonly lastOpenedAt: number }[]): boolean {
    const graph = this.graph(graphId)
    const newest = new Map<string, number>()
    for (const item of [...graph.recent, ...rows.map(row => ({ documentId: row.documentId, timestamp: row.lastOpenedAt }))]) {
      newest.set(item.documentId, Math.max(newest.get(item.documentId) ?? 0, item.timestamp))
    }
    const recent = [...newest.entries()]
      .map(([documentId, timestamp]) => ({ documentId, timestamp }))
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, MAX_ACTIVITY)
    const lastOpened = recent[0] && (!graph.lastOpened || recent[0].timestamp > graph.lastOpened.timestamp)
      ? recent[0]
      : graph.lastOpened
    const same = recent.length === graph.recent.length &&
      recent.every((item, index) => item.documentId === graph.recent[index]!.documentId && item.timestamp === graph.recent[index]!.timestamp) &&
      lastOpened === graph.lastOpened
    if (same) return false
    this.write(graphId, { ...graph, recent, lastOpened })
    return true
  }

  markCreated(graphId: string, documentId: string, timestamp = Date.now()): void {
    const graph = this.graph(graphId)
    const ref = { documentId, timestamp }
    this.write(graphId, {
      ...graph,
      created: [ref, ...graph.created.filter(item => item.documentId !== documentId)].slice(0, MAX_ACTIVITY),
      lastOpened: ref,
    })
  }

  setPinned(graphId: string, documentId: string, pinned: boolean): void {
    const graph = this.graph(graphId)
    const next = graph.pinned.filter(id => id !== documentId)
    if (pinned) next.unshift(documentId)
    this.write(graphId, { ...graph, pinned: next })
  }

  removeGraph(graphId: string): void {
    if (!(graphId in this.state.graphs)) return
    const graphs = { ...this.state.graphs }
    delete graphs[graphId]
    this.state = { version: 1, graphs }
    try { this.storage?.setItem(this.key, JSON.stringify(this.state)) } catch { /* best effort */ }
  }

  project(
    graphId: string,
    documents: readonly HomeDocumentSource[],
    options: {
      readonly dreamingEnabled?: boolean
      readonly dreamJournalId?: string
      /** Show the journal only when it was written this recently (ms); absent = any age. */
      readonly dreamJournalFreshMs?: number
      readonly now?: number
    } = {},
  ): HomeProjection {
    const graph = this.graph(graphId)
    const byId = new Map(documents.map(document => [document.id, document]))
    const homeDocument = (documentId: string, timestamp?: number): WorkspaceHomeDocument | null => {
      const document = byId.get(documentId)
      return document ? {
        graphId,
        documentId,
        title: document.title || 'Untitled',
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(document.readOnly ? { readOnly: true } : {}),
        ...(document.folder !== undefined ? { folder: document.folder } : {}),
      } : null
    }

    const pinned = graph.pinned.map(id => homeDocument(id)).filter((item): item is WorkspaceHomeDocument => item !== null)
    const pinnedIds = new Set(pinned.map(item => item.documentId))
    const recent = graph.recent
      .filter(item => !pinnedIds.has(item.documentId))
      .map(item => homeDocument(item.documentId, item.timestamp))
      .filter((item): item is WorkspaceHomeDocument => item !== null)
      .slice(0, 8)
    const latestAcceptedTimestamp = Date.now() + 86_400_000
    const createdById = new Map<string, TimedDocumentRef>()
    for (const document of documents) {
      // Read-only documents are views the system made (the Song, the
      // importance view), not things anyone created; they stay out.
      if (document.readOnly) continue
      const timestamp = finiteTimestamp(document.createdAt)
      if (timestamp !== null && timestamp <= latestAcceptedTimestamp) {
        createdById.set(document.id, { documentId: document.id, timestamp })
      }
    }
    // A local creation event is more precise than an order-derived projection
    // fallback, so it wins for the same document while remaining graph-scoped.
    for (const created of graph.created) {
      if (created.timestamp <= latestAcceptedTimestamp) createdById.set(created.documentId, created)
    }
    // Created and opened are separate lists on Home (2026-10-09): a document
    // made and then opened shows in both, because each list answers its own
    // question. Pinned documents still show only as pinned.
    const newlyCreated = [...createdById.values()]
      .filter(item => !pinnedIds.has(item.documentId))
      .sort((left, right) => right.timestamp - left.timestamp)
      .map(item => homeDocument(item.documentId, item.timestamp))
      .filter((item): item is WorkspaceHomeDocument => item !== null)
      .slice(0, 8)
    // "Last updated" (Eschaton, 2026-11-17): the writes, yours or an agent's,
    // newest first. Read-only views stay out, as they do from Recently created.
    const recentlyUpdated = documents
      .filter(document => !document.readOnly && !pinnedIds.has(document.id))
      .map(document => ({ id: document.id, timestamp: finiteTimestamp(document.updatedAt) }))
      .filter((item): item is { id: string, timestamp: number } => item.timestamp !== null && item.timestamp <= latestAcceptedTimestamp)
      .sort((left, right) => right.timestamp - left.timestamp)
      .map(item => homeDocument(item.id, item.timestamp))
      .filter((item): item is WorkspaceHomeDocument => item !== null)
      .slice(0, 8)
    const resume = graph.lastOpened ? homeDocument(graph.lastOpened.documentId, graph.lastOpened.timestamp) : null
    const journalId = options.dreamJournalId ?? `${graphId}-dream-journal`
    const journalWritten = finiteTimestamp(byId.get(journalId)?.updatedAt)
    const journalFresh = options.dreamJournalFreshMs === undefined || (
      journalWritten !== null && (options.now ?? Date.now()) - journalWritten <= options.dreamJournalFreshMs
    )
    const dreamJournal = options.dreamingEnabled && journalFresh
      ? homeDocument(journalId, journalWritten ?? undefined)
      : null
    return { resume, pinned, newlyCreated, recentlyUpdated, recent, dreamJournal }
  }

  /** When each of this graph's recently opened documents was last opened on this device. */
  openedTimes(graphId: string): Map<string, number> {
    return new Map(this.graph(graphId).recent.map(item => [item.documentId, item.timestamp] as const))
  }

  /** This graph's opened documents on this device, newest first (at most 40). */
  openedIds(graphId: string): string[] {
    return this.graph(graphId).recent.map(item => item.documentId)
  }
}
