/**
 * mn-files-settings — the Files page in Settings.
 *
 * Two parts:
 *   1. a plain list of the files this graph keeps or links to: name, kind,
 *      mode, size, how many documents use it, and its state when the backend
 *      reports one; each row can be downloaded;
 *   2. the allowed folders: the only places an agent may link a file from.
 *      Only the owner can read or change them.
 *
 * All effects go through `api`. Visible text says "file", never "artifact".
 */
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { isFileRootsNotOwnerError, type FilesSettingsApi } from './files-settings-api.js'
import {
  fileStatusLabel,
  filesListRows,
  rootsWith,
  rootsWithout,
  type FileRoot,
  type FilesListRow,
} from './files-settings-model.js'

export interface FilesRootsChangeDetail {
  readonly graphId: string
  readonly roots: readonly FileRoot[]
}

type Busy = 'list' | 'roots' | 'save-roots' | null

/** Status reads in flight at once; the list never waits on them. */
const STATE_BATCH = 4

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

@customElement('mn-files-settings')
export class MnFilesSettings extends LitElement {
  private openDocument(documentId: string): void {
    this.dispatchEvent(new CustomEvent<FilesOpenDocumentDetail>(FILES_OPEN_DOCUMENT_EVENT, {
      detail: { documentId },
      bubbles: true,
      composed: true,
    }))
  }

  static styles = css`
    button.origin {
      all: unset;
      cursor: pointer;
      color: var(--mn-color-text-link, var(--mn-color-accent, #2f6b4f));
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    button.origin:focus-visible {
      outline: 2px solid var(--mn-color-focus-ring, #2f6b4f);
      outline-offset: 2px;
      border-radius: 2px;
    }
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
    .files > section:first-of-type { border-top: 0; padding-top: 0; }
    h3 {
      margin: 0 0 var(--mn-space-2, 8px);
      font-size: var(--mn-text-md, 14px);
      font-weight: 600;
    }
    p { margin: 0 0 var(--mn-space-2, 8px); line-height: 1.5; }
    .muted { color: var(--mn-color-text-secondary, #6b7280); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
    }
    th, td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--mn-color-border-subtle, #e5e7eb);
      text-align: left;
      vertical-align: middle;
    }
    th {
      color: var(--mn-color-text-secondary, #6b7280);
      font-weight: 500;
      font-size: var(--mn-text-xs, 12px);
    }
    td.name { font-weight: 500; overflow-wrap: anywhere; }
    td.size, th.size { text-align: right; white-space: nowrap; }
    td.action { text-align: right; width: 1%; white-space: nowrap; }
    td.state { color: var(--mn-color-text-warning, #b45309); }
    button {
      min-height: 28px;
      padding: 0 10px;
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
    td.action { white-space: nowrap; }
    td.action button + button { margin-left: 6px; }
    .confirm { display: inline-flex; align-items: center; gap: 6px; white-space: normal; }
    .confirm-text { font-size: var(--mn-text-sm, 13px); color: var(--mn-color-text-secondary, #4b5563); min-width: 20ch; max-width: 34ch; text-align: right; }
    button:disabled { opacity: 0.5; cursor: default; }
    ul.roots { margin: var(--mn-space-2, 8px) 0; padding: 0; list-style: none; }
    ul.roots li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--mn-space-2, 8px);
      padding: 6px 0;
      border-bottom: 1px solid var(--mn-color-border-subtle, #e5e7eb);
    }
    ul.roots code {
      font-family: var(--mn-font-mono, ui-monospace, monospace);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .add {
      display: flex;
      flex-wrap: wrap;
      gap: var(--mn-space-2, 8px);
      margin-top: var(--mn-space-2, 8px);
    }
    input[type='text'] {
      flex: 1 1 260px;
      min-height: 30px;
      box-sizing: border-box;
      padding: 0 10px;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-primary, #111827);
      font-family: var(--mn-font-mono, ui-monospace, monospace);
      font-size: 12px;
    }
    .error {
      margin: var(--mn-space-2, 8px) 0;
      padding: var(--mn-space-2, 8px) var(--mn-space-3, 12px);
      border-radius: var(--mn-radius-md, 6px);
      line-height: 1.5;
      color: var(--mn-color-text-danger, #b91c1c);
      background: var(--mn-color-danger-surface, rgba(244, 63, 94, 0.08));
    }
  `

  @property({ attribute: false }) api: FilesSettingsApi | null = null
  @property({ type: String }) graphId = ''

