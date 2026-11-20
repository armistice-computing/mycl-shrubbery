/**
 * mn-help-settings — Settings → Help (Eschaton, 2026-11-18).
 *
 * Three parts:
 *   1. ways to begin: six doors, a larger set than Home's welcome card, plus
 *      a button that shows the welcome card on Home again;
 *   2. "Add the latest Getting Started pages": a new graph holding the
 *      onboarding pages this version of Mycl carries;
 *   3. "Wipe everything and start over": three confirmations, the last by
 *      typing "delete". It is built to be safe for a stranger, not handy.
 *
 * The page sends events (help-actions.ts) and the shell does the work; parts
 * 2 and 3 need the desktop app's node, so `nativeAvailable` gates them.
 */
import { LitElement, css, html, unsafeCSS, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { icon, iconStyles } from '@shrubbery/components'
import {
  HELP_ADD_GETTING_STARTED_EVENT,
  HELP_DOOR_EVENT,
  HELP_SHOW_WELCOME_EVENT,
  HELP_WIPE_EVENT,
  wipeConfirmationMatches,
  type HelpDoor,
  type HelpDoorDetail,
  type HelpOutcome,
  type HelpRequestDetail,
} from './help-actions.js'

interface Door {
  readonly id: HelpDoor
  readonly title: string
  readonly note: string
  readonly icon: string
}

/** The doors, in the order a newcomer meets them. */
export const HELP_DOORS: readonly Door[] = [
  { id: 'start-here', title: 'Open Start Here', note: 'The short guide to what Mycl is and your first ten minutes.', icon: 'file-text' },
  { id: 'import', title: 'Bring in your notes', note: 'Markdown, text, PDFs, EPUB, Word or notebooks.', icon: 'folder' },
  { id: 'wires', title: 'Learn how wires work', note: 'Connect two passages and say how they relate.', icon: 'link' },
  { id: 'today', title: "Write today's note", note: 'A page for today, for quick thoughts.', icon: 'calendar' },
  { id: 'agent', title: 'Connect your agent', note: 'Let the agent you already use read and write here.', icon: 'bot' },
  { id: 'shortcuts', title: 'Keyboard shortcuts', note: 'Every shortcut in one list (⌘/).', icon: 'help-circle' },
]

type WipeStep = 0 | 1 | 2 | 3

@customElement('mn-help-settings')
export class MnHelpSettings extends LitElement {
  /** The desktop app's node is reachable, so seeding and wiping can run. */
  @property({ type: Boolean }) nativeAvailable = false

  @state() private busy: '' | 'add' | 'wipe' = ''
  @state() private outcome: (HelpOutcome & { readonly part: 'add' | 'wipe' }) | null = null
  @state() private wipeStep: WipeStep = 0
  @state() private typed = ''

  static styles = css`
    ${unsafeCSS(iconStyles)}
    :host { display: block; color: var(--mn-color-text-primary, #111827); font-size: var(--mn-text-sm, 13px); }
    section {
      padding: var(--mn-space-5, 20px) 0;
      border-top: 1px solid var(--mn-color-border-subtle, #e5e7eb);
    }
    section:first-of-type { border-top: 0; padding-top: 0; }
    h3 { margin: 0 0 var(--mn-space-2, 8px); font-size: var(--mn-text-md, 14px); font-weight: 600; }
    p { margin: 0 0 var(--mn-space-3, 12px); line-height: 1.5; max-width: 64ch; }
    .muted { color: var(--mn-color-text-secondary, #6b7280); }
    .doors {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: var(--mn-space-3, 12px);
      margin-bottom: var(--mn-space-3, 12px);
    }
    .door {
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-rows: auto auto;
      column-gap: var(--mn-space-2, 8px);
      row-gap: 2px;
      align-items: center;
      padding: var(--mn-space-3, 12px);
      border: 1px solid var(--mn-color-border-subtle, #d8ded9);
      border-radius: var(--mn-radius-control, 8px);
      background: var(--mn-color-surface-raised, #fff);
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .door:hover, .door:focus-visible { background: var(--mn-color-surface-hover, #f3f4f6); }
    .door:focus-visible { outline: 2px solid var(--mn-color-focus-ring, #2f6b4f); outline-offset: 2px; }
    .door-icon { display: inline-flex; grid-row: 1 / span 2; color: var(--mn-color-text-accent, #2f6b4f); }
    .door-title { font-weight: 600; }
    .door-note { grid-column: 2; color: var(--mn-color-text-secondary, #4b5563); }
    button.action {
      min-height: 30px;
      padding: 0 12px;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-control, 6px);
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-primary, #111827);
      font: inherit;
      cursor: pointer;
    }
    button.action.danger {
      border-color: var(--mn-color-border-danger, #e8b4b4);
      color: var(--mn-color-text-danger, #b91c1c);
    }
    button.action.danger.armed {
      border-color: var(--mn-color-text-danger, #b91c1c);
      background: var(--mn-color-text-danger, #b91c1c);
      color: var(--mn-color-text-on-accent, #fff);
    }
    button.action:disabled { opacity: 0.5; cursor: default; }
    .row { display: flex; flex-wrap: wrap; gap: var(--mn-space-2, 8px); align-items: center; }
    .confirm {
      margin-top: var(--mn-space-3, 12px);
      padding: var(--mn-space-4, 16px);
      border: 1px solid var(--mn-color-border-danger, #e8b4b4);
      border-radius: var(--mn-radius-surface, 10px);
      background: var(--mn-color-surface-danger-subtle, #fdf4f4);
      max-width: 640px;
    }
    .confirm p:last-of-type { margin-bottom: var(--mn-space-3, 12px); }
    .step { color: var(--mn-color-text-danger, #b91c1c); font-weight: 600; font-size: var(--mn-text-xs, 12px); margin-bottom: var(--mn-space-2, 8px); }
    input[type='text'] {
      min-height: 30px;
      box-sizing: border-box;
      padding: 0 10px;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-control, 6px);
      background: var(--mn-color-surface-raised, #fff);
      color: inherit;
      font: inherit;
    }
    .outcome[data-ok='true'] { color: var(--mn-color-text-success, #166534); }
    .outcome[data-ok='false'] { color: var(--mn-color-text-danger, #b91c1c); }
    [hidden] { display: none !important; }
  `

  private emit<T>(name: string, detail?: T): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }

  private request(part: 'add' | 'wipe', name: string): void {
    this.busy = part
    this.outcome = null
    const detail: HelpRequestDetail = {
      resolve: (outcome) => {
        this.busy = ''
        this.outcome = { ...outcome, part }
        if (part === 'wipe') {
          this.wipeStep = 0
          this.typed = ''
        }
      },
    }
    this.emit(name, detail)
  }

  private renderDoor(door: Door): TemplateResult {
    return html`<button
      type="button"
      class="door"
      data-help-door=${door.id}
      @click=${() => this.emit<HelpDoorDetail>(HELP_DOOR_EVENT, { door: door.id })}
    >
      <span class="door-icon" aria-hidden="true">${icon(door.icon, { size: 18 })}</span>
      <span class="door-title">${door.title}</span>
      <span class="door-note">${door.note}</span>
    </button>`
  }

  private renderOutcome(part: 'add' | 'wipe'): TemplateResult {
    const outcome = this.outcome?.part === part ? this.outcome : null
    return html`<p class="outcome" role="status" data-ok=${outcome ? String(outcome.ok) : 'true'} ?hidden=${!outcome}>${outcome?.message ?? ''}</p>`
  }

  private renderWipeConfirm(): TemplateResult {
    const step = this.wipeStep
    const cancel = html`<button type="button" class="action" data-wipe-cancel @click=${() => { this.wipeStep = 0; this.typed = '' }}>Cancel</button>`
    return html`<div class="confirm" data-wipe-step=${String(step)} ?hidden=${step === 0}>
      <div class="step">Step ${step} of 3</div>
      <div ?hidden=${step !== 1}>
        <p>This deletes every graph on this computer: all their documents, wires, files and history. Agents connected to them lose them too. It can't be undone.</p>
        <p>To keep a graph, export it first: Graph Ops → Export graph.</p>
        <div class="row">${cancel}<button type="button" class="action danger" data-wipe-next="1" @click=${() => { this.wipeStep = 2 }}>I understand, continue</button></div>
      </div>
      <div ?hidden=${step !== 2}>
        <p>Are you sure? Mycl makes one new graph with the Getting Started pages, opens it, then deletes all the others.</p>
        <div class="row">${cancel}<button type="button" class="action danger" data-wipe-next="2" @click=${() => { this.wipeStep = 3 }}>Yes, delete all my graphs</button></div>
      </div>
      <div ?hidden=${step !== 3}>
        <p>Type <strong>delete</strong> to confirm.</p>
        <div class="row">
          <input
            type="text"
            aria-label="Type delete to confirm"
            autocomplete="off"
            spellcheck="false"
            .value=${this.typed}
            @input=${(event: Event) => { this.typed = (event.target as HTMLInputElement).value }}
          />
          ${cancel}
          <button
            type="button"
            class="action danger armed"
            data-wipe-confirm
            ?disabled=${!wipeConfirmationMatches(this.typed) || this.busy !== ''}
            @click=${() => this.request('wipe', HELP_WIPE_EVENT)}
          >${this.busy === 'wipe' ? 'Wiping…' : 'Wipe everything'}</button>
        </div>
      </div>
    </div>`
  }

  render(): TemplateResult {
    const native = this.nativeAvailable
    return html`<div class="help">
      <section aria-labelledby="help-begin">
        <h3 id="help-begin">Ways to begin</h3>
        <div class="doors">${HELP_DOORS.map(door => this.renderDoor(door))}</div>
        <div class="row">
          <button type="button" class="action" data-help-show-welcome @click=${() => this.emit(HELP_SHOW_WELCOME_EVENT)}>Show the welcome card on Home</button>
        </div>
      </section>

      <section aria-labelledby="help-latest">
        <h3 id="help-latest">Add the latest Getting Started pages</h3>
        <p class="muted">Makes a new graph holding the Getting Started pages from this version of Mycl, and opens it. Your graphs aren't touched.</p>
        <div class="row">
          <button
            type="button"
            class="action"
            data-help-add-getting-started
            ?disabled=${!native || this.busy !== ''}
            @click=${() => this.request('add', HELP_ADD_GETTING_STARTED_EVENT)}
          >${this.busy === 'add' ? 'Adding…' : 'Add Getting Started pages'}</button>
          <span class="muted" ?hidden=${native}>Only in the desktop app.</span>
        </div>
        ${this.renderOutcome('add')}
      </section>

      <section aria-labelledby="help-wipe">
        <h3 id="help-wipe">Wipe everything and start over</h3>
        <p class="muted">Deletes every graph on this computer and leaves one new graph with the Getting Started pages. Mycl asks three times first.</p>
        <div class="row" ?hidden=${this.wipeStep !== 0}>
          <button
            type="button"
            class="action danger"
            data-wipe-start
            ?disabled=${!native || this.busy !== ''}
            @click=${() => { this.wipeStep = 1; this.outcome = null }}
          >Wipe everything…</button>
          <span class="muted" ?hidden=${native}>Only in the desktop app.</span>
        </div>
        ${this.renderWipeConfirm()}
        ${this.renderOutcome('wipe')}
      </section>
    </div>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-help-settings': MnHelpSettings
  }
}
