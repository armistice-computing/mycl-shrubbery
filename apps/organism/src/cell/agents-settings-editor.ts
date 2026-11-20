/**
 * `<mn-agents-settings>`: the Connected agents page in Settings.
 *
 * Lists the agents connected to this app and connects new ones. A new agent's
 * key is shown once, inside the config for the harness the person picks, and
 * then forgotten: gardend keeps only a hash of it. Revoking asks first.
 * Re-issuing (also behind a confirm) gives a key a new secret in place: the
 * row keeps its position and the new key is shown once, like a new one.
 *
 * Model in agents-settings-model.ts, effects in agents-settings-api.ts.
 */

import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { isAgentsNotOwnerError, type AgentsSettingsApi } from './agents-settings-api.js'
import {
  AGENT_ACCESS_CHOICES,
  AGENT_EXPIRY_CHOICES,
  AGENT_HARNESSES,
  AGENT_SCOPE_GROUPS,
  DEFAULT_AGENT_EXPIRY_DAYS,
  DEFAULT_LAUNCH_INFO,
  DEVELOPER_ACCESS,
  agentConfigHint,
  agentConfigSnippet,
  agentRows,
  connectionTestText,
  createAgentRequest,
  orderAgentRows,
  reissueConfirmText,
  type AgentAccessKind,
  type AgentConnectionTest,
  type AgentHarness,
  type AgentLaunchInfo,
  type AgentRow,
} from './agents-settings-model.js'

interface CreatedView {
  readonly name: string
  readonly token: string
  /** gardend's MCP address; Test connection is offered only when it is known. */
  readonly mcpUrl: string | null
  /** A re-issue rather than a new connection: the words and Claude Code's command differ. */
  readonly reissued: boolean
}

type CopyTarget = 'key' | 'config' | 'command' | 'args' | 'env' | 'url' | 'header'

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