  @state() private rows: readonly FilesListRow[] = []
  @state() private listLoaded = false
  @state() private listError = ''
  @state() private roots: readonly FileRoot[] = []
  @state() private rootsState: 'loading' | 'ready' | 'not-owner' | 'error' = 'loading'
  @state() private rootsError = ''
  @state() private rootsFileError = ''
  @state() private draftPath = ''
  @state() private busy: Busy = null
  @state() private downloading: string | null = null
  /** The row whose Remove is waiting for a second click, and the one being removed. */
  @state() private confirmingRemove: string | null = null
  @state() private removing: string | null = null
  /** Per-row words from the status route, filled in after the list shows. */
  @state() private states: Readonly<Record<string, string>> = {}
  private listGeneration = 0

  protected updated(changed: PropertyValues<this>): void {
    if ((changed.has('api') || changed.has('graphId')) && this.api) void this.load()
  }

  /** Read both parts again. */
  async load(): Promise<void> {
    await Promise.all([this.loadList(), this.loadRoots()])
  }

  private async loadList(): Promise<void> {
    const api = this.api
    if (!api) return
    this.busy = 'list'
    try {
      const generation = ++this.listGeneration
      const listing = await api.listFiles()
      if (api !== this.api || generation !== this.listGeneration) return
      this.rows = filesListRows(listing.records, listing.uses, listing.live ?? null)
      this.states = {}
      this.listError = ''
      if (listing.source === 'route') void this.loadStates(api, generation, this.rows.map(row => row.id))
    } catch (error) {
      this.listError = errorText(error)
    } finally {
      this.listLoaded = true
      if (this.busy === 'list') this.busy = null
    }
  }

  private async loadStates(api: FilesSettingsApi, generation: number, ids: readonly string[]): Promise<void> {
    for (let start = 0; start < ids.length; start += STATE_BATCH) {
      const batch = ids.slice(start, start + STATE_BATCH)
      const answers = await Promise.all(batch.map(id => api.fileState(id).catch(() => null)))
      if (api !== this.api || generation !== this.listGeneration) return
      const next = { ...this.states }
      batch.forEach((id, i) => {
        const label = fileStatusLabel(answers[i])
        if (label) next[id] = label
      })
      this.states = next
    }
  }

  private async loadRoots(): Promise<void> {
    const api = this.api
    if (!api) return
    this.rootsState = 'loading'
    try {
      const report = await api.getRoots()
      if (api !== this.api) return
      this.roots = report.roots
      this.rootsFileError = report.fileError ?? ''
      this.rootsState = 'ready'
      this.rootsError = ''
    } catch (error) {
      this.rootsState = isFileRootsNotOwnerError(error) ? 'not-owner' : 'error'
      this.rootsError = errorText(error)
    }
  }

  private async saveRoots(next: readonly FileRoot[]): Promise<void> {
    const api = this.api
    if (!api || this.busy === 'save-roots') return
    this.busy = 'save-roots'
    try {
      const report = await api.setRoots(next)
      this.roots = report.roots
      this.rootsFileError = report.fileError ?? ''
      this.rootsError = ''
      this.draftPath = ''
      this.dispatchEvent(new CustomEvent<FilesRootsChangeDetail>('mn-files-roots-change', {
        detail: { graphId: this.graphId, roots: report.roots },
        bubbles: true,
        composed: true,
      }))
    } catch (error) {
      this.rootsError = errorText(error)
    } finally {
      this.busy = null
    }
  }

  private addRoot(): void {
    const path = this.draftPath.trim()
    if (!path) return
    const next = rootsWith(this.roots, path)
    if (next.length === this.roots.length) {
      this.rootsError = 'That folder is already on the list.'
      return
    }
    void this.saveRoots(next)
  }

  private removeRoot(path: string): void {
    void this.saveRoots(rootsWithout(this.roots, path))
  }

  private async download(row: FilesListRow): Promise<void> {
    if (!this.api) return
    this.downloading = row.id
    try {
      await this.api.download(row)
      this.listError = ''
    } catch (error) {
      this.listError = errorText(error)
    } finally {
      this.downloading = null
    }
  }

  private async removeFile(row: FilesListRow): Promise<void> {
    if (!this.api) return
    this.removing = row.id
    try {
      await this.api.remove(row)
      this.listError = ''
      this.confirmingRemove = null
      await this.loadList()
    } catch (error) {
      this.listError = errorText(error)
    } finally {
      this.removing = null
    }
  }

