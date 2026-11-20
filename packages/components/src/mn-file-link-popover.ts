/**
 * mn-file-link-popover — what a click on a file link (`[[path#L10-L20]]`) shows:
 * the linked lines as they read now, one sentence on how they stand against what
 * was linked (changed, moved, gone), Copy path, and (when the host offers it) a
 * button that pulls the lines into the document. The element itself writes
 * nothing: the host fills `text`, `status` and `error` from the cell's
 * read_artifact answer, and runs the pull on `mn-file-link-pull`.
 */

import { LitElement, css, html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'

@customElement('mn-file-link-popover')
export class MnFileLinkPopover extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      z-index: 60;
      display: block;
      width: min(520px, calc(100vw - 32px));
      max-height: min(420px, calc(100vh - 32px));
      overflow: hidden;
      box-sizing: border-box;
      border: 1px solid var(--mn-color-border-subtle, rgba(0, 0, 0, 0.12));
      border-radius: 8px;
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-primary, #111);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
      font-family: var(--mn-font-utility, system-ui, sans-serif);
      font-size: var(--mn-type-ui-size, 13px);
    }
    :host([hidden]) { display: none; }
    header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--mn-color-border-subtle, rgba(0, 0, 0, 0.08));
    }
    .title { font-weight: 600; white-space: nowrap; }
    .path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--mn-color-text-muted, #6b7280);
      font-family: var(--mn-font-mono, ui-monospace, Menlo, monospace);
      font-size: 0.92em;
      direction: rtl;
      text-align: left;
    }
    .status, .error, .muted { padding: 8px 12px 0; line-height: 1.4; }
    .status { color: var(--mn-color-text-warning, #9a6700); }
    .error { color: var(--mn-color-text-danger, #b42318); }
    .muted { color: var(--mn-color-text-muted, #6b7280); }
    pre {
      margin: 8px 12px 0;
      padding: 8px 10px;
      max-height: 260px;
      overflow: auto;
      border-radius: 6px;
      background: var(--mn-color-surface-sunken, rgba(0, 0, 0, 0.04));
      font-family: var(--mn-font-mono, ui-monospace, Menlo, monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      padding: 10px 12px;
    }
    button.primary {
      border-color: var(--mn-color-accent, #2f6b4f);
      background: var(--mn-color-accent, #2f6b4f);
      color: var(--mn-color-text-on-accent, #fff);
    }
    button:disabled { opacity: 0.6; cursor: default; }
    .pull-error { padding: 8px 12px 0; color: var(--mn-color-text-danger, #b42318); line-height: 1.4; }
    button {
      font: inherit;
      padding: 4px 10px;
      border: 1px solid var(--mn-color-border-subtle, rgba(0, 0, 0, 0.15));
      border-radius: 6px;
      background: var(--mn-color-surface, #fff);
      color: inherit;
      cursor: pointer;
    }
  `

  /** The chip's words, "notes.md · lines 10–20". */
  @property({ type: String }) label = ''
  @property({ type: String }) path = ''
  @property({ type: Boolean }) loading = false
  /** The lines as they read now; null when there is nothing to show. */
  @property({ attribute: false }) text: string | null = null
  @property({ type: Boolean }) truncated = false
  /** One sentence: changed, moved, gone; empty when the lines stand as linked. */
  @property({ type: String }) status = ''
  /** Why the file can't be read now (missing, outside the allowed folders). */
  @property({ type: String }) error = ''
  /** A link to the whole file shows no lines. */
  @property({ type: Boolean }) wholeFile = false
  /** The pull button's words; empty offers no pull. */
  @property({ type: String }) pullLabel = ''
  @property({ type: Boolean }) pulling = false
  /** Why the pull failed, in the cell's words made plain. */
  @property({ type: String }) pullError = ''
  @property({ type: Number }) x = 0
  @property({ type: Number }) y = 0

  @state() private copied = false

  override updated(): void {
    this.style.left = `${this.x}px`
    this.style.top = `${this.y}px`
  }

  private async copyPath(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.path)
      this.copied = true
    } catch {
      this.copied = false
    }
  }

  private pull(): void {
    if (this.pulling) return
    this.dispatchEvent(new CustomEvent('mn-file-link-pull', { bubbles: true, composed: true }))
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('mn-close', { bubbles: true, composed: true }))
  }

  private renderBody() {
    if (this.loading) return html`<div class="muted" data-file-link-loading>Reading the file…</div>`
    if (this.error) return html`<div class="error" role="alert" data-file-link-error>${this.error}</div>`
    if (this.wholeFile) return html`<div class="muted" data-file-link-whole>This links the whole file.</div>`
    return html`<div class="lines">${this.status ? html`<div class="status" data-file-link-status>${this.status}</div>` : nothing}${this.text !== null ? html`<pre data-file-link-text>${this.text}</pre>` : nothing}${this.truncated ? html`<div class="muted">Showing the first lines only.</div>` : nothing}</div>`
  }

  protected override render() {
    return html`
      <section role="dialog" aria-label=${this.label || 'Linked file'} data-file-link-popover
        @keydown=${(event: KeyboardEvent) => { if (event.key === 'Escape') this.close() }}>
        <header>
          <span class="title">${this.label}</span>
          <span class="path" title=${this.path}>${this.path}</span>
        </header>
        ${this.renderBody()}
        ${this.pullError ? html`<div class="pull-error" role="alert" data-file-link-pull-error>${this.pullError}</div>` : nothing}
        <footer>
          ${this.pullLabel && !this.loading ? html`
            <button type="button" class="primary" data-action="pull" ?disabled=${this.pulling} @click=${() => this.pull()}>
              ${this.pulling ? 'Pulling…' : this.pullLabel}
            </button>
          ` : nothing}
          ${this.path ? html`
            <button type="button" data-action="copy-path" @click=${() => { void this.copyPath() }}>
              ${this.copied ? 'Copied' : 'Copy path'}
            </button>
          ` : nothing}
          <button type="button" data-action="close" @click=${() => this.close()}>Close</button>
        </footer>
      </section>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-file-link-popover': MnFileLinkPopover
  }
}
