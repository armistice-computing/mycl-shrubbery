/**
 * mn-vault-preview-dialog - what a chosen vault holds, before anything comes in.
 *
 * Controlled: the host (cell/vault-import-controller.ts) scans, reviews and
 * follows the import job, and sets `phase` (the capture) and `step` (where
 * the flow is). The dialog only emits intents. Paths and warnings render as
 * text, never HTML. Every import makes a NEW graph; the vault is never changed.
 * The dialog never says an import stopped unless the job reports `abandoned`,
 * and offers the new graph only once it is `published`. An accepted or
 * building job with no worker shows as interrupted, never as progress.
 * "Open" needs the host's `canOpenGraph` (published, the expected graph, and
 * still there); a published graph that is gone shows the node's explanation.
 */

import { LitElement, css, html, nothing, unsafeCSS, type TemplateResult } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { SkinAware } from './skin-aware.js'
import { icon, iconStyles } from './icons.js'

export type MnVaultPreviewPhase = 'scanning' | 'ready' | 'expired' | 'refused' | 'failed' | 'cancelled'

export interface MnVaultPreviewEntry {
  readonly path: string
  readonly kind: 'directory' | 'note' | 'attachment'
  readonly bytes: number
}

export type MnVaultPreviewAction =
  | 'close'
  | 'cancel-scan'
  | 'show-more'
  | 'choose-again'
  | 'title'
  | 'review'
  | 'back'
  | 'confirm'
  | 'stop-import'
  | 'check-again'
  | 'open-graph'
  | 'recent'
  | 'open-recent'

export interface MnVaultPreviewActionDetail {
  readonly action: MnVaultPreviewAction
  /** For 'title': the new graph's name as typed. */
  readonly title?: string
  /** For 'open-recent': the job to follow. */
  readonly jobId?: string
}

/** Where the flow is. `capture` shows `phase`. */
export type MnVaultImportStep =
  | 'capture'
  | 'reviewing'
  | 'review'
  | 'review-failed'
  | 'starting'
  | 'job'
  | 'published'
  | 'abandoned'
  | 'recent'

export type MnVaultJobPhase = 'accepted' | 'building' | 'publishing' | 'uncertain' | 'published' | 'abandoned'

export interface MnVaultReview {
  readonly title: string
  readonly counts: {
    readonly sourceNotes: number
    readonly generatedTagHubs: number
    readonly attachments: number
    readonly folders: number
    readonly wires: number
  }
  readonly warnings: readonly { readonly path: string | null; readonly message: string }[]
  readonly omittedWarnings: number
  readonly supportedRefs: number
  readonly unmappedRefs: number
  /** Tag uses the tag pages gather, when the node reports it. */
  readonly tagReferences?: number | null
  readonly originalsPreserved: boolean
  /** When the preview closes, in ms since the epoch. */
  readonly expiresAt?: number | null
}

export interface MnVaultJob {
  readonly jobId?: string
  readonly phase: MnVaultJobPhase
  readonly title: string
  /** The node's words: why an uncertain job needs reconciling, or why a cancel did not stop it. */
  readonly error: string | null
  /** False when nothing is running the job right now. */
  readonly workerActive: boolean
  /** A Stop was asked for and the job has not settled yet. */
  readonly cancelRequested?: boolean
  /** For a published job: its graph is still there. */
  readonly destinationAvailable?: boolean
}

/** Accepted or building with no worker: interrupted, not in progress. */
export function mnVaultJobInterrupted(job: MnVaultJob): boolean {
  return (job.phase === 'accepted' || job.phase === 'building') && !job.workerActive
}

const KIND_LABEL: Record<MnVaultPreviewEntry['kind'], string> = {
  directory: 'Folder',
  note: 'Note',
  attachment: 'File',
}

export function formatVaultBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
}

