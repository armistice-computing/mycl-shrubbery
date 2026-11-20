/**
 * mn-salience-config -- the importance view's scoring settings: the human
 * face of the `revaluate()` tool agents use. It shows how the composite score
 * weighs ratings, time and wires, and lets the reader change the weights, the
 * half-life and the two valuation prompts.
 *
 * The component holds no connection. Loading and saving are requests: it
 * dispatches SALIENCE_CONFIG_REQUEST_EVENT (bubbling, composed, cancelable)
 * and the shell claims it with preventDefault() and answers through
 * `detail.respond`. An unclaimed request means no cell is reachable here.
 */

import { LitElement, css, html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { SkinAware } from './skin-aware.js'

export interface SalienceConfigView {
  readonly importancePrompt: string
  readonly valencePrompt: string
  /** gardend's weight table: the keys below, plus any it adds later. */
  readonly weights: Readonly<Record<string, number>>
  /** How many earlier versions gardend has archived. */
  readonly historyCount: number
}

/** Only what changed; gardend keeps every field left out. */
export interface SalienceConfigPatch {
  readonly weights?: Readonly<Record<string, number>>
  readonly importancePrompt?: string
  readonly valencePrompt?: string
}

export type SalienceConfigResult = { readonly config: SalienceConfigView } | { readonly error: string }

export interface SalienceConfigRequestDetail {
  readonly action: 'load' | 'save'
  readonly patch?: SalienceConfigPatch
  respond(result: SalienceConfigResult): void
}

export const SALIENCE_CONFIG_REQUEST_EVENT = 'mn-salience-config-request'

interface Field {
  readonly key: string
  readonly label: string
  readonly hint: string
  readonly step: string
}

/** The six terms of the composite score, which gardend adds up. */
const WEIGHT_FIELDS: readonly Field[] = [
  { key: 'importance_weight', label: 'Importance', hint: 'How much importance ratings count.', step: '0.01' },
  { key: 'valence_weight', label: 'Valence', hint: 'How much the strength of valence counts, either way.', step: '0.01' },
  { key: 'temporal_weight', label: 'Freshness', hint: 'How much a recent valuation counts.', step: '0.01' },
  { key: 'block_wires_weight', label: 'Block wires', hint: 'How much wires on the block count.', step: '0.01' },
  { key: 'doc_wires_weight', label: 'Document wires', hint: 'How much wires on its document count.', step: '0.01' },
  { key: 'wire_freshness_weight', label: 'Fresh wires', hint: 'How much a recently made wire counts.', step: '0.01' },
]

const HALF_LIFE: Field = {
  key: 'half_life_days',
  label: 'Half-life (days)',
  hint: 'After this many days, freshness counts half.',
  step: '1',
}

/** Each signal is tanh(value / scale): at the scale it counts about three quarters. */
const SCALE_FIELDS: readonly Field[] = [
  { key: 'importance_ref', label: 'Importance scale', hint: 'Accumulated importance that counts about three quarters.', step: '0.5' },
  { key: 'valence_ref', label: 'Valence scale', hint: 'Accumulated valence that counts about three quarters.', step: '0.5' },
  { key: 'block_wires_ref', label: 'Block wires scale', hint: 'Wires on a block that count about three quarters.', step: '0.5' },
  { key: 'doc_wires_ref', label: 'Document wires scale', hint: 'Wires on a document that count about three quarters.', step: '0.5' },
]

const NUMBER_FIELDS: readonly Field[] = [...WEIGHT_FIELDS, HALF_LIFE, ...SCALE_FIELDS]

type Draft = Record<string, string>

function draftOf(config: SalienceConfigView): Draft {
  const draft: Draft = {
    importancePrompt: config.importancePrompt,
    valencePrompt: config.valencePrompt,
  }
  for (const field of NUMBER_FIELDS) {
    const value = config.weights[field.key]
    draft[field.key] = typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  }
  return draft
}

@customElement('mn-salience-config')
export class MnSalienceConfig extends SkinAware(LitElement) {
  static styles = css`
    :host {
      display: block;
      flex: none;
      color: var(--mn-color-text-primary, #1f2933);
      font: 0.8125rem/1.45 var(--mn-font-chrome, system-ui, sans-serif);
      border-bottom: 1px solid var(--mn-color-border-subtle, #e5e7eb);
      background: var(--mn-color-surface-editor, var(--mn-color-surface-base, #fffdf8));
    }
    :host([hidden]) {
      display: none;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      padding: 6px var(--mn-space-4, 16px);
      border: 0;
      background: transparent;
      color: var(--mn-color-text-secondary, #4b5563);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .toggle:hover {
      color: var(--mn-color-text-primary, #1f2933);
    }
    .chevron {
      display: inline-block;
      transition: transform 120ms ease;
    }
    :host([open]) .chevron {
      transform: rotate(90deg);
    }
    .panel {
      max-height: 55vh;
      overflow: auto;
      padding: 4px var(--mn-space-4, 16px) 12px;
    }
    .lede,
    .status {
      margin: 0 0 10px;
      color: var(--mn-color-text-tertiary, #6b7280);
    }
    .status[data-kind='error'] {
      color: var(--mn-color-text-danger, #b42318);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
      gap: 8px 16px;
      margin-bottom: 10px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .label {
      font-weight: 500;
    }
    .hint {
      color: var(--mn-color-text-tertiary, #6b7280);
      font-size: 0.75rem;
    }
    input,
    textarea {
      box-sizing: border-box;
      width: 100%;
      padding: 3px 6px;
      border: 1px solid var(--mn-color-border-default, #d1d5db);
      border-radius: var(--mn-radius-control, 4px);
      background: var(--mn-color-surface-base, #fff);
      color: inherit;
      font: inherit;
    }
    input[aria-invalid='true'],
    textarea[aria-invalid='true'] {
      border-color: var(--mn-color-border-danger, #b42318);
    }
    textarea {
      min-height: 10rem;
      resize: vertical;
      font-family: var(--mn-font-mono, ui-monospace, monospace);
      font-size: 0.75rem;
    }
    details {
      margin-bottom: 10px;
    }
    summary {
      margin-bottom: 8px;
      color: var(--mn-color-text-secondary, #4b5563);
      cursor: pointer;
    }
    .prompts {
      display: grid;
      gap: 8px;
      margin-bottom: 10px;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .save {
      padding: 4px 12px;
      border: 1px solid var(--mn-color-border-accent, #3d7f5f);
      border-radius: var(--mn-radius-control, 4px);
      background: var(--mn-color-accent, #2d6a4f);
      color: var(--mn-color-text-on-accent, #fff);
      font: inherit;
      cursor: pointer;
    }
    .save:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .sum {
      color: var(--mn-color-text-tertiary, #6b7280);
    }
  `

  /** Open shows the settings; the first open loads them. */
  @property({ type: Boolean, reflect: true }) open = false
  /** False when this graph cannot be written: the settings are read-only. */
  @property({ type: Boolean }) writable = true
  @property({ type: String, attribute: 'write-reason' }) writeReason = ''
  /** The graph these settings belong to: a new graph forgets the old one's. */
  @property({ type: String, attribute: 'graph-key' }) graphKey = ''

  @state() private config: SalienceConfigView | null = null
  @state() private draft: Draft = {}
  @state() private busy: 'loading' | 'saving' | null = null
  @state() private message: { kind: 'error' | 'info'; text: string } | null = null

  private requestToken = 0

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has('graphKey') && changed.get('graphKey') !== undefined) {
      this.requestToken += 1
      this.config = null
      this.draft = {}
      this.busy = null
      this.message = null
      if (this.open) this.load()
      return
    }
    // Every open reads afresh: an agent may have revaluated since.
    if (changed.has('open') && this.open && !this.busy) this.load()
  }

  /** Ask the shell for the current settings. */
  load(): void {
    this.request('load', undefined, 'loading')
  }

  private request(action: 'load' | 'save', patch: SalienceConfigPatch | undefined, busy: 'loading' | 'saving'): void {
    const token = ++this.requestToken
    this.busy = busy
    this.message = null
    const event = new CustomEvent<SalienceConfigRequestDetail>(SALIENCE_CONFIG_REQUEST_EVENT, {
      bubbles: true,
      composed: true,
      cancelable: true,
      detail: {
        action,
        ...(patch ? { patch } : {}),
        respond: result => {
          // A later request supersedes this one's answer.
          if (token !== this.requestToken) return
          this.busy = null
          if ('error' in result) {
            this.message = { kind: 'error', text: result.error }
            return
          }
          this.config = result.config
          this.draft = draftOf(result.config)
          if (action === 'save') this.message = { kind: 'info', text: 'Saved. What Has Become Important rebuilds with the new scoring.' }
        },
      },
    })
    this.dispatchEvent(event)
    if (!event.defaultPrevented) {
      this.busy = null
      this.message = { kind: 'error', text: 'Scoring settings need a running Mycl cell, and none answered here.' }
    }
  }

  private changedPatch(): SalienceConfigPatch | null {
    const config = this.config
    if (!config) return null
    const weights: Record<string, number> = {}
    for (const field of NUMBER_FIELDS) {
      const raw = (this.draft[field.key] ?? '').trim()
      if (raw === '') continue
      const value = Number(raw)
      if (!Number.isFinite(value)) continue
      if (value !== config.weights[field.key]) weights[field.key] = value
    }
    const patch: { weights?: Record<string, number>; importancePrompt?: string; valencePrompt?: string } = {}
    if (Object.keys(weights).length > 0) patch.weights = weights
    if (this.draft['importancePrompt'] !== config.importancePrompt) patch.importancePrompt = this.draft['importancePrompt'] ?? ''
    if (this.draft['valencePrompt'] !== config.valencePrompt) patch.valencePrompt = this.draft['valencePrompt'] ?? ''
    return Object.keys(patch).length > 0 ? patch : null
  }

  private invalidKeys(): ReadonlySet<string> {
    const invalid = new Set<string>()
    for (const field of NUMBER_FIELDS) {
      const raw = (this.draft[field.key] ?? '').trim()
      const value = Number(raw)
      const positive = field === HALF_LIFE || SCALE_FIELDS.includes(field)
      if (raw === '' || !Number.isFinite(value) || value < 0 || (positive && value === 0)) invalid.add(field.key)
    }
    // gardend ignores an empty prompt, so a blank one would "save" as nothing.
    for (const key of ['importancePrompt', 'valencePrompt']) {
      if ((this.draft[key] ?? '').trim() === '') invalid.add(key)
    }
    return invalid
  }

  private save(): void {
    const patch = this.changedPatch()
    if (!patch || !this.writable || this.invalidKeys().size > 0) return
    this.request('save', patch, 'saving')
  }

  private setDraft(key: string, value: string): void {
    this.draft = { ...this.draft, [key]: value }
  }

  private renderNumber(field: Field, invalid: ReadonlySet<string>) {
    return html`<label>
      <span class="label">${field.label}</span>
      <input
        type="text"
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        name=${field.key}
        .value=${this.draft[field.key] ?? ''}
        aria-invalid=${invalid.has(field.key) ? 'true' : 'false'}
        ?disabled=${!this.writable || this.busy !== null}
        @input=${(event: Event) => this.setDraft(field.key, (event.target as HTMLInputElement).value)}
      />
      <span class="hint">${field.hint}</span>
    </label>`
  }

  private renderPrompt(key: 'importancePrompt' | 'valencePrompt', label: string, invalid: ReadonlySet<string>) {
    return html`<label>
      <span class="label">${label}</span>
      <textarea
        name=${key}
        .value=${this.draft[key] ?? ''}
        aria-invalid=${invalid.has(key) ? 'true' : 'false'}
        ?disabled=${!this.writable || this.busy !== null}
        @input=${(event: Event) => this.setDraft(key, (event.target as HTMLTextAreaElement).value)}
      ></textarea>
    </label>`
  }

  private renderPanel() {
    if (!this.config) {
      return html`<div class="panel">
        <p class="status" data-kind=${this.message?.kind ?? 'info'}>
          ${this.message?.text ?? 'Loading the scoring settings…'}
        </p>
      </div>`
    }
    const invalid = this.invalidKeys()
    const patch = this.changedPatch()
    const sum = WEIGHT_FIELDS.reduce((total, field) => total + (Number(this.draft[field.key]) || 0), 0)
    return html`<div class="panel">
      <p class="lede">
        Each block's score is the sum of six signals, each times its weight. These are the
        settings revaluate() changes.${this.writable ? '' : ` ${this.writeReason || 'This graph is read-only here.'}`}
      </p>
      <div class="grid">${WEIGHT_FIELDS.map(field => this.renderNumber(field, invalid))}</div>
      <div class="grid">${this.renderNumber(HALF_LIFE, invalid)}</div>
      <details>
        <summary>Scales</summary>
        <div class="grid">${SCALE_FIELDS.map(field => this.renderNumber(field, invalid))}</div>
      </details>
      <details>
        <summary>Valuation prompts</summary>
        <div class="prompts">
          ${this.renderPrompt('importancePrompt', 'Importance prompt', invalid)}
          ${this.renderPrompt('valencePrompt', 'Valence prompt', invalid)}
        </div>
      </details>
      <div class="actions">
        <button
          type="button"
          class="save"
          ?disabled=${!this.writable || !patch || invalid.size > 0 || this.busy !== null}
          @click=${this.save}
        >${this.busy === 'saving' ? 'Saving…' : 'Save'}</button>
        <span class="sum">Weights add to ${sum.toFixed(2)} · ${this.config.historyCount} earlier
          ${this.config.historyCount === 1 ? 'version' : 'versions'} kept</span>
      </div>
      <p class="status" data-kind=${this.message?.kind ?? 'info'} ?hidden=${!this.message}>${this.message?.text ?? ''}</p>
    </div>`
  }

  render() {
    return html`<button
        type="button"
        class="toggle"
        aria-expanded=${this.open ? 'true' : 'false'}
        @click=${() => { this.open = !this.open }}
      ><span class="chevron" aria-hidden="true">›</span>How importance is scored</button>
      <div class="body">${this.open ? this.renderPanel() : nothing}</div>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-salience-config': MnSalienceConfig
  }
  interface HTMLElementEventMap {
    'mn-salience-config-request': CustomEvent<SalienceConfigRequestDetail>
  }
}