  private renderRowActions(row: FilesListRow): TemplateResult {
    if (this.confirmingRemove === row.id) {
      return html`
        <span class="confirm" role="group" aria-label=${`Remove ${row.name}?`}>
          <span class="confirm-text">${row.origin
            ? 'Remove it? The document stays, but its original won’t open.'
            : 'Remove it from this graph?'}</span>
          <button
            type="button"
            class="danger"
            data-action="remove-confirm"
            ?disabled=${this.removing === row.id}
            @click=${() => { void this.removeFile(row) }}
          >${this.removing === row.id ? 'Removing…' : 'Remove'}</button>
          <button type="button" data-action="remove-cancel" @click=${() => { this.confirmingRemove = null }}>Keep</button>
        </span>
      `
    }
    return html`
      <button
        type="button"
        data-action="download"
        aria-label=${`Download ${row.name}`}
        ?disabled=${this.downloading === row.id}
        @click=${() => { void this.download(row) }}
      >${this.downloading === row.id ? 'Downloading…' : 'Download'}</button>
      <button
        type="button"
        class="danger"
        data-action="remove"
        aria-label=${`Remove ${row.name}`}
        @click=${() => { this.confirmingRemove = row.id }}
      >Remove</button>
    `
  }

  private renderList(): TemplateResult {
    const body = !this.listLoaded
      ? html`<p class="muted">Reading the files…</p>`
      : this.rows.length === 0 && !this.listError
        ? html`<p class="muted empty">No files yet. Files you drop in, and files your agents attach, appear here.</p>`
        : this.rows.length === 0
          ? nothing
          : html`
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Mode</th>
                  <th scope="col" class="size">Size</th>
                  <th scope="col">Used by</th>
                  <th scope="col">State</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                ${this.rows.map(row => html`
                  <tr data-file-id=${row.id}>
                    <td class="name">${row.name}</td>
                    <td class="kind">${row.kind}</td>
                    <td class="mode">${row.mode}</td>
                    <td class="size">${row.size}</td>
                    <td class="used-by">${row.origin ? html`Original of <button
                        type="button"
                        class="origin"
                        data-action="open-document"
                        @click=${() => this.openDocument(row.origin!.documentId)}
                      >${row.origin.title}</button>` : row.usedByLabel}</td>
                    <td class="state">${this.states[row.id] ?? row.state}</td>
                    <td class="action">${this.renderRowActions(row)}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `
    return html`
      <section class="list">
        <h3>Files in this graph</h3>
        ${this.listError ? html`<p class="error" role="alert">${this.listError}</p>` : nothing}
        ${body}
      </section>
    `
  }

  private renderRoots(): TemplateResult {
    const saving = this.busy === 'save-roots'
    let body: TemplateResult | typeof nothing = nothing
    if (this.rootsState === 'loading') {
      body = html`<p class="muted">Reading the folders…</p>`
    } else if (this.rootsState === 'not-owner') {
      body = html`<p class="muted not-owner">Only the owner of this graph can see and change these folders.</p>`
    } else if (this.rootsState === 'error') {
      body = html`<p class="error" role="alert">${this.rootsError}</p>`
    } else {
      body = html`<div class="roots-body">
        ${this.rootsFileError ? html`<p class="error" role="alert">The saved list could not be read: ${this.rootsFileError}</p>` : nothing}
        ${this.roots.length === 0
          ? html`<p class="muted no-roots">No folders yet, so agents cannot link to any file on this computer.</p>`
          : html`
            <ul class="roots">
              ${this.roots.map(root => html`
                <li data-root=${root.path}>
                  <code>${root.path}</code>
                  <button
                    type="button"
                    class="danger"
                    data-action="remove-root"
                    aria-label=${`Remove ${root.path}`}
                    ?disabled=${saving}
                    @click=${() => this.removeRoot(root.path)}
                  >Remove</button>
                </li>
              `)}
            </ul>
          `}
        ${this.rootsError ? html`<p class="error" role="alert">${this.rootsError}</p>` : nothing}
        <form class="add" @submit=${(event: Event) => { event.preventDefault(); this.addRoot() }}>
          <input
            type="text"
            name="path"
            placeholder="/Users/you/Documents/Papers"
            aria-label="Folder path"
            .value=${this.draftPath}
            ?disabled=${saving}
            @input=${(event: Event) => { this.draftPath = (event.target as HTMLInputElement).value }}
          />
          <button type="submit" class="primary" data-action="add-root" ?disabled=${saving || !this.draftPath.trim()}>Add folder</button>
        </form>
      </div>`
    }
    return html`
      <section class="roots-section">
        <h3>Allowed folders</h3>
        <p class="muted">Agents may link to files only inside these folders. Nothing outside them can be read.</p>
        ${body}
      </section>
    `
  }

  protected render(): TemplateResult {
    return html`<div class="files">${this.renderList()}${this.renderRoots()}</div>`
  }
}

/** Fired from an "Original of" link; main.ts closes Settings and opens it. */
export const FILES_OPEN_DOCUMENT_EVENT = 'mn-files-open-document'

export interface FilesOpenDocumentDetail {
  readonly documentId: string
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-files-settings': MnFilesSettings
  }
}
