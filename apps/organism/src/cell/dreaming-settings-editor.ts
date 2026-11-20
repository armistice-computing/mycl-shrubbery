/**
 * mn-dreaming-settings — the Dreaming page in Settings (Dreaming Port Plan,
 * Phase 4; Eschaton's rulings 2026-10-02 12:58, 10-07 and 10-18).
 *
 * Top to bottom:
 *   1. the dreamer (per profile): detected apps and servers, a Test that
 *      tries the choice before it is saved and shows the receipt;
 *   2. dream nightly (per graph): the consent, off by default, naming the
 *      dreamer and where the fragments go; catch-up; the night window;
 *   3. residue days; 4. exclusions; 5. the last cycle, a dry-run preview and
 *      a confirmed "dream now";
 *   6. the mechanics: always readable, editable only after the notice is
 *      agreed to, every field resettable to the house default.
 *
 * All effects go through `api` (Tauri IPC). The element keeps no state that
 * outlives a reload except what gardend stores.
 */
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import {
  configForDreamer,
  cycleErrorWords,
  dreamerKey,
  epochMs,
  isLastCycle,
  isolationWords,
  needsReducedIsolation,
  networkWords,
  nightWindowWords,
  orderDreamers,
  type DetectedDreamer,
  type DreamCycleResult,
  type DreamerConfig,
  type DreamExclusions,
  type DreamGraphSettings,
  type DreamingApi,
  type DreamMechanicsView,
  type DreamTestResult,
  type MechanicsEdits,
  type MechanicsKey,
} from './dreaming-api.js'

/** A folder or document that can be excluded, with the path shown beside it. */
export interface DreamingTarget {
  readonly id: string
  readonly label: string
  readonly path?: string | null
}

export interface DreamingTargets {
  readonly folders: readonly DreamingTarget[]
  readonly documents: readonly DreamingTarget[]
}

type Busy = 'load' | 'save-dreamer' | 'test' | 'nightly' | 'catch-up' | 'residue' | 'exclusions' | 'preview' | 'dream' | 'agree' | 'mechanics' | null

const OTHER_SERVER = 'endpoint:other'
const CUSTOM_COMMAND = 'app:custom'

