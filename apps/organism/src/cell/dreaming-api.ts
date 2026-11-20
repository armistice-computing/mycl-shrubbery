/**
 * The Dreaming settings page's view of gardend (garden src-tauri
 * dreamer_commands.rs). Every call is Tauri IPC: none of these commands is
 * served over loopback HTTP, so a browser dev server cannot reach them.
 *
 * The types follow answers sampled from a debug garden on a temporary
 * profile (2026-10-18), not the plan's prose. Times arrive as epoch
 * milliseconds, as strings (`changedAt`, `startedAt`) or numbers
 * (`lastStartedMs`).
 */

export type TauriInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>

export type DreamerPreset = 'kimi' | 'claude' | 'codex' | 'custom'

export type DreamerConfig =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'endpoint'
      readonly baseUrl: string
      readonly model: string
      readonly apiKeyProvider?: string
    }
  | {
      readonly kind: 'app'
      readonly preset: DreamerPreset
      readonly program?: string
      readonly model?: string
      readonly args?: readonly string[]
      readonly acceptReducedIsolation?: boolean
    }

/**
 * How well a dreamer is contained (dreamer.rs `Isolation`):
 * - isolated: tools, MCP, hooks, plugins and user settings off, verified;
 * - sandboxed: a read-only, no-network sandbox, but its tools stay on;
 * - user-responsibility: an arbitrary command;
 * - not-applicable: an HTTP call, no process.
 */
export type DreamerIsolation = 'isolated' | 'sandboxed' | 'user-responsibility' | 'not-applicable'

export interface DetectedDreamer {
  readonly kind: 'app' | 'endpoint'
  readonly preset?: DreamerPreset
  readonly label: string
  readonly program?: string
  readonly baseUrl?: string
  readonly models?: readonly string[]
  readonly isolation: DreamerIsolation
  readonly found: boolean
  readonly recommended: boolean
}

export interface DreamReceipt {
  readonly kind: string
  readonly configuredModel?: string
  readonly isolation: DreamerIsolation | string
  readonly acceptedReducedIsolation?: boolean
  /** 'local' | 'remote' for an endpoint; 'app' when the app talks to its own service. */
  readonly network: string
  readonly consent?: string
  readonly startedAt?: string
  readonly durationMs?: number
  readonly ended?: string
  readonly attempts?: number
  readonly outputBytes?: number
  readonly outputTruncated?: boolean
  readonly ok: boolean
  readonly error?: string
}

export interface DreamTestResult {
  readonly passed: boolean
  readonly reply: { readonly json: unknown; readonly text: string; readonly receipt: DreamReceipt }
}

export interface DreamNightly {
  readonly enabled: boolean
  readonly changedAt: string
}

export interface DreamGraphSettingsFile {
  readonly residueDays?: number
  readonly nightly?: DreamNightly
  readonly catchUp?: boolean
}

export interface DreamLastCycle {
  readonly lastStartedMs: number | null
  readonly lastTrigger: string
  readonly lastStatus: string
  readonly lastJobId: string | null
}

export interface DreamGraphSettings {
  readonly settings: DreamGraphSettingsFile
  readonly effective: {
    readonly residueDays: number
    readonly default: boolean
    readonly nightly: DreamNightly | null
    readonly catchUp: boolean
  }
  readonly defaults: { readonly residueDays: number; readonly nightly: boolean; readonly catchUp: boolean }
  readonly nightWindowHours: readonly [number, number]
  readonly cooldownHours: number
  readonly lastCycle: DreamLastCycle | { readonly error: string }
  readonly fileError: string | null
}

export interface DreamExclusions {
  readonly folders: readonly string[]
  readonly documents: readonly string[]
}

export interface ChargeWeights {
  readonly embedding: number
  readonly structural: number
  readonly valuation: number
  readonly temporal: number
  readonly articulability: number
}

export interface DreamScaling {
  readonly maxDreamsPerCycle: number
  readonly scaleReferencePoint: number
  readonly scaleMin: number
  readonly scaleMax: number
}

export interface TemporalCurve {
  readonly troughDays: number
  readonly capDays: number
}

export interface MechanicsField<T> {
  readonly value: T
  readonly default: T
  readonly edited: boolean
}