@customElement('mn-agents-settings')
export class MnAgentsSettings extends LitElement {
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
    .agents > section:first-of-type { border-top: 0; padding-top: 0; }
    h3 {
      margin: 0 0 var(--mn-space-2, 8px);
      font-size: var(--mn-text-md, 14px);
      font-weight: 600;
    }
    p { margin: 0 0 var(--mn-space-2, 8px); line-height: 1.5; }
    .muted { color: var(--mn-color-text-secondary, #6b7280); }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
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
    td.action { text-align: right; width: 1%; white-space: nowrap; }
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
    button:disabled { opacity: 0.5; cursor: default; }
    .row-actions { display: inline-flex; gap: 6px; align-items: center; }
    tr[hidden] { display: none; }
    tr.confirm-row td { padding-top: 0; text-align: right; color: var(--mn-color-text-secondary, #555); border-top: none; }
    td.state[data-state='expired'] { color: var(--mn-color-text-danger, #b91c1c); }
    td.state[data-state='expiring'] { color: var(--mn-color-text-warning, #b45309); }
    .pieces { display: grid; gap: 6px; }
    .piece {
      display: grid;
      grid-template-columns: minmax(120px, max-content) 1fr auto;
      gap: var(--mn-space-2, 8px);
      align-items: center;
    }
    .piece-label { color: var(--mn-color-text-secondary, #6b7280); }
    .piece code {
      font-family: var(--mn-font-mono, ui-monospace, monospace);
      font-size: 12px;
      overflow-wrap: anywhere;
      padding: 4px 8px;
      border-radius: var(--mn-radius-sm, 4px);
      background: var(--mn-color-surface-sunken, rgba(0, 0, 0, 0.04));
    }
    .by-address { margin-top: var(--mn-space-2, 8px); }
    .by-address summary { cursor: pointer; }
    .test-ok { color: var(--mn-color-text-success, #166534); }
    .form { display: grid; gap: var(--mn-space-3, 12px); max-width: 640px; }
    label.field, div.field { display: grid; gap: 4px; font-weight: 500; }
    input[type='text'] {
      min-height: 30px;
      box-sizing: border-box;
      padding: 0 10px;
      border: 1px solid var(--mn-color-border-subtle, #d1d5db);
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-raised, #fff);
      color: var(--mn-color-text-primary, #111827);
      font: inherit;
    }
    fieldset { margin: 0; padding: 0; border: 0; display: grid; gap: 6px; }
    legend { padding: 0 0 4px; font-weight: 500; }
    .choice {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 2px 8px;
      align-items: start;
      align-content: start;
      padding: 6px 8px;
      border: 1px solid var(--mn-color-border-subtle, #e5e7eb);
      border-radius: var(--mn-radius-md, 6px);
      cursor: pointer;
    }
    .choice input { margin: 3px 0 0; grid-row: span 2; }
    .choice .label { font-weight: 500; }
    .choice .description { color: var(--mn-color-text-secondary, #6b7280); }
    .groups {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 6px;
      margin: 4px 0 0 24px;
    }
    details summary { cursor: pointer; color: var(--mn-color-text-secondary, #6b7280); }
    details[open] summary { margin-bottom: 6px; }
    .warning { color: var(--mn-color-text-warning, #b45309); }
    .actions { display: flex; gap: var(--mn-space-2, 8px); }
    .key {
      display: grid;
      gap: var(--mn-space-3, 12px);
      padding: var(--mn-space-3, 12px);
      border: 1px solid var(--mn-color-accent, #4d8768);
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-accent-surface, rgba(77, 135, 104, 0.06));
    }
    .tabs { display: flex; gap: 4px; flex-wrap: wrap; }
    .tabs button[aria-pressed='true'] {
      border-color: var(--mn-color-accent, #4d8768);
      color: var(--mn-color-text-primary, #111827);
      font-weight: 600;
    }
    pre {
      margin: 0;
      padding: var(--mn-space-2, 8px) var(--mn-space-3, 12px);
      overflow-x: auto;
      border-radius: var(--mn-radius-md, 6px);
      background: var(--mn-color-surface-sunken, #f3f4f6);
      font-family: var(--mn-font-mono, ui-monospace, monospace);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
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

  @property({ attribute: false }) api: AgentsSettingsApi | null = null

  @state() private rows: readonly AgentRow[] = []
  @state() private listState: 'loading' | 'ready' | 'not-owner' | 'error' = 'loading'
  @state() private listError = ''
  @state() private formOpen = false
  @state() private name = ''
  @state() private kind: AgentAccessKind = 'full'
  @state() private groups: ReadonlySet<string> = new Set(['read-documents'])
  @state() private expiryDays = DEFAULT_AGENT_EXPIRY_DAYS
  @state() private creating = false
  @state() private formError = ''
  @state() private created: CreatedView | null = null
  @state() private harness: AgentHarness = 'claude-code'
  @state() private launch: AgentLaunchInfo | null = null
  @state() private copied: CopyTarget | '' = ''
  @state() private confirming: string | null = null
  @state() private revoking: string | null = null
  @state() private confirmingReissue: string | null = null
  @state() private reissuing: string | null = null
  @state() private testing = false
  @state() private testResult: AgentConnectionTest | null = null
  /** Token ids in the order the rows were last shown, so rows keep their places. */
  private order: string[] = []
  private generation = 0

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has('api')) void this.reload()
  }

  async reload(): Promise<void> {
    const api = this.api
    const generation = ++this.generation
    if (!api) return
    this.listState = 'loading'
    try {
      const [records, launch] = await Promise.all([api.list(), api.launchInfo()])
      if (generation !== this.generation) return
      this.rows = orderAgentRows(agentRows(records), this.order)
      this.order = this.rows.map(row => row.tokenId)
      this.launch = launch
      this.listState = 'ready'
      this.listError = ''
    } catch (error) {
      if (generation !== this.generation) return
      this.listState = isAgentsNotOwnerError(error) ? 'not-owner' : 'error'
      this.listError = message(error, 'Could not read the connected agents.')
    }
  }

  private openForm(): void {
    this.formOpen = true
    this.created = null
    this.formError = ''
    this.name = ''
    this.kind = 'full'
    this.groups = new Set(['read-documents'])
    this.expiryDays = DEFAULT_AGENT_EXPIRY_DAYS
  }

  private toggleGroup(id: string, checked: boolean): void {
    const next = new Set(this.groups)
    if (checked) next.add(id)
    else next.delete(id)
    this.groups = next
  }

  private get canCreate(): boolean {
    if (!this.name.trim() || this.creating) return false
    return this.kind !== 'custom' || this.groups.size > 0
  }

  private async create(event: Event): Promise<void> {
    event.preventDefault()
    const api = this.api
    if (!api || !this.canCreate) return
    this.creating = true
    this.formError = ''
    try {
      const request = createAgentRequest(this.name, this.kind, this.groups, this.expiryDays)
      const created = await api.create(request)
      this.created = { name: created.record.label, token: created.token, mcpUrl: created.mcpUrl ?? null, reissued: false }
      this.formOpen = false
      this.copied = ''
      this.testResult = null
      await this.reload()
    } catch (error) {
      this.formError = message(error, 'Could not connect the agent.')
    } finally {
      this.creating = false
    }
  }

  private async revoke(tokenId: string): Promise<void> {
    const api = this.api
    if (!api) return
    this.revoking = tokenId
    try {
      await api.revoke(tokenId)
      this.confirming = null
      await this.reload()
    } catch (error) {
      this.listError = message(error, 'Could not disconnect the agent.')
    } finally {
      this.revoking = null
    }
  }

  private async reissue(row: AgentRow): Promise<void> {
    const api = this.api
    if (!api) return
    this.reissuing = row.tokenId
    this.listError = ''
    try {
      const reissued = await api.reissue(row.tokenId)
      this.order = this.order.map(id => id === reissued.previousTokenId ? reissued.record.tokenId : id)
      this.confirmingReissue = null
      this.formOpen = false
      this.created = { name: reissued.record.label, token: reissued.token, mcpUrl: reissued.mcpUrl ?? null, reissued: true }
      this.copied = ''
      this.testResult = null
      await this.reload()
    } catch (error) {
      this.listError = message(error, 'Could not re-issue the key.')
    } finally {
      this.reissuing = null
    }
  }

  private async testConnection(created: CreatedView): Promise<void> {
    const api = this.api
    if (!api || !created.mcpUrl || this.testing) return
    this.testing = true
    this.testResult = null
    try {
      this.testResult = await api.testConnection(created.mcpUrl, created.token)
    } catch {
      this.testResult = { ok: false, reason: 'error' }
    } finally {
      this.testing = false
    }
  }

  private finishKeyCard(): void {
    this.created = null
    this.copied = ''
    this.testResult = null
  }

  private async copy(what: CopyTarget, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      this.copied = what
    } catch {
      this.copied = ''
    }
  }

  private renderList(): TemplateResult {
    if (this.listState === 'loading') return html`<p class="muted" role="status">Loading…</p>`
    if (this.listState === 'not-owner') return html`<p class="muted">Only the owner of this app can see and connect agents.</p>`
    if (this.listState === 'error') return html`<div class="error" role="alert">${this.listError}</div>`
    if (!this.rows.length) {
      return html`<p class="muted" data-empty>No agents yet. Connect one to let it read and write in your graphs.</p>`
    }
    return html`
      <div class="list">
        ${this.listError ? html`<div class="error" role="alert">${this.listError}</div>` : nothing}
        <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Access</th>
            <th scope="col">Connected</th>
            <th scope="col">Expires</th>
            <th scope="col">State</th>
            <th scope="col"><span class="muted">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${this.rows.map(row => html`
            <tr data-agent-id=${row.tokenId}>
              <td class="name">${row.name}</td>
              <td class="access">${row.access}</td>
              <td>${row.created}</td>
              <td>${row.expires}</td>
              <td class="state" data-state=${row.state}>${row.state === 'expired' ? 'Expired' : row.state === 'expiring' ? 'Expires soon' : ''}</td>
              <td class="action">
                ${this.confirmingReissue === row.tokenId ? html`
                  <span class="row-actions" data-reissue-confirm>
                    <button
                      type="button"
                      class="primary"
                      data-action="confirm-reissue"
                      ?disabled=${this.reissuing === row.tokenId}
                      @click=${() => { void this.reissue(row) }}
                    >${this.reissuing === row.tokenId ? 'Re-issuing…' : 'Re-issue key'}</button>
                    <button type="button" data-action="cancel-reissue" @click=${() => { this.confirmingReissue = null }}>Cancel</button>
                  </span>
                ` : this.confirming === row.tokenId ? html`
                  <span class="row-actions">
                    <span>Disconnect ${row.name}?</span>
                    <button
                      type="button"
                      class="danger"
                      data-action="confirm-revoke"
                      ?disabled=${this.revoking === row.tokenId}
                      @click=${() => { void this.revoke(row.tokenId) }}
                    >Disconnect</button>
                    <button type="button" data-action="cancel-revoke" @click=${() => { this.confirming = null }}>Keep</button>
                  </span>
                ` : html`
                  <span class="row-actions">
                    <button
                      type="button"
                      data-action="reissue"
                      aria-label=${`Re-issue the key for ${row.name}`}
                      @click=${() => { this.confirmingReissue = row.tokenId; this.confirming = null }}
                    >Re-issue key</button>
                    ${row.state === 'expired' ? nothing : html`
                      <button
                        type="button"
                        class="danger"
                        data-action="revoke"
                        aria-label=${`Disconnect ${row.name}`}
                        @click=${() => { this.confirming = row.tokenId; this.confirmingReissue = null }}
                      >Disconnect</button>
                    `}
                  </span>
                `}
              </td>
            </tr>
            <tr class="confirm-row" data-reissue-confirm-text ?hidden=${this.confirmingReissue !== row.tokenId}>
              <td colspan="6">${this.confirmingReissue === row.tokenId ? reissueConfirmText(row.name, row.state) : ''}</td>
            </tr>
          `)}
        </tbody>
      </table>
      </div>
    `
  }

  private renderChoice(choice: { kind: AgentAccessKind; label: string; description: string }): TemplateResult {
    return html`
      <label class="choice" data-access=${choice.kind}>
        <input
          type="radio"
          name="access"
          .value=${choice.kind}
          .checked=${this.kind === choice.kind}
          @change=${() => { this.kind = choice.kind }}
        />
        <span class="label">${choice.label}</span>
        <span class="description">${choice.description}</span>
      </label>
    `
  }

  private renderForm(): TemplateResult {
    return html`
      <div class="form" role="form" aria-label="Connect an agent">
        <label class="field">
          Name
          <input
            type="text"
            name="name"
            placeholder="Claude Code on my laptop"
            .value=${this.name}
            @input=${(event: Event) => { this.name = (event.target as HTMLInputElement).value }}
            @keydown=${(event: KeyboardEvent) => { if (event.key === 'Enter') void this.create(event) }}
          />
        </label>
        <fieldset>
          <legend>What it may do</legend>
          ${AGENT_ACCESS_CHOICES.map(choice => this.renderChoice(choice))}
          ${this.kind === 'custom' ? html`
            <div class="groups" role="group" aria-label="Custom access">
              ${AGENT_SCOPE_GROUPS.map(group => html`
                <label class="choice" data-group=${group.id}>
                  <input
                    type="checkbox"
                    .checked=${this.groups.has(group.id)}
                    @change=${(event: Event) => this.toggleGroup(group.id, (event.target as HTMLInputElement).checked)}
                  />
                  <span class="label">${group.label}</span>
                  <span class="description">${group.description}</span>
                </label>
              `)}
            </div>
          ` : nothing}
          <details ?open=${this.kind === 'developer'}>
            <summary>Advanced</summary>
            ${this.renderChoice(DEVELOPER_ACCESS)}
            <p class="warning">Only for building and testing Mycl itself. An agent with this can change anything in every graph.</p>
          </details>
        </fieldset>
        <div class="field">
          <span id="expiry-label">Expires after</span>
          <div class="tabs" role="group" aria-labelledby="expiry-label">
            ${AGENT_EXPIRY_CHOICES.map(choice => html`
              <button
                type="button"
                data-expiry=${String(choice.days)}
                aria-pressed=${choice.days === this.expiryDays ? 'true' : 'false'}
                @click=${() => { this.expiryDays = choice.days }}
              >${choice.label}</button>
            `)}
          </div>
        </div>
        ${this.formError ? html`<div class="error" role="alert">${this.formError}</div>` : nothing}
        <div class="actions">
          <button
            type="button"
            class="primary"
            data-action="create"
            ?disabled=${!this.canCreate}
            @click=${(event: Event) => { void this.create(event) }}
          >
            ${this.creating ? 'Connecting…' : 'Connect'}
          </button>
          <button type="button" data-action="cancel" @click=${() => { this.formOpen = false }}>Cancel</button>
        </div>
      </div>
    `
  }

  private renderCreated(created: CreatedView): TemplateResult {
    const launch = this.launch ?? DEFAULT_LAUNCH_INFO
    if (launch.translocated) return this.renderCreatedTranslocated(created)
    const snippet = agentConfigSnippet(this.harness, created.name, created.token, launch, { replace: created.reissued })
    return html`
      <div class="key" data-created ?data-reissued=${created.reissued}>
        <div>
          <h3>${created.reissued ? `${created.name} has a new key` : `${created.name} is connected`}</h3>
          <p>${created.reissued
            ? 'It is shown only now: put it in your agent\'s settings in place of the old one before you leave this page.'
            : 'This is its key. It is shown only now: copy it into your agent\'s settings before you leave this page.'}</p>
          <p class="muted" data-undo-note>Your agent's edits can't be undone with ⌘Z; version history can bring a document back.</p>
        </div>
        <div class="tabs" role="group" aria-label="Agent app">
          ${AGENT_HARNESSES.map(harness => html`
            <button
              type="button"
              data-harness=${harness.id}
              aria-pressed=${this.harness === harness.id ? 'true' : 'false'}
              @click=${() => { this.harness = harness.id; this.copied = '' }}
            >${harness.label}</button>
          `)}
        </div>
        <p class="muted">${agentConfigHint(this.harness)}</p>
        ${this.harness === 'other' ? this.renderOtherApp(created, launch) : html`<pre data-snippet>${snippet}</pre>`}
        ${this.launch ? nothing : html`
          <p class="muted" data-default-path>
            This assumes the app is in your Applications folder. If it is somewhere else, change the path to where it is.
          </p>
        `}
        <div class="actions">
          ${this.harness === 'other' ? nothing : html`
            <button type="button" class="primary" data-action="copy-config" @click=${() => { void this.copy('config', snippet) }}>
              ${this.copied === 'config' ? 'Copied' : 'Copy'}
            </button>
          `}
          <button type="button" data-action="copy-key" @click=${() => { void this.copy('key', created.token) }}>
            ${this.copied === 'key' ? 'Key copied' : 'Copy the key only'}
          </button>
          ${created.mcpUrl ? html`
            <button type="button" data-action="test-connection" ?disabled=${this.testing} @click=${() => { void this.testConnection(created) }}>
              ${this.testing ? 'Testing…' : 'Test connection'}
            </button>
          ` : nothing}
          <button type="button" data-action="done" @click=${() => this.finishKeyCard()}>Done</button>
        </div>
        ${created.mcpUrl ? html`
          <p class="muted" data-test-note>Test connection checks this key and Mycl. It does not check your agent app's settings: ask your agent to read a document for that.</p>
        ` : nothing}
        ${this.testResult ? html`
          <p class=${this.testResult.ok ? 'test-ok' : 'error'} data-test-result role="status">${connectionTestText(this.testResult)}</p>
        ` : nothing}
      </div>
    `
  }

  private renderPiece(label: string, value: string, target: CopyTarget): TemplateResult {
    return html`
      <div class="piece" data-piece=${target}>
        <span class="piece-label">${label}</span>
        <code>${value}</code>
        <button type="button" data-action=${`copy-${target}`} @click=${() => { void this.copy(target, value) }}>
          ${this.copied === target ? 'Copied' : 'Copy'}
        </button>
      </div>
    `
  }

  /** The raw pieces any MCP-speaking app asks for, then the address form as a second choice. */
  private renderOtherApp(created: CreatedView, launch: AgentLaunchInfo): TemplateResult {
    const envName = launch.envNames[0] ?? 'GARDEN_MCP_TOKEN'
    return html`
      <div class="pieces" data-other-app>
        ${this.renderPiece('Command', launch.command, 'command')}
        ${this.renderPiece('Arguments', launch.args.join(' '), 'args')}
        ${this.renderPiece(`Environment variable ${envName}`, created.token, 'env')}
      ${created.mcpUrl ? html`
        <div class="by-address" data-by-address><details>
          <summary>Or connect by address</summary>
          <p class="muted">Some apps add a server by its address instead. This works only on this computer while Mycl is running, and the address can change when Mycl restarts, so the command above is the steadier choice.</p>
          ${this.renderPiece('Address', created.mcpUrl, 'url')}
          ${this.renderPiece('Header', `Authorization: Bearer ${created.token}`, 'header')}
        </details></div>
      ` : nothing}
      </div>
    `
  }

  /**
   * A translocated app has no stable path to put in a config, so the key is
   * shown alone, with the one step that fixes it.
   */
  private renderCreatedTranslocated(created: CreatedView): TemplateResult {
    return html`
      <div class="key" data-created data-translocated>
        <div>
          <h3>${created.reissued ? `${created.name} has a new key` : `${created.name} is connected`}</h3>
          <p>This is its key. It is shown only now: copy it before you leave this page.</p>
        </div>
        <pre data-key>${created.token}</pre>
        <p data-move-app>
          Mycl is running from a temporary place macOS made for it, so there is no setup command to show yet.
          Move Mycl to your Applications folder, open it from there, and come back to this page to connect your agent.
        </p>
        <div class="actions">
          <button type="button" class="primary" data-action="copy-key" @click=${() => { void this.copy('key', created.token) }}>
            ${this.copied === 'key' ? 'Key copied' : 'Copy the key'}
          </button>
          <button type="button" data-action="done" @click=${() => this.finishKeyCard()}>Done</button>
        </div>
      </div>
    `
  }

  protected override render(): TemplateResult {
    return html`
      <div class="agents">
        <section>
          <h3>Connected agents</h3>
          <p class="muted">Agents such as Claude Code or Codex can read and write in your graphs with a key from this page. Disconnect one and its key stops working at once.</p>
          ${this.renderList()}
        </section>
        ${this.listState === 'not-owner' ? nothing : html`
          <section>
            ${this.created ? this.renderCreated(this.created) : this.formOpen ? this.renderForm() : html`
              <button type="button" class="primary" data-action="open-form" @click=${() => this.openForm()}>Connect an agent</button>
            `}
          </section>
        `}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mn-agents-settings': MnAgentsSettings
  }
}