function when(ms: number | null): string {
  if (ms === null) return 'never'
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? '' : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

@customElement('mn-dreaming-settings')
export class MnDreamingSettings extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: var(--mn-color-text-primary);
      font-family: var(--mn-font-utility, system-ui, sans-serif);
      font-size: var(--mn-text-sm, 13px);
    }
    section {
      padding: var(--mn-space-4, 16px) 0;
      border-top: 1px solid var(--mn-color-border-subtle, #e5e7eb);
    }
    .dreaming > section:first-of-type { border-top: 0; padding-top: 0; }
    h3 {
      margin: 0 0 var(--mn-space-2, 8px);
      font-size: var(--mn-text-md, 14px);
      font-weight: 600;
    }
    p { margin: 0 0 var(--mn-space-2, 8px); line-height: 1.5; }
    .muted { color: var(--mn-color-text-secondary, #6b7280); }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--mn-space-2, 8px);
      margin: var(--mn-space-2, 8px) 0;
    }
    label.check {
      display: flex;
      align-items: flex-start;
      gap: var(--mn-space-2, 8px);
      line-height: 1.5;
      cursor: pointer;
    }
    label.check input { margin-top: 3px; }
    label.check.consent {
      padding: var(--mn-space-3, 12px);
      border: 1px solid var(--mn-color-border-default, #d1d5db);
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-raised, #fff);
    }
    select, input[type='text'], input[type='number'], textarea {
      min-height: 32px;
      box-sizing: border-box;
      padding: 0 10px;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-primary, #111827);
      font: inherit;
    }
    select { min-width: 220px; }
    input[type='number'] { width: 90px; }
    input[type='text'] { min-width: 260px; }
    textarea {
      display: block;
      width: 100%;
      min-height: 280px;
      padding: 10px;
      font-family: var(--mn-font-mono, ui-monospace, monospace);
      font-size: 12px;
      line-height: 1.5;
      resize: vertical;
    }
    textarea[readonly], input[readonly] { background: var(--mn-color-surface-sunken, rgba(0, 0, 0, 0.03)); }
    button {
      min-height: 32px;
      padding: 0 11px;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-control, 6px);
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-secondary, #374151);
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      border-color: var(--mn-color-accent, #4d8768);
      background: var(--mn-color-accent, #4d8768);
      color: var(--mn-color-text-on-accent, #fff);
    }
    button.danger { color: var(--mn-color-text-danger, #b91c1c); }
    button:disabled { opacity: 0.5; cursor: default; }
    button.link {
      min-height: 0;
      padding: 0;
      border: 0;
      background: none;
      color: var(--mn-color-text-accent, #2f684b);
      text-decoration: underline;
    }
    .receipt, .notice, .error {
      margin: var(--mn-space-2, 8px) 0;
      padding: var(--mn-space-2, 8px) var(--mn-space-3, 12px);
      border-radius: var(--mn-radius-md, 6px);
      line-height: 1.5;
    }
    .receipt { background: var(--mn-color-surface-sunken, rgba(0, 0, 0, 0.03)); }
    .receipt.ok { border-left: 3px solid var(--mn-color-success, #469c70); }
    .receipt.fail { border-left: 3px solid var(--mn-color-danger, #e11d48); }
    .notice {
      border: 1px solid var(--mn-color-warning-border, rgba(217, 119, 6, 0.25));
      background: var(--mn-color-warning-surface, rgba(217, 119, 6, 0.08));
    }
    .error { color: var(--mn-color-text-danger, #b91c1c); background: var(--mn-color-danger-surface, rgba(244, 63, 94, 0.08)); }
    pre {
      max-height: 360px;
      overflow: auto;
      margin: var(--mn-space-2, 8px) 0;
      padding: 10px;
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-sunken, rgba(0, 0, 0, 0.03));
      font-family: var(--mn-font-mono, ui-monospace, monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
    }
    ul.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: var(--mn-space-2, 8px) 0; padding: 0; list-style: none; }
    ul.chips li {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px 2px 10px;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: 999px;
    }
    ul.chips button { min-height: 22px; padding: 0 6px; border: 0; background: none; }
    .field {
      margin: var(--mn-space-3, 12px) 0;
      padding: var(--mn-space-3, 12px);
      border: 1px solid var(--mn-color-border-subtle, #e5e7eb);
      border-radius: var(--mn-radius-md, 6px);
    }
    .field-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .badge {
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--mn-color-warning-surface, rgba(217, 119, 6, 0.12));
      color: var(--mn-color-text-warning, #b45309);
      font-size: 11px;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 12px; }
    .grid label { display: grid; gap: 3px; color: var(--mn-color-text-secondary, #6b7280); font-size: 12px; }
    details > summary { cursor: pointer; color: var(--mn-color-text-secondary, #6b7280); }
  `

  @property({ attribute: false }) api: DreamingApi | null = null
  @property({ type: String }) graphId = ''
  @property({ type: String }) graphTitle = ''
  /** Folders and documents of this graph, for naming and picking exclusions. */
  @property({ attribute: false }) listTargets: (() => Promise<DreamingTargets>) | null = null

  @state() private _busy: Busy = 'load'
  @state() private _error = ''
  @state() private _config: DreamerConfig = { kind: 'none' }
  @state() private _dreamers: DetectedDreamer[] = []
  @state() private _graph: DreamGraphSettings | null = null
  @state() private _exclusions: DreamExclusions = { folders: [], documents: [] }
  @state() private _mechanics: DreamMechanicsView | null = null
  @state() private _targets: DreamingTargets = { folders: [], documents: [] }

  // Dreamer draft: what the picker shows before Save.
  @state() private _draftKey = 'none'
  @state() private _draftModel = ''
  @state() private _draftAccept = false
  @state() private _draftBaseUrl = ''
  @state() private _draftProgram = ''
  @state() private _draftArgs = ''
  @state() private _test: DreamTestResult | null = null
  @state() private _testError = ''

  @state() private _residueDraft = ''
  @state() private _cycle: DreamCycleResult | null = null
  @state() private _cycleError = ''
  @state() private _confirmDream = false
  @state() private _mechanicsDraft: Partial<Record<MechanicsKey, unknown>> = {}
  @state() private _mechanicsError = ''

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('api') || changed.has('graphId')) void this.reload()
  }

  /** Read everything again from gardend. */
  async reload(): Promise<void> {
    const api = this.api
    const graphId = this.graphId
    if (!api || !graphId) return
    this._busy = 'load'
    this._error = ''
    try {
      const [config, dreamers, graph, exclusions, mechanics] = await Promise.all([
        api.dreamerConfig(),
        api.listDreamers(),
        api.graphSettings(graphId),
        api.exclusions(graphId),
        api.mechanics(),
      ])
      if (api !== this.api || graphId !== this.graphId) return
      this._config = config
      this._dreamers = orderDreamers(dreamers)
      this._graph = graph
      this._exclusions = exclusions
      this._mechanics = mechanics
      this._mechanicsDraft = {}
      this._residueDraft = graph.settings.residueDays === undefined ? '' : String(graph.settings.residueDays)
      this._resetDreamerDraft()
    } catch (error) {
      this._error = errorText(error)
    } finally {
      this._busy = null
    }
    if (this.listTargets) {
      this.listTargets().then(targets => { this._targets = targets }).catch(() => undefined)
    }
  }

  private _resetDreamerDraft(): void {
    const config = this._config
    this._draftKey = config.kind === 'endpoint' && !this._dreamers.some(d => dreamerKey(d) === dreamerKey(config))
      ? OTHER_SERVER
      : dreamerKey(config)
    this._draftModel = config.kind === 'none' ? '' : config.model ?? ''
    this._draftAccept = config.kind === 'app' ? config.acceptReducedIsolation === true : false
    this._draftBaseUrl = config.kind === 'endpoint' ? config.baseUrl : ''
    this._draftProgram = config.kind === 'app' && config.preset === 'custom' ? config.program ?? '' : ''
    this._draftArgs = config.kind === 'app' && config.preset === 'custom' ? (config.args ?? []).join(' ') : ''
    this._test = null
    this._testError = ''
  }

  private _listed(key: string): DetectedDreamer | null {
    return this._dreamers.find(d => dreamerKey(d) === key) ?? null
  }

  /** The config the picker currently describes, or null while it is incomplete. */
  private _draftConfig(): DreamerConfig | null {
    const key = this._draftKey
    if (key === 'none') return { kind: 'none' }
    if (key === OTHER_SERVER) {
      const baseUrl = this._draftBaseUrl.trim()
      const model = this._draftModel.trim()
      return baseUrl && model ? { kind: 'endpoint', baseUrl, model } : null
    }
    if (key === CUSTOM_COMMAND) {
      const program = this._draftProgram.trim()
      if (!program) return null
      const args = this._draftArgs.trim() ? this._draftArgs.trim().split(/\s+/) : []
      return { kind: 'app', preset: 'custom', program, ...(args.length ? { args } : {}), acceptReducedIsolation: this._draftAccept }
    }
    const listed = this._listed(key)
    if (!listed) return null
    return configForDreamer(listed, { model: this._draftModel.trim() || undefined, acceptReducedIsolation: this._draftAccept })
  }

  private _draftIsolation(): string {
    if (this._draftKey === CUSTOM_COMMAND) return 'user-responsibility'
    if (this._draftKey === OTHER_SERVER || this._draftKey === 'none') return 'not-applicable'
    return this._listed(this._draftKey)?.isolation ?? 'not-applicable'
  }

  private _dreamerLabel(config: DreamerConfig): string {
    if (config.kind === 'none') return 'no dreamer'
    const listed = this._listed(dreamerKey(config))
    if (listed) return listed.label
    if (config.kind === 'endpoint') return config.baseUrl
    return config.program ?? config.preset
  }

  private async _run<T>(busy: Busy, work: () => Promise<T>, onError: (message: string) => void): Promise<T | undefined> {
    this._busy = busy
    try {
      return await work()
    } catch (error) {
      onError(errorText(error))
      return undefined
    } finally {
      this._busy = null
    }
  }

  private async _saveDreamer(): Promise<void> {
    const api = this.api
    const config = this._draftConfig()
    if (!api || !config) return
    await this._run('save-dreamer', async () => {
      await api.setDreamerConfig(config)
      this._config = await api.dreamerConfig()
      this._resetDreamerDraft()
    }, message => { this._testError = message })
  }

  private async _testDreamer(): Promise<void> {
    const api = this.api
    const config = this._draftConfig()
    if (!api || !config) return
    this._test = null
    this._testError = ''
    await this._run('test', async () => { this._test = await api.testDreamer(config) }, message => { this._testError = message })
  }

  private async _graphCall(busy: Busy, work: (api: DreamingApi, graphId: string) => Promise<unknown>): Promise<void> {
    const api = this.api
    const graphId = this.graphId
    if (!api || !graphId) return
    await this._run(busy, async () => {
      await work(api, graphId)
      this._graph = await api.graphSettings(graphId)
      this._residueDraft = this._graph.settings.residueDays === undefined ? '' : String(this._graph.settings.residueDays)
    }, message => { this._error = message })
  }

  private async _setExclusions(next: DreamExclusions): Promise<void> {
    const api = this.api
    const graphId = this.graphId
    if (!api || !graphId) return
    await this._run('exclusions', async () => {
      await api.setExclusions(graphId, next)
      this._exclusions = await api.exclusions(graphId)
    }, message => { this._error = message })
  }

  private async _dream(dryRun: boolean): Promise<void> {
    const api = this.api
    const graphId = this.graphId
    if (!api || !graphId) return
    this._confirmDream = false
    this._cycle = null
    this._cycleError = ''
    await this._run(dryRun ? 'preview' : 'dream', async () => {
      this._cycle = await api.dreamNow(graphId, dryRun)
      if (!dryRun) this._graph = await api.graphSettings(graphId)
    }, message => { this._cycleError = cycleErrorWords(message) })
  }

  private async _agree(): Promise<void> {
    const api = this.api
    const mechanics = this._mechanics
    if (!api || !mechanics) return
    await this._run('agree', async () => { this._mechanics = await api.agreeToNotice(mechanics.notice.version) },
      message => { this._mechanicsError = message })
  }

  /** The value a mechanics field shows: the draft if touched, else the current value. */
  private _mechanicsValue<K extends MechanicsKey>(key: K): DreamMechanicsView['editable'][K]['value'] {
    const draft = this._mechanicsDraft[key]
    return (draft === undefined ? this._mechanics!.editable[key].value : draft) as DreamMechanicsView['editable'][K]['value']
  }

  private _setDraft(key: MechanicsKey, value: unknown): void {
    this._mechanicsDraft = { ...this._mechanicsDraft, [key]: value }
  }

  /**
   * set_dream_mechanics replaces the edits wholesale: send every field that
   * differs from its default. Resetting one field sends the others as SAVED,
   * so an unsaved draft elsewhere is not saved by a reset.
   */
  private _mechanicsEdits(resetKey?: MechanicsKey): MechanicsEdits {
    const mechanics = this._mechanics!
    const edits: Record<string, unknown> = {}
    for (const key of Object.keys(mechanics.editable) as MechanicsKey[]) {
      if (key === resetKey) continue
      const value = resetKey ? mechanics.editable[key].value : this._mechanicsValue(key)
      if (JSON.stringify(value) !== JSON.stringify(mechanics.editable[key].default)) edits[key] = value
    }
    return edits as MechanicsEdits
  }

  private async _saveMechanics(resetKey?: MechanicsKey): Promise<void> {
    const api = this.api
    if (!api || !this._mechanics) return
    const edits = this._mechanicsEdits(resetKey)
    this._mechanicsError = ''
    await this._run('mechanics', async () => {
      this._mechanics = await api.setMechanics(edits)
      if (resetKey) {
        const { [resetKey]: _reset, ...rest } = this._mechanicsDraft
        this._mechanicsDraft = rest
      } else {
        this._mechanicsDraft = {}
      }
    }, message => { this._mechanicsError = message })
  }

  // ── render ──────────────────────────────────────────────────────────────

  protected render(): TemplateResult {
    if (!this.api) {
      return html`<p class="muted">Dreaming is set up in the Mycl app. This window has no connection to it.</p>`
    }
    if (this._busy === 'load' && !this._graph) return html`<p class="muted">Reading dreaming settings…</p>`
    return html`<div class="dreaming">
      ${this._error ? html`<div class="error" role="alert">${this._error}</div>` : nothing}
      ${this._renderDreamer()}
      ${this._renderNightly()}
      ${this._renderResidue()}
      ${this._renderExclusions()}
      ${this._renderCycle()}
      ${this._renderMechanics()}
    </div>`
  }

  private _renderDreamer(): TemplateResult {
    const draft = this._draftConfig()
    const isolation = this._draftIsolation()
    const listed = this._listed(this._draftKey)
    const needsAccept = needsReducedIsolation(isolation)
    const changed = draft !== null && JSON.stringify(draft) !== JSON.stringify(this._config)
    const canSave = draft !== null && changed && (!needsAccept || this._draftAccept) && this._busy === null
    const models = listed?.models ?? []
    return html`<section data-dreaming="dreamer">
      <h3>Dreamer</h3>
      <p class="muted">The AI that writes the dreams, for every graph. Saved: <strong>${this._dreamerLabel(this._config)}</strong>.</p>
      <div class="row">
        <select
          aria-label="Dreamer"
          .value=${this._draftKey}
          @change=${(event: Event) => {
            this._draftKey = (event.target as HTMLSelectElement).value
            this._draftModel = ''
            this._draftAccept = false
            this._test = null
            this._testError = ''
          }}
        >
          <option value="none" ?selected=${this._draftKey === 'none'}>No dreamer</option>
          ${this._dreamers.map(dreamer => html`<option
            value=${dreamerKey(dreamer)}
            ?selected=${this._draftKey === dreamerKey(dreamer)}
          >${dreamer.label}${dreamer.recommended ? ' (recommended)' : ''}${dreamer.found ? '' : ' — not found'}</option>`)}
          <option value=${OTHER_SERVER} ?selected=${this._draftKey === OTHER_SERVER}>Another OpenAI-compatible server…</option>
          ${this._dreamers.some(d => dreamerKey(d) === CUSTOM_COMMAND) ? nothing : html`<option value=${CUSTOM_COMMAND} ?selected=${this._draftKey === CUSTOM_COMMAND}>A custom command…</option>`}
        </select>
        ${models.length > 0 ? html`<select
          aria-label="Model"
          @change=${(event: Event) => { this._draftModel = (event.target as HTMLSelectElement).value }}
        >${models.map(model => html`<option value=${model} ?selected=${(this._draftModel || models[0]) === model}>${model}</option>`)}</select>` : nothing}
        ${listed?.kind === 'app' ? html`<input
          type="text"
          aria-label="Model (optional)"
          placeholder="Model (the app's default if empty)"
          .value=${this._draftModel}
          @input=${(event: Event) => { this._draftModel = (event.target as HTMLInputElement).value }}
        />` : nothing}
      </div>
      ${this._draftKey === OTHER_SERVER ? html`<div class="row">
        <input type="text" aria-label="Server URL" placeholder="http://localhost:11434/v1" .value=${this._draftBaseUrl}
          @input=${(event: Event) => { this._draftBaseUrl = (event.target as HTMLInputElement).value }} />
        <input type="text" aria-label="Model" placeholder="Model" .value=${this._draftModel}
          @input=${(event: Event) => { this._draftModel = (event.target as HTMLInputElement).value }} />
      </div>` : nothing}
      ${this._draftKey === CUSTOM_COMMAND ? html`<div class="row">
        <input type="text" aria-label="Program" placeholder="/path/to/program" .value=${this._draftProgram}
          @input=${(event: Event) => { this._draftProgram = (event.target as HTMLInputElement).value }} />
        <input type="text" aria-label="Arguments" placeholder="Arguments (the prompt arrives on stdin)" .value=${this._draftArgs}
          @input=${(event: Event) => { this._draftArgs = (event.target as HTMLInputElement).value }} />
      </div>` : nothing}
      ${this._draftKey !== 'none' ? html`<p class="muted" data-dreamer-detail>
        ${isolationWords(isolation)}. ${draft ? `When it dreams, ${networkWords(draft)}.` : ''}
        ${listed && !listed.found ? html`<br />Not found on this computer.` : nothing}
      </p>` : nothing}
      ${needsAccept ? html`<label class="check">
        <input type="checkbox" .checked=${this._draftAccept} data-accept-reduced
          @change=${(event: Event) => { this._draftAccept = (event.target as HTMLInputElement).checked }} />
        <span>I understand this dreamer is not fully isolated: ${isolation === 'sandboxed'
          ? 'its tools stay on inside a read-only sandbox'
          : 'Mycl cannot see what the command does'}. I accept reduced isolation.</span>
      </label>` : nothing}
      <div class="row">
        <button data-dreamer-test ?disabled=${!draft || draft.kind === 'none' || this._busy !== null || (needsAccept && !this._draftAccept)}
          @click=${() => this._testDreamer()}>${this._busy === 'test' ? 'Testing…' : 'Test'}</button>
        <button class="primary" data-dreamer-save ?disabled=${!canSave} @click=${() => this._saveDreamer()}>
          ${this._busy === 'save-dreamer' ? 'Saving…' : 'Save dreamer'}</button>
        ${changed ? html`<button class="link" @click=${() => this._resetDreamerDraft()}>Cancel</button>` : nothing}
      </div>
      ${this._testError ? html`<div class="error" role="alert">${this._testError}</div>` : nothing}
      ${this._test ? this._renderTest(this._test) : nothing}
    </section>`
  }

  private _renderTest(test: DreamTestResult): TemplateResult {
    const receipt = test.reply.receipt
    const reply = test.reply.text.trim()
    return html`<div class="receipt ${test.passed ? 'ok' : 'fail'}" data-dreamer-test-result>
      <strong>${test.passed ? 'The dreamer answered.' : 'The test did not pass.'}</strong>
      ${receipt.error ? html`<br />${receipt.error}` : nothing}
      <br /><span class="muted">
        ${[
          receipt.configuredModel ? `model ${receipt.configuredModel}` : '',
          seconds(receipt.durationMs),
          `network: ${receipt.network}`,
          receipt.attempts ? `${receipt.attempts} attempt${receipt.attempts === 1 ? '' : 's'}` : '',
          receipt.outputTruncated ? 'output truncated' : '',
        ].filter(Boolean).join(' · ')}
      </span>
      ${reply ? html`<pre>${reply.length > 2000 ? `${reply.slice(0, 2000)}…` : reply}</pre>` : nothing}
    </div>`
  }

  /** The shell may not know the title yet (straight to Settings at boot); never show a raw id. */
  private _graphHeading(): string {
    const title = this.graphTitle.trim()
    return title && title !== this.graphId ? `Dreaming for ${title}` : 'Dreaming for this graph'
  }

  private _renderNightly(): TemplateResult {
    const graph = this._graph
    if (!graph) return html``
    const nightly = graph.effective.nightly?.enabled === true
    const changedAt = epochMs(graph.effective.nightly?.changedAt)
    const hasDreamer = this._config.kind !== 'none'
    const window = nightWindowWords(graph.nightWindowHours)
    return html`<section data-dreaming="nightly">
      <h3>${this._graphHeading()}</h3>
      <label class="check consent">
        <input type="checkbox" data-dream-nightly .checked=${nightly} ?disabled=${(!hasDreamer && !nightly) || this._busy !== null}
          @change=${(event: Event) => {
            const enabled = (event.target as HTMLInputElement).checked
            void this._graphCall('nightly', (api, graphId) => api.setNightly(graphId, enabled))
          }} />
        <span>
          <strong>Dream nightly.</strong>
          ${hasDreamer
            ? html`<span>Mycl dreams on this graph unattended once a night, between ${window}, using
              <strong>${this._dreamerLabel(this._config)}</strong>; ${networkWords(this._config)}.
              The dreams replace the dream journal each night.</span>`
            : html`<span>Choose and save a dreamer above first.</span>`}
          ${changedAt !== null ? html`<br /><span class="muted">${nightly ? 'On' : 'Off'} since ${when(changedAt)}.</span>` : nothing}
        </span>
      </label>
      <label class="check" style="margin-top:10px">
        <input type="checkbox" data-dream-catch-up .checked=${graph.effective.catchUp} ?disabled=${this._busy !== null}
          @change=${(event: Event) => {
            const catchUp = (event.target as HTMLInputElement).checked
            void this._graphCall('catch-up', (api, graphId) => api.setCatchUp(graphId, catchUp === graph.defaults.catchUp ? null : catchUp))
          }} />
        <span>Catch up after a missed night: dream once on the next wake if the computer slept through the window.</span>
      </label>
      <p class="muted" style="margin-top:10px">Night window ${window}, local time. At most one cycle every ${graph.cooldownHours} hours.</p>
      ${graph.fileError ? html`<div class="error">This graph's dream settings could not be read: ${graph.fileError}</div>` : nothing}
    </section>`
  }

  private _renderResidue(): TemplateResult {
    const graph = this._graph
    if (!graph) return html``
    const draft = this._residueDraft.trim()
    const value = draft === '' ? null : Number(draft)
    const valid = value === null || (Number.isFinite(value) && value >= 0 && value <= 60)
    const current = graph.settings.residueDays ?? null
    return html`<section data-dreaming="residue">
      <h3>Residue</h3>
      <p class="muted">How many days of recent writing may seed a dream. 0 turns it off. Default ${graph.defaults.residueDays}.</p>
      <div class="row">
        <input type="number" min="0" max="60" step="1" aria-label="Residue days" data-dream-residue
          placeholder=${String(graph.defaults.residueDays)} .value=${this._residueDraft}
          @input=${(event: Event) => { this._residueDraft = (event.target as HTMLInputElement).value }} />
        <span class="muted">days</span>
        <button ?disabled=${!valid || value === current || this._busy !== null}
          @click=${() => this._graphCall('residue', (api, graphId) => api.setResidueDays(graphId, value))}>Save</button>
        ${current !== null ? html`<button class="link" @click=${() => this._graphCall('residue', (api, graphId) => api.setResidueDays(graphId, null))}>Reset to default</button>` : nothing}
      </div>
      ${!valid ? html`<p class="error">Use a whole number from 0 to 60.</p>` : nothing}
    </section>`
  }

  private _renderExclusions(): TemplateResult {
    const { folders, documents } = this._exclusions
    const folderName = new Map(this._targets.folders.map(t => [t.id, t]))
    const documentName = new Map(this._targets.documents.map(t => [t.id, t]))
    const name = (target: DreamingTarget | undefined, id: string): string =>
      target ? (target.path ? `${target.path} / ${target.label}` : target.label) : id
    const remaining = (kind: 'folders' | 'documents') =>
      this._targets[kind].filter(t => !this._exclusions[kind].includes(t.id))
    return html`<section data-dreaming="exclusions">
      <h3>Kept out of dreams</h3>
      <p class="muted">Excluding a folder keeps out everything inside it. ${folders.length + documents.length === 0 ? 'Nothing is excluded: the whole graph dreams.' : ''}</p>
      ${folders.length + documents.length > 0 ? html`<ul class="chips" data-dream-exclusions>
        ${folders.map(id => html`<li>📁 ${name(folderName.get(id), id)}<button aria-label="Stop excluding" ?disabled=${this._busy !== null}
          @click=${() => this._setExclusions({ folders: folders.filter(f => f !== id), documents })}>×</button></li>`)}
        ${documents.map(id => html`<li>${name(documentName.get(id), id)}<button aria-label="Stop excluding" ?disabled=${this._busy !== null}
          @click=${() => this._setExclusions({ folders, documents: documents.filter(d => d !== id) })}>×</button></li>`)}
      </ul>` : nothing}
      <div class="row">
        <select aria-label="Exclude a folder" data-exclude-folder ?disabled=${this._busy !== null || remaining('folders').length === 0}
          @change=${(event: Event) => {
            const select = event.target as HTMLSelectElement
            const id = select.value
            select.value = ''
            if (id) void this._setExclusions({ folders: [...folders, id], documents })
          }}>
          <option value="">Exclude a folder…</option>
          ${remaining('folders').map(t => html`<option value=${t.id}>${name(t, t.id)}</option>`)}
        </select>
        <input type="text" list="dream-documents" aria-label="Exclude a document" data-exclude-document
          placeholder="Exclude a document…" ?disabled=${this._busy !== null}
          @change=${(event: Event) => {
            const input = event.target as HTMLInputElement
            const typed = input.value.trim()
            const match = remaining('documents').find(t => name(t, t.id) === typed || t.label === typed || t.id === typed)
            input.value = ''
            if (match) void this._setExclusions({ folders, documents: [...documents, match.id] })
          }} />
        <datalist id="dream-documents">
          ${remaining('documents').map(t => html`<option value=${name(t, t.id)}></option>`)}
        </datalist>
      </div>
    </section>`
  }

  private _renderCycle(): TemplateResult {
    const graph = this._graph
    if (!graph) return html``
    const last = graph.lastCycle
    const cycle = this._cycle
    const hasDreamer = this._config.kind !== 'none'
    return html`<section data-dreaming="cycle">
      <h3>Last cycle</h3>
      ${isLastCycle(last)
        ? last.lastStartedMs === null
          ? html`<p class="muted" data-dream-last>This graph has not dreamed yet.</p>`
          : html`<p data-dream-last>${when(last.lastStartedMs)} · ${last.lastTrigger || 'unknown trigger'} · ${last.lastStatus || 'unknown status'}</p>`
        : html`<div class="error">The dream schedule record could not be read: ${last.error}</div>`}
      <p class="muted">The journal is the read-only “Dream Journal” document in _sophia. Each cycle replaces it.</p>
      <div class="row">
        <button data-dream-preview ?disabled=${this._busy !== null} @click=${() => this._dream(true)}>
          ${this._busy === 'preview' ? 'Preparing…' : 'Preview'}</button>
        ${this._confirmDream
          ? html`<button class="primary" data-dream-confirm ?disabled=${this._busy !== null} @click=${() => this._dream(false)}>
              Dream now with ${this._dreamerLabel(this._config)}</button>
            <button class="link" @click=${() => { this._confirmDream = false }}>Cancel</button>`
          : html`<button data-dream-now ?disabled=${!hasDreamer || this._busy !== null}
              @click=${() => { this._confirmDream = true }}>${this._busy === 'dream' ? 'Dreaming…' : 'Dream now…'}</button>`}
      </div>
      <p class="muted">Preview shows the exact prompts a cycle would send, without asking the dreamer or writing anything.</p>
      ${this._cycleError ? html`<div class="error" role="alert">${this._cycleError}</div>` : nothing}
      ${cycle ? this._renderCycleResult(cycle) : nothing}
    </section>`
  }

  private _renderCycleResult(cycle: DreamCycleResult): TemplateResult {
    const dreams = cycle.dreams ?? []
    const prompts = cycle.prompts ?? []
    const ok = cycle.status === 'prepared' || cycle.status === 'published' || cycle.status === 'succeeded'
    return html`<div class="receipt ${ok ? 'ok' : 'fail'}" data-dream-result>
      <strong>${cycle.dryRun ? 'Preview' : 'Cycle'}: ${cycle.status}</strong>
      ${cycle.reason ? html` — ${cycle.reason}` : nothing}
      ${cycle.error ? html`<br />${cycle.error}` : nothing}
      ${dreams.length ? html`<br /><span class="muted">${dreams.length} dream${dreams.length === 1 ? '' : 's'}${
        cycle.dryRun ? '' : `, ${dreams.filter(d => d.accepted).length} accepted`}</span>` : nothing}
      ${cycle.system ? html`<details><summary>The Dreamer prompt</summary><pre>${cycle.system}</pre></details>` : nothing}
      ${prompts.map((prompt, index) => html`<details><summary>Dream ${index + 1}: the prompt</summary><pre>${prompt}</pre></details>`)}
    </div>`
  }

  private _renderMechanics(): TemplateResult {
    const mechanics = this._mechanics
    if (!mechanics) return html``
    const agreed = mechanics.notice.agreed
    const locked = !agreed || this._busy !== null
    const dirty = Object.keys(this._mechanicsDraft).length > 0
    const field = (key: MechanicsKey, title: string, description: string, body: TemplateResult): TemplateResult => {
      const edited = mechanics.editable[key].edited
      const touched = this._mechanicsDraft[key] !== undefined
      return html`<div class="field" data-mechanics-field=${key}>
        <div class="field-head">
          <strong>${title}</strong>
          <span>
            ${edited ? html`<span class="badge">edited</span>` : nothing}
            ${edited || touched ? html`<button class="link" ?disabled=${!agreed || this._busy !== null}
              @click=${() => {
                const { [key]: _dropped, ...rest } = this._mechanicsDraft
                this._mechanicsDraft = rest
                if (edited) void this._saveMechanics(key)
              }}>Reset to house default</button>` : nothing}
          </span>
        </div>
        <p class="muted">${description}</p>
        ${body}
      </div>`
    }
    const numbers = <K extends 'chargeWeights' | 'scaling' | 'temporalCurve'>(key: K, labels: Record<string, string>, step: string) => {
      const value = this._mechanicsValue(key) as unknown as Record<string, number>
      return html`<div class="grid">${Object.entries(labels).map(([name, label]) => html`<label>${label}
        <input type="number" step=${step} .value=${String(value[name])} ?readonly=${!agreed} ?disabled=${locked && agreed}
          @input=${(event: Event) => {
            const next = Number((event.target as HTMLInputElement).value)
            if (Number.isFinite(next)) this._setDraft(key, { ...value, [name]: next })
          }} /></label>`)}</div>`
    }
    return html`<section data-dreaming="mechanics">
      <h3>Advanced: how Mycl dreams</h3>
      <p class="muted">These are always shown, so you can see exactly what runs through your dreamer.</p>
      <div class="notice">
        ${mechanics.notice.text}
        ${agreed
          ? html`<br /><span class="muted">Agreed ${when(epochMs(mechanics.notice.agreedAt))}. Editing is on.</span>`
          : html`<div class="row"><button data-mechanics-agree ?disabled=${this._busy !== null} @click=${() => this._agree()}>
              I understand. Let me edit these.</button></div>`}
      </div>
      ${field('dreamerPrompt', 'The Dreamer prompt', 'The system prompt every dream is written under.', html`<textarea
        aria-label="The Dreamer prompt" ?readonly=${!agreed} ?disabled=${locked && agreed}
        .value=${this._mechanicsValue('dreamerPrompt')}
        @input=${(event: Event) => this._setDraft('dreamerPrompt', (event.target as HTMLTextAreaElement).value)}></textarea>`)}
      ${field('chargeWeights', 'Charge weights', 'How a finding’s charge is scored, layer by layer.', numbers('chargeWeights', {
        embedding: 'Embedding', structural: 'Structural', valuation: 'Valuation', temporal: 'Temporal', articulability: 'Articulability',
      }, '0.01'))}
      ${field('scaling', 'Dreams per cycle', 'How many dreams a night, scaled by the size of the graph.', numbers('scaling', {
        maxDreamsPerCycle: 'Most dreams per cycle', scaleReferencePoint: 'Scale reference', scaleMin: 'Scale minimum', scaleMax: 'Scale maximum',
      }, '0.1'))}
      ${field('temporalCurve', 'Temporal curve', 'How the age of a passage changes its charge, in days.', numbers('temporalCurve', {
        troughDays: 'Trough (days)', capDays: 'Cap (days)',
      }, '1'))}
      ${field('astrologyEnabled', 'Astrology epigraph', 'The moon, the zodiac and a tarot card above each dream. They keep the dreams from repeating.', html`<label class="check">
        <input type="checkbox" .checked=${this._mechanicsValue('astrologyEnabled')} ?disabled=${locked}
          @change=${(event: Event) => this._setDraft('astrologyEnabled', (event.target as HTMLInputElement).checked)} />
        <span>Show the astrology epigraph</span></label>`)}
      ${this._mechanicsError ? html`<div class="error" role="alert">${this._mechanicsError}</div>` : nothing}
      ${agreed ? html`<div class="row">
        <button class="primary" data-mechanics-save ?disabled=${!dirty || this._busy !== null} @click=${() => this._saveMechanics()}>
          ${this._busy === 'mechanics' ? 'Saving…' : 'Save changes'}</button>
        ${dirty ? html`<button class="link" @click=${() => { this._mechanicsDraft = {} }}>Discard</button>` : nothing}
      </div>` : nothing}
      <details><summary>House-authored values (not editable)</summary><pre>${JSON.stringify(mechanics.houseAuthored, null, 2)}</pre></details>
    </section>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-dreaming-settings': MnDreamingSettings
  }
}
