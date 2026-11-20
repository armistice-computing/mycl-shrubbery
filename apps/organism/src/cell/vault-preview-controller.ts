/**
 * Drives the vault preview dialog: choose a source, wait for the scan, page
 * through what it found. Nothing here writes to the graph (Door 1's commit
 * step does not exist yet; see VAULT_IMPORT_ENABLED in nucleus features.ts).
 *
 * The node's own rules apply: no retry of a choice, an expired or
 * unavailable scan means choose again, and a scan from a graph that was
 * deleted or replaced is refused.
 */

import type {
  VaultCaptureEntry,
  VaultCaptureState,
  VaultSourceKind,
} from './vault-capture.js'
import type { VaultCaptureApi } from './vault-import.js'

export type VaultPreviewPhase = 'scanning' | 'ready' | 'expired' | 'refused' | 'failed' | 'cancelled'

export interface VaultPreviewView {
  readonly open: boolean
  readonly phase: VaultPreviewPhase
  readonly sourceKind: VaultSourceKind
  readonly entries: readonly VaultCaptureEntry[]
  readonly totalEntries: number
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly errorText: string
  /** The import already committed from this capture (status `jobId`). Resume it, never re-import. */
  readonly committedJobId: string | null
}

export interface VaultPreviewControllerOptions {
  readonly client: VaultCaptureApi
  readonly render: (view: VaultPreviewView) => void
  /** How long to wait between status reads while scanning. */
  readonly pollMs?: number
  readonly wait?: (ms: number) => Promise<void>
}

const CLOSED: VaultPreviewView = {
  open: false,
  phase: 'scanning',
  sourceKind: 'folder',
  entries: [],
  totalEntries: 0,
  hasMore: false,
  loadingMore: false,
  errorText: '',
  committedJobId: null,
}

function phaseFor(state: VaultCaptureState): VaultPreviewPhase {
  switch (state) {
    case 'capturing': return 'scanning'
    case 'ready': return 'ready'
    case 'expired': return 'expired'
    case 'revoked': return 'refused'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
  }
}

/** A refused or vanished scan reaches the page as an error from the command. */
export function phaseForError(message: string): VaultPreviewPhase {
  if (/unavailable|expired|not found|unknown scan/i.test(message)) return 'expired'
  if (/incarnation|recreated|deleted|refus|inactive/i.test(message)) return 'refused'
  return 'failed'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class VaultPreviewController {
  private view: VaultPreviewView = CLOSED
  private graphId = ''
  private scanId: string | null = null
  private nextOffset: number | null = null
  /** Bumped on every open and close, so a stale poll stops itself. */
  private generation = 0
  private readonly pollMs: number
  private readonly wait: (ms: number) => Promise<void>

  constructor(private readonly options: VaultPreviewControllerOptions) {
    this.pollMs = options.pollMs ?? 1000
    this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  get current(): VaultPreviewView {
    return this.view
  }

  /** The ready capture, for the review step. Null before one is ready. */
  get readyScan(): { readonly graphId: string; readonly scanId: string } | null {
    if (!this.view.open || this.view.phase !== 'ready' || !this.scanId) return null
    return { graphId: this.graphId, scanId: this.scanId }
  }

  private set(patch: Partial<VaultPreviewView>): void {
    this.view = { ...this.view, ...patch }
    this.options.render(this.view)
  }

  /** Opens the system chooser. Cancelling it leaves everything closed. */
  async choose(graphId: string, kind: VaultSourceKind): Promise<void> {
    const generation = ++this.generation
    this.graphId = graphId
    this.scanId = null
    this.nextOffset = null
    let selection
    try {
      selection = await this.options.client.select(graphId, kind)
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ ...CLOSED, open: true, sourceKind: kind, phase: phaseForError(messageOf(error)), errorText: messageOf(error) })
      return
    }
    if (generation !== this.generation) return
    if (selection.state === 'cancelled') {
      this.set(CLOSED)
      return
    }
    this.scanId = selection.scanId
    this.set({ ...CLOSED, open: true, sourceKind: kind, phase: 'scanning' })
    await this.poll(generation)
  }

  private async poll(generation: number): Promise<void> {
    const scanId = this.scanId
    if (!scanId) return
    for (;;) {
      let status
      try {
        status = await this.options.client.status(this.graphId, scanId, 0)
      } catch (error) {
        if (generation !== this.generation) return
        this.set({ phase: phaseForError(messageOf(error)), errorText: messageOf(error) })
        return
      }
      if (generation !== this.generation) return
      const phase = phaseFor(status.state)
      if (phase !== 'scanning') {
        this.nextOffset = status.complete ? null : status.nextOffset
        this.set({
          phase,
          entries: phase === 'ready' ? status.entries : [],
          totalEntries: status.totalEntries,
          hasMore: phase === 'ready' && this.nextOffset !== null,
          errorText: status.error ?? '',
          committedJobId: status.jobId,
        })
        return
      }
      await this.wait(this.pollMs)
      if (generation !== this.generation) return
    }
  }

  async showMore(): Promise<void> {
    const scanId = this.scanId
    const offset = this.nextOffset
    if (!scanId || offset === null || this.view.loadingMore) return
    const generation = this.generation
    this.set({ loadingMore: true })
    try {
      const status = await this.options.client.status(this.graphId, scanId, offset)
      if (generation !== this.generation) return
      const phase = phaseFor(status.state)
      if (phase !== 'ready') {
        this.set({ phase, loadingMore: false, hasMore: false, errorText: status.error ?? '' })
        return
      }
      this.nextOffset = status.complete ? null : status.nextOffset
      this.set({
        entries: [...this.view.entries, ...status.entries],
        totalEntries: status.totalEntries,
        hasMore: this.nextOffset !== null,
        loadingMore: false,
      })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ phase: phaseForError(messageOf(error)), loadingMore: false, hasMore: false, errorText: messageOf(error) })
    }
  }

  /** Stops a running scan. The dialog shows what the node says happened. */
  async stop(): Promise<void> {
    const scanId = this.scanId
    if (!scanId || this.view.phase !== 'scanning') {
      this.close()
      return
    }
    const generation = ++this.generation
    try {
      const result = await this.options.client.cancel(this.graphId, scanId)
      if (generation !== this.generation) return
      this.set({ phase: phaseFor(result.state) === 'scanning' ? 'cancelled' : phaseFor(result.state) })
    } catch (error) {
      if (generation !== this.generation) return
      this.set({ phase: phaseForError(messageOf(error)), errorText: messageOf(error) })
    }
  }

  close(): void {
    const scanning = this.view.phase === 'scanning' && this.view.open
    const scanId = this.scanId
    this.generation++
    if (scanning && scanId) void this.options.client.cancel(this.graphId, scanId).catch(() => {})
    this.scanId = null
    this.nextOffset = null
    this.set(CLOSED)
  }
}
