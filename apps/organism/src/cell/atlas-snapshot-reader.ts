/**
 * Reads the wire atlas's snapshot for the graph on screen.
 *
 * One read at a time per graph. A read belongs to the graph and generation
 * that started it: switching graphs (reset) disowns it, so a late answer for
 * graph A never lands on B and never blocks B's own read, including A -> B -> A.
 * A failed read keeps the last complete map.
 */
import type { AtlasSnapshot } from '@shrubbery/components'
import { atlasSnapshotQuery, decodeAtlasSnapshot } from './wire-atlas-data.js'

export type AtlasReadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AtlasSnapshotReaderDeps {
  query(graphId: string, sparql: string): Promise<unknown>
  /** Called whenever status, snapshot or error changes for the current graph. */
  onChange(): void
  now?: () => number
  /** A read younger than this is reused unless forced. */
  freshMs?: number
}

export class AtlasSnapshotReader {
  graphId = ''
  snapshot: (AtlasSnapshot & { graphId: string }) | null = null
  status: AtlasReadStatus = 'idle'
  error = ''
  private loadedAt = 0
  private reading: { graphId: string; generation: number } | null = null
  private generation = 0

  constructor(private readonly deps: AtlasSnapshotReaderDeps) {}

  /** Forget everything about the previous graph, including its read in flight. */
  reset(graphId: string): void {
    this.graphId = graphId
    this.snapshot = null
    this.status = 'idle'
    this.error = ''
    this.loadedAt = 0
    this.reading = null
  }

  async request(graphId: string, force: boolean): Promise<void> {
    if (!graphId) return
    if (graphId !== this.graphId) this.reset(graphId)
    if (this.reading?.graphId === graphId) return
    const now = this.deps.now ?? Date.now
    if (!force && this.snapshot && now() - this.loadedAt < (this.deps.freshMs ?? 30_000)) return
    const generation = ++this.generation
    this.reading = { graphId, generation }
    const owns = () => this.reading?.generation === generation
    if (!this.snapshot) {
      this.status = 'loading'
      this.deps.onChange()
    }
    try {
      const result = await this.deps.query(graphId, atlasSnapshotQuery(graphId))
      if (!owns()) return
      this.snapshot = decodeAtlasSnapshot(graphId, result)
      this.status = 'ready'
      this.error = ''
      this.loadedAt = now()
    } catch (error) {
      if (!owns()) return
      this.status = this.snapshot ? 'ready' : 'error'
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (owns()) {
        this.reading = null
        this.deps.onChange()
      }
    }
  }
}