@customElement('mn-vault-preview-dialog')
export class MnVaultPreviewDialog extends SkinAware(LitElement) {
  static styles = css`
    ${unsafeCSS(iconStyles)}

    :host {
      position: fixed;
      inset: 0;
      z-index: var(--mn-z-modal, 1400);
      display: none;
      align-items: center;
      justify-content: center;
      padding: var(--mn-space-4, 16px);
      color: var(--mn-color-text-primary, #111827);
      font-family: var(--mn-font-chrome, system-ui, sans-serif);
      box-sizing: border-box;
    }

    :host([open]) {
      display: flex;
    }

    .overlay {
      position: absolute;
      inset: 0;
      background: var(--mn-color-backdrop, rgba(15, 23, 42, 0.5));
    }

    .dialog {
      position: relative;
      display: flex;
      width: 100%;
      max-width: 640px;
      max-height: min(80vh, 640px);
      flex-direction: column;
      border-radius: var(--mn-radius-xl, 12px);
      background: var(--mn-color-surface-base, #fff);
      box-shadow: var(--mn-shadow-xl, var(--mn-shadow-modal, 0 24px 64px rgba(15, 23, 42, 0.2)));
    }

    .header {
      display: flex;
      align-items: center;
      gap: var(--mn-space-3, 12px);
      padding: var(--mn-space-4, 16px) var(--mn-space-6, 24px);
      border-bottom: 1px solid var(--mn-color-border-default, #d1d5db);
    }

    .title {
      flex: 1 1 auto;
      margin: 0;
      font-size: var(--mn-text-base, 15px);
      font-weight: 650;
    }

    .close-button {
      display: inline-flex;
      width: 28px;
      height: 28px;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 0;
      border-radius: var(--mn-radius-md, 6px);
      background: transparent;
      color: var(--mn-color-text-muted, #6b7280);
      cursor: pointer;
    }

    .close-button:hover,
    .close-button:focus-visible {
      background: var(--mn-color-surface-hover, #f3f4f6);
      color: var(--mn-color-text-primary, #111827);
      outline: none;
    }

    .body {
      display: flex;
      min-height: 0;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--mn-space-3, 12px);
      overflow: auto;
      padding: var(--mn-space-4, 16px) var(--mn-space-6, 24px);
      font-size: var(--mn-text-sm, 13px);
      line-height: 1.5;
    }

    .lead {
      margin: 0;
      color: var(--mn-color-text-secondary, #4b5563);
    }

    .scanning {
      display: flex;
      align-items: center;
      gap: var(--mn-space-3, 12px);
      padding: var(--mn-space-6, 24px) 0;
      color: var(--mn-color-text-secondary, #4b5563);
    }

    .spinner {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      border: 2px solid var(--mn-color-border-default, #d1d5db);
      border-top-color: var(--mn-color-accent, #4a8b6f);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }

    @media (prefers-reduced-motion: reduce) {
      .spinner { animation-duration: 3s; }
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .totals {
      margin: 0;
      font-weight: 600;
    }

    .entries {
      margin: 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--mn-color-border-default, #d1d5db);
      border-radius: var(--mn-radius-md, 6px);
    }

    .entry {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: var(--mn-space-3, 12px);
      padding: 6px var(--mn-space-3, 12px);
      border-top: 1px solid var(--mn-color-border-subtle, #eef0f3);
    }

    .entry:first-child {
      border-top: 0;
    }

    .path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mn-font-mono, ui-monospace, monospace);
      font-size: 12px;
    }

    .kind,
    .size {
      color: var(--mn-color-text-muted, #6b7280);
      font-size: 12px;
      white-space: nowrap;
    }

    .size {
      min-width: 56px;
      text-align: right;
    }

    .message {
      margin: 0;
      padding: var(--mn-space-4, 16px) 0;
    }

    .note {
      margin: 0;
      color: var(--mn-color-text-muted, #6b7280);
      font-size: 12px;
    }

    .footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: var(--mn-space-2, 8px);
      padding: var(--mn-space-3, 12px) var(--mn-space-6, 24px);
      border-top: 1px solid var(--mn-color-border-default, #d1d5db);
    }

    [hidden] {
      display: none !important;
    }

    /* Groups a template's parts without adding a box. Each part a template
       binds sits inside an element, never at the template's top level. */
    .stack {
      display: contents;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .field label {
      font-weight: 600;
    }

    .field input {
      padding: 6px 10px;
      border: 1px solid var(--mn-color-border-default, #d1d5db);
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-base, #fff);
      color: var(--mn-color-text-primary, #111827);
      font: inherit;
    }

    .field input:focus-visible {
      outline: 2px solid var(--mn-color-border-focus, #2563eb);
      outline-offset: 1px;
    }

    .counts {
      margin: 0;
      padding-left: 1.2em;
    }

    .counts li {
      margin: 2px 0;
    }

    .promise {
      margin: 0;
      padding: var(--mn-space-3, 12px);
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-subtle, #f6f7f9);
      color: var(--mn-color-text-secondary, #4b5563);
    }

    .warnings {
      margin: 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--mn-color-border-default, #d1d5db);
      border-radius: var(--mn-radius-md, 6px);
    }

    .warnings li {
      padding: 6px var(--mn-space-3, 12px);
      border-top: 1px solid var(--mn-color-border-subtle, #eef0f3);
    }

    .warnings li:first-child {
      border-top: 0;
    }

    .warnings .path {
      display: block;
      color: var(--mn-color-text-muted, #6b7280);
    }

    .phases {
      display: flex;
      gap: var(--mn-space-2, 8px);
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 12px;
      color: var(--mn-color-text-muted, #6b7280);
    }

    .phases li[data-state='done'] {
      color: var(--mn-color-text-secondary, #4b5563);
    }

    .phases li[data-state='now'] {
      color: var(--mn-color-text-primary, #111827);
      font-weight: 600;
    }

    .footer .note {
      flex: 1 1 200px;
    }

    button.action {
      padding: 6px 12px;
      border: 1px solid var(--mn-color-border-default, #d1d5db);
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-base, #fff);
      color: var(--mn-color-text-primary, #111827);
      font: inherit;
      font-size: var(--mn-text-sm, 13px);
      cursor: pointer;
    }

    button.action.primary {
      border-color: var(--mn-color-accent, #4a8b6f);
      background: var(--mn-color-accent, #4a8b6f);
      color: var(--mn-color-text-on-accent, #fff);
    }

    button.action.link {
      margin-right: auto;
      border-color: transparent;
      background: transparent;
      color: var(--mn-color-text-secondary, #4b5563);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    button.action:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    button.action:focus-visible {
      outline: 2px solid var(--mn-color-border-focus, #2563eb);
      outline-offset: 2px;
    }
  `

