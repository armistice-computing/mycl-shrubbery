/**
 * The Connected agents page in Settings: the effects.
 *
 * Credentials live on gardend's owner control plane (loopback_owner_routes.rs):
 *   - `GET /owner/connectors` lists every named credential (a bare array);
 *   - `POST /owner/connectors` mints one and answers `{ mcpUrl, token, connector }`.
 *     The token is in that answer and nowhere else: gardend stores a hash;
 *   - `DELETE /owner/connectors/{tokenId}` revokes one;
 *   - `POST /owner/connectors/{tokenId}/reissue` mints a new secret for the
 *     same label and grant, revokes the old one in the same step, and answers
 *     `{ mcpUrl, token, connector, previousTokenId }`. An expired or revoked
 *     key can be re-issued; a legacy owner-grade one answers 400.
 * Each answers 401 to anyone but the owner.
 *
 * Test connection calls `tools/list` on the `mcpUrl` gardend returns, with
 * the NEW key, directly: the dev cell proxy replaces Authorization with the
 * owner's token, so going through it would always pass.
 *
 * Where the app's binary lives comes from the Tauri command
 * `agent_launch_info` when the app has it; without it (a browser, or a build
 * that predates the command) the page falls back to the default install path
 * and says so.
 */

import type { ShrubberyContract } from '@shrubbery/nucleus'
import { gardendResponseError } from './document-transfer.js'
import {
  agentRecordFrom,
  type AgentConnectionTest,
  type AgentLaunchInfo,
  type AgentRecord,
  type CreateAgentRequest,
} from './agents-settings-model.js'

export interface CreatedAgent {
  readonly token: string
  readonly record: AgentRecord
  /** gardend's MCP address for this app, when it says; Test connection uses it. */
  readonly mcpUrl?: string | null
}

export interface ReissuedAgent extends CreatedAgent {
  /** The key this one replaced; the list puts the new row in its place. */
  readonly previousTokenId: string
}

/** gardend refuses to re-issue a legacy owner-grade key (400). */
export const REISSUE_REFUSED_MESSAGE = 'This key can\'t be re-issued. Connect the agent again instead.'

export interface AgentsSettingsApi {
  list(): Promise<AgentRecord[]>
  create(request: CreateAgentRequest): Promise<CreatedAgent>
  revoke(tokenId: string): Promise<void>
  reissue(tokenId: string): Promise<ReissuedAgent>
  /** Lists tools over MCP with `token`; checks the key and the app, not the agent's config. */
  testConnection(mcpUrl: string, token: string): Promise<AgentConnectionTest>
  /** Null when the app can't say where its binary is. */
  launchInfo(): Promise<AgentLaunchInfo | null>
}

/** The credential list could not be read because this viewer is not the owner. */
export class AgentsNotOwnerError extends Error {
  constructor() {
    super('Only the owner of this app can connect agents.')
    this.name = 'AgentsNotOwnerError'
  }
}

/** Matched by name, not by class: two copies of this module can be loaded. */
export function isAgentsNotOwnerError(error: unknown): boolean {
  return error instanceof Error ? error.name === 'AgentsNotOwnerError' : false
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

export interface GardendAgentsSettingsApiOptions {
  readonly contract: Pick<ShrubberyContract, 'auth' | 'runtime'>
  readonly graphId: string
  readonly invoke?: Invoke | null
  readonly fetch?: typeof fetch
}

function launchInfoFrom(value: unknown): AgentLaunchInfo | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const command = typeof record.command === 'string' ? record.command.trim() : ''
  if (!command) return null
  const strings = (list: unknown): string[] => Array.isArray(list)
    ? list.filter((item): item is string => typeof item === 'string')
    : []
  const args = strings(record.args)
  const envNames = strings(record.envNames)
  return {
    command,
    args: args.length ? args : ['--mcp-stdio'],
    envNames: envNames.length ? envNames : ['GARDEN_MCP_TOKEN'],
    translocated: record.translocated === true,
  }
}

export class GardendAgentsSettingsApi implements AgentsSettingsApi {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: GardendAgentsSettingsApiOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async list(): Promise<AgentRecord[]> {
    const response = await this.fetchImpl(this.url(), { headers: this.headers(), cache: 'no-store' })
    await this.check(response, 'Could not read the connected agents.')
    const body = await response.json() as unknown
    const rows = Array.isArray(body) ? body : []
    return rows.map(agentRecordFrom).filter((record): record is AgentRecord => record !== null)
  }

  async create(request: CreateAgentRequest): Promise<CreatedAgent> {
    const response = await this.fetchImpl(this.url(), {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    await this.check(response, 'Could not connect the agent.')
    return this.keyFrom(await response.json())
  }

  async reissue(tokenId: string): Promise<ReissuedAgent> {
    const response = await this.fetchImpl(`${this.url()}/${encodeURIComponent(tokenId)}/reissue`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (response.status === 400) throw new Error(REISSUE_REFUSED_MESSAGE)
    await this.check(response, 'Could not re-issue the key.')
    const body = await response.json() as { previousTokenId?: unknown }
    const created = this.keyFrom(body)
    const previous = typeof body?.previousTokenId === 'string' && body.previousTokenId ? body.previousTokenId : tokenId
    return { ...created, previousTokenId: previous }
  }

  async testConnection(mcpUrl: string, token: string): Promise<AgentConnectionTest> {
    let response: Response
    try {
      response = await this.fetchImpl(mcpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        cache: 'no-store',
      })
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'refused' }
    if (!response.ok) return { ok: false, reason: 'error' }
    try {
      const text = await response.text()
      const line = text.trimStart().startsWith('{')
        ? text
        : text.split('\n').find(entry => entry.startsWith('data:'))?.slice(5) ?? ''
      const body = JSON.parse(line) as { result?: { tools?: unknown }; error?: unknown }
      if (body.error || !Array.isArray(body.result?.tools)) return { ok: false, reason: 'error' }
      return { ok: true, tools: body.result.tools.length }
    } catch {
      return { ok: false, reason: 'error' }
    }
  }

  async revoke(tokenId: string): Promise<void> {
    const response = await this.fetchImpl(`${this.url()}/${encodeURIComponent(tokenId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    await this.check(response, 'Could not disconnect the agent.')
  }

  async launchInfo(): Promise<AgentLaunchInfo | null> {
    if (!this.options.invoke) return null
    try {
      return launchInfoFrom(await this.options.invoke('agent_launch_info'))
    } catch {
      return null
    }
  }

  private keyFrom(value: unknown): CreatedAgent {
    const body = (value && typeof value === 'object' ? value : {}) as { token?: unknown; connector?: unknown; record?: unknown; mcpUrl?: unknown }
    const record = agentRecordFrom(body.connector ?? body.record)
    const token = typeof body.token === 'string' ? body.token : ''
    if (!record || !token) throw new Error('The app did not return the new agent\'s key.')
    const mcpUrl = typeof body.mcpUrl === 'string' && /^https?:\/\//.test(body.mcpUrl) ? body.mcpUrl : null
    return { token, record, mcpUrl }
  }

  private async check(response: Response, fallback: string): Promise<void> {
    if (response.status === 401 || response.status === 403) throw new AgentsNotOwnerError()
    if (!response.ok) throw new Error(await gardendResponseError(response, fallback))
  }

  private url(): string {
    const base = this.options.contract.runtime.graphBaseUrl(this.options.graphId).replace(/\/+$/, '')
    return `${base}/owner/connectors`
  }

  private headers(): Record<string, string> {
    const { auth } = this.options.contract
    const headers: Record<string, string> = { 'X-User-ID': auth.userId() }
    const token = auth.token()
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }
}