export interface DreamMechanicsView {
  readonly notice: { readonly version: number; readonly text: string; readonly agreed: boolean; readonly agreedAt: string | null }
  readonly editable: {
    readonly chargeWeights: MechanicsField<ChargeWeights>
    readonly dreamerPrompt: MechanicsField<string>
    readonly scaling: MechanicsField<DreamScaling>
    readonly astrologyEnabled: MechanicsField<boolean>
    readonly temporalCurve: MechanicsField<TemporalCurve>
  }
  readonly houseAuthored: Readonly<Record<string, unknown>>
}

export type MechanicsKey = keyof DreamMechanicsView['editable']

/** Replaces the edits wholesale: an absent or null field is the house default. */
export type MechanicsEdits = { readonly [K in MechanicsKey]?: DreamMechanicsView['editable'][K]['value'] | null }

/** dream_now's answer: a cycle receipt (cycle.rs `cycle_receipt`). */
export interface DreamCycleResult {
  readonly graphId: string
  readonly status: string
  readonly date?: string
  readonly reason?: string
  readonly dryRun?: boolean
  readonly counts?: Readonly<Record<string, number>>
  readonly dreams?: readonly {
    readonly kinds?: readonly string[]
    readonly totalCharge?: number
    readonly promptChars?: number | null
    readonly accepted?: boolean
  }[]
  /** Dry run only: the Dreamer prompt and the exact bundle prompts. */
  readonly system?: string
  readonly prompts?: readonly string[]
  readonly journal?: unknown
  readonly error?: string
}

export interface DreamingApi {
  dreamerConfig(): Promise<DreamerConfig>
  setDreamerConfig(config: DreamerConfig): Promise<void>
  listDreamers(): Promise<DetectedDreamer[]>
  testDreamer(config: DreamerConfig): Promise<DreamTestResult>
  graphSettings(graphId: string): Promise<DreamGraphSettings>
  setNightly(graphId: string, enabled: boolean): Promise<void>
  setCatchUp(graphId: string, catchUp: boolean | null): Promise<void>
  setResidueDays(graphId: string, residueDays: number | null): Promise<void>
  exclusions(graphId: string): Promise<DreamExclusions>
  setExclusions(graphId: string, exclusions: DreamExclusions): Promise<void>
  dreamNow(graphId: string, dryRun: boolean): Promise<DreamCycleResult>
  mechanics(): Promise<DreamMechanicsView>
  agreeToNotice(version: number): Promise<DreamMechanicsView>
  setMechanics(edits: MechanicsEdits): Promise<DreamMechanicsView>
}

/** Argument keys are camelCase; Tauri maps them onto the Rust snake_case names. */
export class TauriDreamingApi implements DreamingApi {
  constructor(private readonly invoke: TauriInvoke) {}

  dreamerConfig(): Promise<DreamerConfig> { return this.invoke('get_dreamer_config') }
  async setDreamerConfig(config: DreamerConfig): Promise<void> { await this.invoke('set_dreamer_config', { config }) }
  listDreamers(): Promise<DetectedDreamer[]> { return this.invoke('list_dreamers') }
  testDreamer(config: DreamerConfig): Promise<DreamTestResult> { return this.invoke('test_dreamer', { config }) }
  graphSettings(graphId: string): Promise<DreamGraphSettings> { return this.invoke('get_dream_graph_settings', { graphId }) }
  async setNightly(graphId: string, enabled: boolean): Promise<void> { await this.invoke('set_dream_nightly', { graphId, enabled }) }
  async setCatchUp(graphId: string, catchUp: boolean | null): Promise<void> { await this.invoke('set_dream_catch_up', { graphId, catchUp }) }
  async setResidueDays(graphId: string, residueDays: number | null): Promise<void> {
    await this.invoke('set_dream_residue_days', { graphId, residueDays })
  }
  async exclusions(graphId: string): Promise<DreamExclusions> {
    const answer = await this.invoke<{ exclusions?: DreamExclusions }>('get_dream_exclusions', { graphId })
    return { folders: answer.exclusions?.folders ?? [], documents: answer.exclusions?.documents ?? [] }
  }
  async setExclusions(graphId: string, exclusions: DreamExclusions): Promise<void> {
    await this.invoke('set_dream_exclusions', { graphId, exclusions })
  }
  dreamNow(graphId: string, dryRun: boolean): Promise<DreamCycleResult> { return this.invoke('dream_now', { graphId, dryRun }) }
  mechanics(): Promise<DreamMechanicsView> { return this.invoke('get_dream_mechanics') }
  agreeToNotice(version: number): Promise<DreamMechanicsView> { return this.invoke('agree_to_dream_notice', { noticeVersion: version }) }
  setMechanics(edits: MechanicsEdits): Promise<DreamMechanicsView> { return this.invoke('set_dream_mechanics', { edits }) }
}

