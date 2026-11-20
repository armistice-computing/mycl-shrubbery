/**
 * The native vault capture (Door 1): choose a folder or a .zip, scan it, and
 * page through what was found. The contract is Epsilon's,
 * garden docs/door1-native-capture.md. This is the only module that names
 * its commands.
 *
 * A ready capture is a preview. Nothing is in the graph yet: the step that
 * writes it there does not exist, so `graphWrites` is always false here.
 * The commands are Tauri invokes from the main window only. There is no
 * HTTP or MCP route.
 */

export type VaultSourceKind = 'folder' | 'zip'

export type VaultCaptureState = 'capturing' | 'ready' | 'failed' | 'cancelled' | 'revoked' | 'expired'

export type VaultEntryKind = 'directory' | 'note' | 'attachment'

export interface VaultCaptureEntry {
  readonly index: number
  /** Relative to the chosen root. Render as text, never as HTML. */
  readonly path: string
  readonly kind: VaultEntryKind
  readonly bytes: number
  readonly sha256: string
}

export type VaultSelection =
  | { readonly state: 'cancelled' }
  | { readonly state: 'capturing'; readonly scanId: string; readonly graphId: string }

export interface VaultCaptureStatus {
  readonly state: VaultCaptureState
  readonly expiresAt: number | null
  readonly fingerprint: string | null
  readonly error: string | null
  readonly totalEntries: number
  readonly entries: readonly VaultCaptureEntry[]
  readonly nextOffset: number | null
  /** The page reached the end of the entries. Not the scan's phase: read `state`. */
  readonly complete: boolean
  /** The import job already committed from this capture, if any. Resume it; never re-import. */
  readonly jobId: string | null
}

export interface VaultCancelResult {
  readonly state: VaultCaptureState
  readonly cancelled: boolean
}

export type VaultInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

interface TauriGlobal {
  readonly __TAURI_INTERNALS__?: { readonly invoke?: VaultInvoke }
}

/** The largest page the node serves. */
export const VAULT_PAGE_LIMIT = 50

export function nativeVaultInvoke(): VaultInvoke | null {
  return (globalThis as TauriGlobal).__TAURI_INTERNALS__?.invoke ?? null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

const STATES: readonly VaultCaptureState[] = ['capturing', 'ready', 'failed', 'cancelled', 'revoked', 'expired']
const KINDS: readonly VaultEntryKind[] = ['directory', 'note', 'attachment']

function captureState(value: unknown): VaultCaptureState {
  return STATES.includes(value as VaultCaptureState) ? value as VaultCaptureState : 'failed'
}

function entryFrom(value: unknown): VaultCaptureEntry | null {
  const raw = record(value)
  const path = text(raw.path)
  if (!path) return null
  return {
    index: count(raw.index),
    path,
    kind: KINDS.includes(raw.kind as VaultEntryKind) ? raw.kind as VaultEntryKind : 'attachment',
    bytes: count(raw.bytes),
    sha256: text(raw.sha256) ?? '',
  }
}

export function vaultSelectionFrom(value: unknown): VaultSelection {
  const raw = record(value)
  const scanId = text(raw.scanId)
  const graphId = text(raw.graphId)
  if (raw.state === 'capturing' && scanId && graphId) return { state: 'capturing', scanId, graphId }
  return { state: 'cancelled' }
}

export function vaultStatusFrom(value: unknown): VaultCaptureStatus {
  const raw = record(value)
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(entryFrom).filter((entry): entry is VaultCaptureEntry => entry !== null)
    : []
  return {
    state: captureState(raw.state),
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : null,
    fingerprint: text(raw.fingerprint),
    error: text(raw.error),
    totalEntries: count(raw.totalEntries),
    entries,
    nextOffset: typeof raw.nextOffset === 'number' ? raw.nextOffset : null,
    complete: raw.complete === true,
    jobId: text(raw.jobId) || null,
  }
}

export class VaultCaptureClient {
  constructor(private readonly invoke: VaultInvoke) {}

  /** Opens the system chooser. Cancelling it makes no scan. */
  async select(graphId: string, kind: VaultSourceKind): Promise<VaultSelection> {
    return vaultSelectionFrom(await this.invoke('select_vault_source', { graphId, kind }))
  }

  async status(graphId: string, scanId: string, offset = 0, limit = VAULT_PAGE_LIMIT): Promise<VaultCaptureStatus> {
    const bounded = Math.min(VAULT_PAGE_LIMIT, Math.max(1, Math.floor(limit)))
    return vaultStatusFrom(await this.invoke('get_vault_capture_status', { graphId, scanId, offset, limit: bounded }))
  }

  async cancel(graphId: string, scanId: string): Promise<VaultCancelResult> {
    const raw = record(await this.invoke('cancel_vault_capture', { graphId, scanId }))
    return { state: captureState(raw.state), cancelled: raw.cancelled === true }
  }
}