  @property({ type: Boolean, reflect: true }) open = false
  @property({ type: String }) phase: MnVaultPreviewPhase = 'scanning'
  /** What was chosen, for the title: a folder or a .zip. */
  @property({ type: String }) sourceKind: 'folder' | 'zip' = 'folder'
  @property({ attribute: false }) entries: readonly MnVaultPreviewEntry[] = []
  @property({ type: Number }) totalEntries = 0
  @property({ type: Boolean }) hasMore = false
  @property({ type: Boolean }) loadingMore = false
  /** The reason, for the failed phase, in the node's words. */
  @property({ type: String }) errorText = ''
  /** True once the node can review and import a capture, not only show it. */
  @property({ type: Boolean }) importAvailable = false
  @property({ type: String }) step: MnVaultImportStep = 'capture'
  /** The new graph's name, as typed before review. */
  @property({ type: String }) graphTitle = ''
  @property({ attribute: false }) review: MnVaultReview | null = null
  @property({ attribute: false }) job: MnVaultJob | null = null
  @property({ type: Boolean }) stopping = false
  @property({ type: Boolean }) stopRefused = false
  /** Why the node did not stop the job, in its words. */
  @property({ type: String }) stopExplanation = ''
  /** Published, the expected graph, and still there. Only then is Open offered. */
  @property({ type: Boolean }) canOpenGraph = false
  /** The scan must be chosen again (after a restart). */
  @property({ type: Boolean }) needsReselect = false
  /** A confirm's reply was lost: an import may or may not have started. */
  @property({ type: Boolean }) confirmUnknown = false
  @property({ attribute: false }) recent: readonly MnVaultJob[] | null = null
  @property({ type: Boolean }) recentComplete = false
  @property({ type: Boolean }) recentLoading = false
  /** The clock for the preview countdown. Tests set it. */
  @property({ attribute: false }) now: () => number = () => Date.now()