// ── Pure helpers (tested) ────────────────────────────────────────────────────

/** A stable key for a dreamer choice, so a listing row and a saved config match. */
export function dreamerKey(dreamer: DreamerConfig | DetectedDreamer): string {
  if (dreamer.kind === 'none') return 'none'
  if (dreamer.kind === 'app') return `app:${dreamer.preset ?? 'custom'}`
  return `endpoint:${(dreamer.baseUrl ?? '').replace(/\/+$/, '')}`
}

/**
 * The picker's order: what this machine has comes first, the recommended one
 * (Kimi Code, Eschaton's ruling 2026-10-02) first among those; then what was
 * not found, in gardend's order.
 */
export function orderDreamers(dreamers: readonly DetectedDreamer[]): DetectedDreamer[] {
  return dreamers
    .map((dreamer, index) => ({ dreamer, index }))
    .sort((a, b) =>
      Number(b.dreamer.found) - Number(a.dreamer.found) ||
      Number(b.dreamer.recommended) - Number(a.dreamer.recommended) ||
      a.index - b.index)
    .map(item => item.dreamer)
}

/** The saved form of a listed dreamer: the app's own default model, the endpoint's first model. */
export function configForDreamer(
  dreamer: DetectedDreamer,
  options: { readonly model?: string; readonly acceptReducedIsolation?: boolean } = {},
): DreamerConfig {
  if (dreamer.kind === 'endpoint') {
    return { kind: 'endpoint', baseUrl: dreamer.baseUrl ?? '', model: options.model ?? dreamer.models?.[0] ?? '' }
  }
  const preset = dreamer.preset ?? 'custom'
  return {
    kind: 'app',
    preset,
    ...(dreamer.program ? { program: dreamer.program } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(needsReducedIsolation(dreamer.isolation) ? { acceptReducedIsolation: options.acceptReducedIsolation === true } : {}),
  }
}

/** Codex (sandboxed) and custom commands run only after the person accepts it. */
export function needsReducedIsolation(isolation: DreamerIsolation | string): boolean {
  return isolation === 'sandboxed' || isolation === 'user-responsibility'
}

/** Where the dreams' text goes, in words for the consent line. */
export function networkWords(dreamer: DreamerConfig | DetectedDreamer | null): string {
  if (!dreamer || dreamer.kind === 'none') return 'no dreamer is chosen'
  if (dreamer.kind === 'app') {
    return 'the fragments go to the app, which sends them to its own model service over the network'
  }
  return isLocalUrl(dreamer.baseUrl ?? '')
    ? 'the fragments stay on this computer'
    : 'the fragments are sent over the network to that server'
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

export function isolationWords(isolation: DreamerIsolation | string): string {
  switch (isolation) {
    case 'isolated': return 'Runs with its tools, plugins and settings off'
    case 'sandboxed': return 'Runs in a read-only sandbox without network, but its tools stay on'
    case 'user-responsibility': return 'Mycl cannot know what a custom command does'
    case 'not-applicable': return 'An HTTP call, no program runs'
    default: return isolation
  }
}

/** Epoch milliseconds as a string or number, or null. */
export function epochMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

export function isLastCycle(value: DreamGraphSettings['lastCycle']): value is DreamLastCycle {
  return !('error' in value)
}

/**
 * A dream cycle's error in words a person can act on. gardend's messages name
 * its own commands ("run refresh_semantic_index first"); the page names the
 * place in the app instead, and keeps gardend's words after it.
 */
export function cycleErrorWords(message: string): string {
  if (/semantic index/i.test(message)) {
    return `Dreaming reads this graph's semantic index, and the graph does not have one yet. Build it in Settings, Search & PDFs, then try again. (${message})`
  }
  if (/already running/i.test(message)) return 'A dream cycle is already running for this graph. Try again when it finishes.'
  return message
}

/** "1–4 a.m." from gardend's [start, end) hours. */
export function nightWindowWords(hours: readonly [number, number]): string {
  const hour = (h: number): string => {
    const twelve = h % 12 === 0 ? 12 : h % 12
    return `${twelve} ${h < 12 ? 'a.m.' : 'p.m.'}`
  }
  const [start, end] = hours
  const sameHalf = (start < 12) === (end < 12)
  return sameHalf ? `${hour(start).split(' ')[0]}–${hour(end)}` : `${hour(start)}–${hour(end)}`
}