  private countdown: ReturnType<typeof setInterval> | null = null

  override updated(): void {
    const ticking = this.open && this.step === 'review' && typeof this.review?.expiresAt === 'number'
    if (ticking && !this.countdown) this.countdown = setInterval(() => this.requestUpdate(), 1000)
    if (!ticking && this.countdown) { clearInterval(this.countdown); this.countdown = null }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    if (this.countdown) { clearInterval(this.countdown); this.countdown = null }
  }
  @property({ type: Boolean }) checkFailed = false
  /** For review-failed and the job steps: what the node said. */
  @property({ type: String }) stepError = ''

  private emit(action: MnVaultPreviewAction, title?: string, jobId?: string): void {
    const detail: MnVaultPreviewActionDetail = jobId !== undefined
      ? { action, jobId }
      : title === undefined ? { action } : { action, title }
    this.dispatchEvent(new CustomEvent<MnVaultPreviewActionDetail>('mn-vault-preview-action', {
      detail,
      bubbles: true,
      composed: true,
    }))
  }

  /** What Escape, the backdrop and the close button do. */
  private dismissAction(): MnVaultPreviewAction {
    return this.step === 'capture' && this.phase === 'scanning' ? 'cancel-scan' : 'close'
  }

  private onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && this.step === 'capture' && this.phase === 'ready'
      && (event.target as HTMLElement | null)?.tagName === 'INPUT') {
      event.preventDefault()
      if (this.canReview()) this.emit('review')
      return
    }
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    this.emit(this.dismissAction())
  }

  private canReview(): boolean {
    return this.importAvailable && this.graphTitle.trim().length > 0
  }

  private renderEntries(): TemplateResult {
    return html`
      <ul class="entries" aria-label="What the vault holds">
        ${this.entries.map(entry => html`
          <li class="entry">
            <span class="path" title=${entry.path}>${entry.path}</span>
            <span class="kind">${KIND_LABEL[entry.kind]}</span>
            <span class="size">${entry.kind === 'directory' ? '' : formatVaultBytes(entry.bytes)}</span>
          </li>
        `)}
      </ul>
    `
  }

  private totalsLine(): string {
    const shown = this.entries.length
    if (shown >= this.totalEntries) {
      const notes = this.entries.filter(entry => entry.kind === 'note').length
      const files = this.entries.filter(entry => entry.kind === 'attachment').length
      const folders = this.entries.filter(entry => entry.kind === 'directory').length
      const parts = [plural(notes, 'note'), plural(files, 'other file'), plural(folders, 'folder')]
      return `Found ${parts.join(', ')}.`
    }
    return `Found ${plural(this.totalEntries, 'item')}. Showing the first ${shown.toLocaleString()}.`
  }

  /** Files, not folders: what an import would bring in, once every page is read. */
  private importCount(): number | null {
    if (this.entries.length < this.totalEntries) return null
    return this.entries.filter(entry => entry.kind !== 'directory').length
  }

  private renderReview(review: MnVaultReview): TemplateResult {
    const c = review.counts
    const items: TemplateResult[] = [
      html`<li>${plural(c.sourceNotes, 'note')} become${c.sourceNotes === 1 ? 's a document' : ' documents'}</li>`,
    ]
    if (c.generatedTagHubs > 0) {
      const uses = review.tagReferences ? ` (${plural(review.tagReferences, 'tag use')} in all)` : ''
      items.push(html`<li>${plural(c.generatedTagHubs, 'tag')} become${c.generatedTagHubs === 1 ? 's a page' : ' pages'} in a Tags folder, each wired to the notes that use it with “is an example of”${uses}</li>`)
    }
    if (c.attachments > 0) items.push(html`<li>${plural(c.attachments, 'other file')}, like images and PDFs, come${c.attachments === 1 ? 's' : ''} in with the notes</li>`)
    if (c.folders > 0) items.push(html`<li>${plural(c.folders, 'folder')} from the vault keep${c.folders === 1 ? 's its' : ' their'} place</li>`)
    if (c.wires > 0) items.push(html`<li>${plural(c.wires, 'wire')} in the new graph, from links and tags</li>`)
    const refs = review.supportedRefs + review.unmappedRefs
    return html`<div class="stack">
      <p class="lead">This is what importing will make, in a new graph called “${review.title}”. Nothing has come in yet.</p>
      <ul class="counts">${items}</ul>
      ${refs > 0 ? html`<p class="note">${this.referencesLine(review)}</p>` : nothing}
      ${this.renderCountdown(review)}
      <p class="promise">Your vault is never changed. Everything lands in the new graph, and this graph is not touched.${review.originalsPreserved ? ' Each document keeps its original file, unchanged.' : ''}</p>
      ${review.warnings.length > 0 ? html`<div class="stack">
        <p class="totals">Worth knowing</p>
        <ul class="warnings" aria-label="Warnings">
          ${review.warnings.map(w => html`<li>${w.path ? html`<span class="path">${w.path}</span>` : nothing}${w.message}</li>`)}
        </ul>
        ${review.omittedWarnings > 0 ? html`<p class="note">And ${plural(review.omittedWarnings, 'more warning')}.</p>` : nothing}
      </div>` : nothing}
    </div>`
  }

  /** Shown in the last minute of a preview's life. */
  private renderCountdown(review: MnVaultReview): TemplateResult | typeof nothing {
    if (typeof review.expiresAt !== 'number') return nothing
    const seconds = Math.ceil((review.expiresAt - this.now()) / 1000)
    if (seconds >= 60) return nothing
    if (seconds <= 0) return html`<p class="note" role="status">This preview has closed. Scan the vault again to import it.</p>`
    return html`<p class="note" role="status">This preview closes in ${plural(seconds, 'second')}. After that, scan the vault again.</p>`
  }

  /** Resolved, not "clickable": some resolve as document-level wires. */
  private referencesLine(review: MnVaultReview): string {
    const resolved = `${plural(review.supportedRefs, 'reference')} resolved`
    const u = review.unmappedRefs
    if (u === 0) return `${resolved}.`
    return `${resolved}, ${u.toLocaleString()} couldn't be matched and stay${u === 1 ? 's' : ''} as written.`
  }

  private renderPhases(phase: MnVaultJobPhase): TemplateResult {
    const order: MnVaultJobPhase[] = ['accepted', 'building', 'publishing']
    const label: Record<string, string> = { accepted: 'Starting', building: 'Building', publishing: 'Finishing' }
    const at = phase === 'uncertain' ? 2 : order.indexOf(phase)
    return html`<ol class="phases" aria-label="Import progress">${order.map((p, i) => html`<li data-state=${i < at ? 'done' : i === at ? 'now' : 'later'}>${label[p]}</li>`)}</ol>`
  }

  private renderStopNote(): TemplateResult | typeof nothing {
    if (!this.stopRefused) return nothing
    return html`<p class="note">${this.stopExplanation
      ? `It didn't stop: ${this.stopExplanation}`
      : "It didn't stop: it was too late, and the new graph may already be finished."} Mycl is checking.</p>`
  }

  private renderInterrupted(job: MnVaultJob): TemplateResult {
    return html`<div class="stack">
      ${this.renderPhases(job.phase)}
      <p class="message"><strong>Interrupted — not running right now.</strong></p>
      <p class="note">The import into “${job.title}” didn't finish. Nothing was published, and your vault is unchanged. Mycl keeps checking in case it picks up again.</p>
      ${job.error ? html`<p class="note">${job.error}</p>` : nothing}
      ${this.renderStopNote()}
      ${this.checkFailed ? html`<p class="note">The last check on the import didn't get an answer. Mycl will look again.</p>` : nothing}
    </div>`
  }

  private renderJob(job: MnVaultJob): TemplateResult {
    if (mnVaultJobInterrupted(job)) return this.renderInterrupted(job)
    let line: string
    if (job.cancelRequested && (job.phase === 'accepted' || job.phase === 'building')) {
      line = `Stopping the import into “${job.title}”…`
    } else switch (job.phase) {
      case 'accepted': line = `Starting the import into “${job.title}”…`; break
      case 'building': line = `Building “${job.title}”. It stays hidden until every note is in.`; break
      case 'publishing': line = `Finishing “${job.title}”. This can't be stopped now.`; break
      default: line = `Mycl can't confirm yet whether “${job.title}” was finished. It keeps checking, and it won't make a second copy.`
    }
    return html`<div class="stack">
      ${this.renderPhases(job.phase)}
      <div class="scanning" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span>${line}</span>
      </div>
      ${job.phase === 'uncertain' && job.error ? html`<p class="note">${job.error}</p>` : nothing}
      ${this.renderStopNote()}
      ${this.checkFailed ? html`<p class="note">The last check on the import didn't get an answer. The import itself is unaffected. Mycl will look again.</p>` : nothing}
      ${this.stepError ? html`<p class="note">${this.stepError}</p>` : nothing}
      <p class="note">You can close this. The import keeps going.</p>
    </div>`
  }

  private renderStep(): TemplateResult | null {
    switch (this.step) {
      case 'capture':
        return null
      case 'reviewing':
        return html`<div class="scanning" role="status"><span class="spinner" aria-hidden="true"></span><span>Working out what the import will make… Nothing comes in yet.</span></div>`
      case 'review':
        return this.review ? this.renderReview(this.review) : html`<p class="message">The review is missing. Go back and try again.</p>`
      case 'review-failed':
        if (this.needsReselect) {
          return html`<div class="stack">
            <p class="message">Choose the vault again to import it. After Mycl restarts, a scan can't be imported until the vault is chosen again. Nothing came in, and your vault is unchanged.</p>
            <p class="note" ?hidden=${!this.stepError}>${this.stepError}</p>
          </div>`
        }
        return html`
          <p class="message">The import couldn't be prepared. Nothing came in, and your vault is unchanged.</p>
          <p class="note" ?hidden=${!this.stepError}>${this.stepError}</p>
        `
      case 'starting':
        return html`<div class="scanning" role="status"><span class="spinner" aria-hidden="true"></span><span>Starting the import…</span></div>`
      case 'job':
        if (this.confirmUnknown) {
          return html`<div class="stack">
            <p class="message">Mycl hasn't confirmed the import yet. It may still start. Mycl keeps looking for it and won't start it again on its own.</p>
            <p class="note">Check again to look now, or open Recent imports.</p>
            <p class="note" ?hidden=${!this.stepError}>${this.stepError}</p>
          </div>`
        }
        return this.job ? this.renderJob(this.job) : html`<div class="stack">
          <p class="message">Checking on the import…</p>
          <p class="note" ?hidden=${!this.checkFailed}>The check didn't get an answer. Check again to retry.</p>
          <p class="note" ?hidden=${!this.stepError}>${this.stepError}</p>
        </div>`
      case 'published': {
        const c = this.review?.counts
        const name = this.job?.title ?? this.review?.title ?? ''
        if (!this.canOpenGraph) {
          return html`<div class="stack">
            <p class="message">“${name}” was imported, but Mycl can't open it.</p>
            <p class="note">${this.job?.error || this.stepError || 'Its graph is no longer here. Mycl will not make it again.'}</p>
          </div>`
        }
        return html`<div class="stack">
          <p class="message">“${name}” is ready.</p>
          ${c ? html`<p class="note">${plural(c.sourceNotes, 'note')}${c.generatedTagHubs > 0 ? `, ${plural(c.generatedTagHubs, 'tag page')}` : ''}${c.attachments > 0 ? `, ${plural(c.attachments, 'file')}` : ''} and ${plural(c.wires, 'wire')} came in. Your vault was not changed.</p>` : nothing}
        </div>`
      }
      case 'abandoned':
        return html`<p class="message">The import was stopped before the new graph was finished. No graph was added, and your vault is unchanged.</p>`
      case 'recent':
        return this.renderRecent()
    }
  }

  private recentPhase(job: MnVaultJob): string {
    if (mnVaultJobInterrupted(job)) return 'Interrupted'
    switch (job.phase) {
      case 'accepted':
      case 'building': return job.cancelRequested ? 'Stopping' : 'Running'
      case 'publishing': return 'Finishing'
      case 'uncertain': return 'Checking'
      case 'published': return job.destinationAvailable ? 'Ready' : 'Graph removed'
      case 'abandoned': return 'Stopped'
    }
  }

  private renderRecent(): TemplateResult {
    if (this.recentLoading || this.recent === null) {
      return html`<div class="scanning" role="status"><span class="spinner" aria-hidden="true"></span><span>Looking up recent imports…</span></div>`
    }
    if (this.recent.length === 0) {
      return html`<div class="stack">
        <p class="message">No recent imports.</p>
        <p class="note" ?hidden=${!this.stepError}>${this.stepError}</p>
      </div>`
    }
    return html`<div class="stack">
      <p class="lead">Imports from this computer, newest first. Opening one only checks on it; nothing is imported again.</p>
      <ul class="entries" aria-label="Recent imports">
        ${this.recent.map(job => html`
          <li class="entry">
            <span class="path" title=${job.title}>${job.title}</span>
            <span class="kind">${this.recentPhase(job)}</span>
            <button type="button" class="action" @click=${() => this.emit('open-recent', undefined, job.jobId ?? '')}>Open</button>
          </li>
        `)}
      </ul>
      ${this.recentComplete ? nothing : html`<p class="note">Showing the most recent ones only.</p>`}
    </div>`
  }

  /** The quiet way back to recent imports, wherever the flow has come to rest. */
  private recentEntry(): TemplateResult {
    return html`<button type="button" class="action link" @click=${() => this.emit('recent')}>Recent imports</button>`
  }

  private renderBody(): TemplateResult {
    const step = this.renderStep()
    if (step) return step
    switch (this.phase) {
      case 'scanning':
        return html`
          <div class="scanning" role="status">
            <span class="spinner" aria-hidden="true"></span>
            <span>Scanning… Nothing comes into the graph while this runs.</span>
          </div>
        `
      case 'ready':
        return html`
          <p class="lead">This is what the ${this.sourceKind === 'zip' ? '.zip' : 'folder'} holds. Nothing has come in yet, and the original is not changed.</p>
          <p class="totals">${this.totalsLine()}</p>
          <div class="list">${this.renderEntries()}</div>
          <div class="more" ?hidden=${!this.hasMore}><button
            type="button"
            class="action"
            ?disabled=${this.loadingMore}
            @click=${() => this.emit('show-more')}
          >${this.loadingMore ? 'Loading…' : 'Show more'}</button></div>
          <div class="stack">${this.importAvailable ? html`
            <div class="field">
              <label for="vault-graph-title">Name the new graph</label>
              <input
                id="vault-graph-title"
                type="text"
                maxlength="120"
                placeholder="My vault"
                .value=${this.graphTitle}
                @input=${(event: Event) => this.emit('title', (event.target as HTMLInputElement).value)}
              />
              <p class="note">Everything comes into a new graph with this name. This graph is not changed.</p>
            </div>
          ` : nothing}</div>
        `
      case 'expired':
        return html`<p class="message">This scan has expired: a chosen vault stays open for an hour. Choose it again to see it.</p>`
      case 'refused':
        return html`<p class="message">This scan belongs to a graph that has since been deleted or replaced. Choose the vault again.</p>`
      case 'cancelled':
        return html`<p class="message">The scan was stopped. Nothing came in.</p>`
      case 'failed':
        return html`
          <p class="message">The vault couldn't be scanned. Nothing came in.</p>
          <p class="note" ?hidden=${!this.errorText}>${this.errorText}</p>
        `
    }
  }

  private renderStepFooter(): TemplateResult | null {
    switch (this.step) {
      case 'capture':
        return null
      case 'reviewing':
      case 'starting':
        return html`<button type="button" class="action" @click=${() => this.emit('close')}>Close</button>`
      case 'review':
        return html`
          <button type="button" class="action" @click=${() => this.emit('back')}>Back</button>
          <button type="button" class="action primary" ?disabled=${!this.review} @click=${() => this.emit('confirm')}>Import into a new graph</button>
        `
      case 'review-failed':
        return html`<span class="stack">
          ${this.recentEntry()}
          <button type="button" class="action" @click=${() => this.emit('close')}>Close</button>
          ${this.needsReselect ? nothing : html`<button type="button" class="action" @click=${() => this.emit('back')}>Back</button>`}
          <button type="button" class="action primary" @click=${() => this.emit('choose-again')}>${this.needsReselect ? 'Choose the vault again' : 'Choose again'}</button>
        </span>`
      case 'job': {
        const phase = this.job?.phase
        const canStop = phase === 'accepted' || phase === 'building'
        const interrupted = this.job ? mnVaultJobInterrupted(this.job) : false
        return html`<span class="stack">
          ${this.confirmUnknown ? this.recentEntry() : nothing}
          <button type="button" class="action" @click=${() => this.emit('close')}>Close</button>
          ${phase === 'uncertain' || this.checkFailed || interrupted ? html`<button type="button" class="action" @click=${() => this.emit('check-again')}>Check again</button>` : nothing}
          ${canStop ? html`<button type="button" class="action" ?disabled=${this.stopping || !!this.job?.cancelRequested} @click=${() => this.emit('stop-import')}>${this.stopping || this.job?.cancelRequested ? 'Stopping…' : 'Stop'}</button>` : nothing}
        </span>`
      }
      case 'published':
        return html`<span class="stack">
          ${this.recentEntry()}
          <button type="button" class="action" @click=${() => this.emit('close')}>Close</button>
          ${this.canOpenGraph ? html`<button type="button" class="action primary" @click=${() => this.emit('open-graph')}>Open “${this.job?.title ?? ''}”</button>` : nothing}
        </span>`
      case 'abandoned':
        return html`<span class="stack">
          ${this.recentEntry()}
          <button type="button" class="action" @click=${() => this.emit('close')}>Close</button>
          <button type="button" class="action primary" @click=${() => this.emit('choose-again')}>Choose again</button>
        </span>`
      case 'recent':
        return html`<button type="button" class="action" @click=${() => this.emit('close')}>Close</button>`
    }
  }

  private renderFooter(): TemplateResult {
    const step = this.renderStepFooter()
    if (step) return step
    if (this.phase === 'scanning') {
      return html`<button type="button" class="action" @click=${() => this.emit('cancel-scan')}>Stop</button>`
    }
    if (this.phase === 'ready') {
      const n = this.importCount()
      const label = !this.importAvailable
        ? (n === null ? 'Import everything' : `Import ${plural(n, 'file')}`)
        : 'Review the import'
      return html`
        <p class="note" ?hidden=${this.importAvailable}>Importing a whole vault isn't available yet. This preview shows what it would bring in.</p>
        <span class="stack" ?hidden=${!this.importAvailable}>${this.recentEntry()}</span>
        <button type="button" class="action" @click=${() => this.emit('close')}>Close</button>
        <button
          type="button"
          class="action primary"
          ?disabled=${!this.canReview()}
          @click=${() => this.emit('review')}
        >${label}</button>
      `
    }
    return html`
      <span class="stack" ?hidden=${!this.importAvailable}>${this.recentEntry()}</span>
      <button type="button" class="action" @click=${() => this.emit('close')}>Close</button>
      <button type="button" class="action primary" @click=${() => this.emit('choose-again')}>Choose again</button>
    `
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.open) return nothing
    return html`
      <div class="overlay" @click=${() => this.emit(this.dismissAction())}></div>
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-preview-title"
        @keydown=${this.onKeydown}
      >
        <div class="header">
          <h2 class="title" id="vault-preview-title">Bring in a whole vault</h2>
          <button
            type="button"
            class="close-button"
            aria-label=${this.dismissAction() === 'cancel-scan' ? 'Stop and close' : 'Close'}
            @click=${() => this.emit(this.dismissAction())}
          >${icon('x', { size: 18 })}</button>
        </div>
        <div class="body">${this.renderBody()}</div>
        <div class="footer">${this.renderFooter()}</div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-vault-preview-dialog': MnVaultPreviewDialog
  }
}
