/**
 * The Connected agents page in Settings: the read model.
 *
 * An agent connects with a named credential that gardend mints on the owner
 * control plane (`/owner/connectors`). The credential's reach is either a
 * grant profile or a list of scopes (loopback_client_token_scope_resolution.rs):
 *   - a profile wins over scopes, and sets both the scopes and the tool list;
 *   - with no profile the credential holds exactly the scopes given, and its
 *     tools are every registered tool those scopes allow.
 *
 * So "Full access" is the `garden` profile, and every narrower choice is a
 * list of scopes drawn ONLY from the scopes the `garden` profile itself uses.
 * A custom credential then never reaches past `garden`'s ceiling.
 * `GARDEN_SCOPES` mirrors gardend's `garden_scopes()` (loopback_token_grants.rs);
 * agents-settings.test.ts re-derives it from the garden checkout when one is
 * present, so the two cannot drift silently.
 *
 * The page never says "connector" or "scope": a person connects an agent and
 * chooses what it may do.
 *
 * Pure functions only. Effects live in agents-settings-api.ts.
 */

/** Every credential an agent uses needs these two to list and call tools. */
export const MCP_SCOPES = ['mcp.tools.read', 'mcp.tools.call'] as const

/** What the `garden` profile's tools need, without the two MCP scopes (25). */
export const GARDEN_SCOPES = [
  'artifacts.ingest',
  'artifacts.read',
  'artifacts.write',
  'documents.delete.crdt',
  'documents.history.read',
  'documents.read',
  'documents.write.crdt',
  'graphs.delete',
  'graphs.read',
  'graphs.write',
  'jobs.read',
  'memory.read',
  'memory.write',
  'orientation.read',
  'orientation.write',
  'rdf.query',
  'salience.read',
  'salience.write',
  'search.lexical.read',
  'semantic.index.write',
  'wires.delete',
  'wires.read',
  'wires.write',
  'workspace.delete.crdt',
  'workspace.write.crdt',
] as const

export type GardenScope = typeof GARDEN_SCOPES[number]

export interface AgentScopeGroup {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly scopes: readonly GardenScope[]
}

/**
 * The custom checklist, in plain words. The groups partition GARDEN_SCOPES
 * exactly (a test holds them to it), so ticking every group is `garden`'s
 * reach and nothing more.
 */
export const AGENT_SCOPE_GROUPS: readonly AgentScopeGroup[] = [
  {
    id: 'read-documents',
    label: 'Read documents',
    description: 'Open documents, their history, and what is open in the app.',
    scopes: ['documents.read', 'documents.history.read', 'orientation.read', 'rdf.query'],
  },
  {
    id: 'edit-documents',
    label: 'Edit documents',
    description: 'Write and rearrange documents and folders.',
    scopes: ['documents.write.crdt', 'workspace.write.crdt', 'orientation.write', 'semantic.index.write'],
  },
  {
    id: 'delete',
    label: 'Delete things',
    description: 'Delete documents, folders, wires and graphs.',
    scopes: ['documents.delete.crdt', 'workspace.delete.crdt', 'wires.delete', 'graphs.delete'],
  },
  {
    id: 'wires',
    label: 'Wires',
    description: 'Read wires and make new ones.',
    scopes: ['wires.read', 'wires.write'],
  },
  {
    id: 'memory',
    label: 'Memory and the Song',
    description: 'Read and add memories, the Song and the Diary.',
    scopes: ['memory.read', 'memory.write'],
  },
  {
    id: 'values',
    label: 'Values',
    description: 'Read and mark what matters.',
    scopes: ['salience.read', 'salience.write'],
  },
  {
    id: 'files',
    label: 'Files',
    description: 'Read files, add new ones, and turn them into documents.',
    scopes: ['artifacts.read', 'artifacts.write', 'artifacts.ingest'],
  },
  {
    id: 'search',
    label: 'Search',
    description: 'Search the words in documents.',
    scopes: ['search.lexical.read'],
  },
  {
    id: 'graphs',
    label: 'Graphs',
    description: 'See the list of graphs, and make new ones.',
    scopes: ['graphs.read', 'graphs.write'],
  },
  {
    id: 'jobs',
    label: 'Jobs',
    description: 'Check on long-running work such as imports.',
    scopes: ['jobs.read'],
  },
]

/** A scope that only reads, by gardend's own naming. */
export function isReadScope(scope: string): boolean {
  return scope.endsWith('.read') || scope === 'rdf.query'
}

/** A scope that deletes. */
export function isDeleteScope(scope: string): boolean {
  return scope.endsWith('.delete') || scope.includes('.delete.')
}

export type AgentAccessKind = 'full' | 'read-only' | 'read-write' | 'custom' | 'developer'

export interface AgentAccessChoice {
  readonly kind: AgentAccessKind
  readonly label: string
  readonly description: string
}

export const AGENT_ACCESS_CHOICES: readonly AgentAccessChoice[] = [
  {
    kind: 'full',
    label: 'Full access',
    description: 'Read and write every graph on this computer, including deleting documents and whole graphs, and writing to the Song and values. Recommended for your own agent.',
  },
  {
    kind: 'read-only',
    label: 'Read only',
    description: 'Read everything, change nothing.',
  },
  {
    kind: 'read-write',
    label: 'Read and write, no deleting',
    description: 'Everything in full access except deleting.',
  },
  {
    kind: 'custom',
    label: 'Custom',
    description: 'Choose what this agent may do.',
  },
]

export const DEVELOPER_ACCESS: AgentAccessChoice = {
  kind: 'developer',
  label: 'Developer (everything)',
  description: 'Every tool the app has, including the ones that move raw data in and out.',
}

function withMcp(scopes: Iterable<string>): string[] {
  const wanted = new Set<string>([...MCP_SCOPES, ...scopes])
  return [...MCP_SCOPES, ...GARDEN_SCOPES.filter(scope => wanted.has(scope))]
}

export const READ_ONLY_SCOPES: readonly string[] = withMcp(GARDEN_SCOPES.filter(isReadScope))
export const READ_WRITE_SCOPES: readonly string[] = withMcp(GARDEN_SCOPES.filter(scope => !isDeleteScope(scope)))

/** The scopes a set of ticked groups gives, MCP scopes included. */
export function scopesForGroups(groupIds: Iterable<string>): string[] {
  const ids = new Set(groupIds)
  return withMcp(AGENT_SCOPE_GROUPS.filter(group => ids.has(group.id)).flatMap(group => group.scopes))
}

/**
 * How long a credential lasts. gardend's own default is 30 days and its
 * ceiling 365 (loopback_client_token_records.rs); a person's own agent should
 * not stop working a month in without warning, so the page defaults to a year.
 */
export const AGENT_EXPIRY_CHOICES: readonly { readonly days: number; readonly label: string }[] = [
  { days: 365, label: '1 year' },
  { days: 90, label: '90 days' },
  { days: 30, label: '30 days' },
]
export const DEFAULT_AGENT_EXPIRY_DAYS = 90

/** The body for `POST /owner/connectors`. */
export type CreateAgentRequest =
  | { readonly label: string; readonly expiresInDays: number; readonly grantProfileId: 'garden' | 'developer' }
  | { readonly label: string; readonly expiresInDays: number; readonly scopes: readonly string[] }

export function createAgentRequest(
  label: string,
  kind: AgentAccessKind,
  customGroups: Iterable<string> = [],
  expiresInDays: number = DEFAULT_AGENT_EXPIRY_DAYS,
): CreateAgentRequest {
  const base = { label: label.trim(), expiresInDays }
  switch (kind) {
    case 'full': return { ...base, grantProfileId: 'garden' }
    case 'developer': return { ...base, grantProfileId: 'developer' }
    case 'read-only': return { ...base, scopes: READ_ONLY_SCOPES }
    case 'read-write': return { ...base, scopes: READ_WRITE_SCOPES }
    case 'custom': return { ...base, scopes: scopesForGroups(customGroups) }
  }
}

/** One credential as gardend lists it (LoopbackClientTokenSummary, camelCase). */
export interface AgentRecord {
  readonly tokenId: string
  readonly label: string
  readonly grantProfileId: string | null
  readonly scopes: readonly string[]
  readonly createdAt: string
  readonly expiresAt: string
  readonly revokedAt: string | null
  readonly active: boolean
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function agentRecordFrom(value: unknown): AgentRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const tokenId = text(record.tokenId) ?? text(record.token_id)
  if (!tokenId) return null
  return {
    tokenId,
    label: text(record.label) ?? tokenId,
    grantProfileId: text(record.grantProfileId) ?? text(record.grant_profile_id),
    scopes: Array.isArray(record.scopes) ? record.scopes.filter((s): s is string => typeof s === 'string') : [],
    createdAt: text(record.createdAt) ?? text(record.created_at) ?? '',
    expiresAt: text(record.expiresAt) ?? text(record.expires_at) ?? '',
    revokedAt: text(record.revokedAt) ?? text(record.revoked_at),
    active: record.active !== false,
  }
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every(scope => set.has(scope))
}

/** The house's own profiles, named as they are; anything else falls through to its id. */
const PROFILE_LABELS: Readonly<Record<string, string>> = {
  garden: 'Full access',
  developer: 'Developer',
  'read-only': 'Read only',
  authoring: 'Authoring',
  hivemind: 'Hivemind',
  mu: 'Mu',
  'angel-graph': 'Angel (graph)',
  'angel-code': 'Angel (code)',
  'rdf-admin': 'RDF admin',
}

/** How the list names a credential's reach. */
export function agentAccessLabel(record: Pick<AgentRecord, 'grantProfileId' | 'scopes'>): string {
  if (record.grantProfileId) return PROFILE_LABELS[record.grantProfileId] ?? record.grantProfileId
  if (sameScopes(record.scopes, READ_ONLY_SCOPES)) return 'Read only'
  if (sameScopes(record.scopes, READ_WRITE_SCOPES)) return 'Read and write, no deleting'
  return 'Custom'
}

/** gardend stamps epoch milliseconds as strings; older records may carry ISO dates. */
export function formatAgentDate(value: string, locale?: string): string {
  if (!value) return '—'
  const millis = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(millis)) return '—'
  return new Date(millis).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Under this many days left, a key's row says it expires soon. */
export const AGENT_EXPIRES_SOON_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/** A listed key is working, close to its end, or past it (and can be re-issued). */
export type AgentRowState = 'active' | 'expiring' | 'expired'

export interface AgentRow {
  readonly tokenId: string
  readonly name: string
  readonly access: string
  readonly created: string
  readonly expires: string
  readonly state: AgentRowState
}

function agentMillis(value: string): number {
  if (!value) return Number.NaN
  return /^\d+$/.test(value) ? Number(value) : Date.parse(value)
}

export function agentRowState(record: Pick<AgentRecord, 'active' | 'expiresAt'>, now: number = Date.now()): AgentRowState {
  const expiresAt = agentMillis(record.expiresAt)
  if (!record.active || (Number.isFinite(expiresAt) && expiresAt <= now)) return 'expired'
  if (Number.isFinite(expiresAt) && expiresAt - now < AGENT_EXPIRES_SOON_DAYS * DAY_MS) return 'expiring'
  return 'active'
}

/**
 * Working and expired keys, newest first. A revoked key is gone for good and
 * is not listed; an expired one is, so it can be re-issued.
 */
export function agentRows(records: readonly AgentRecord[], locale?: string, now: number = Date.now()): AgentRow[] {
  return records
    .filter(record => !record.revokedAt)
    .slice()
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0) || a.label.localeCompare(b.label))
    .map(record => ({
      tokenId: record.tokenId,
      name: record.label,
      access: agentAccessLabel(record),
      created: formatAgentDate(record.createdAt, locale),
      expires: formatAgentDate(record.expiresAt, locale),
      state: agentRowState(record, now),
    }))
}

/**
 * Rows in the order the person has been looking at. Keys already on screen
 * keep their places; a key not seen before goes first. A re-issued key takes
 * its predecessor's place because the page swaps the id in `order` first.
 */
export function orderAgentRows(rows: readonly AgentRow[], order: readonly string[]): AgentRow[] {
  const place = new Map(order.map((id, index) => [id, index]))
  const unseen = rows.filter(row => !place.has(row.tokenId))
  const seen = rows
    .filter(row => place.has(row.tokenId))
    .sort((a, b) => place.get(a.tokenId)! - place.get(b.tokenId)!)
  return [...unseen, ...seen]
}

/** How to start the agent bridge: the app's own binary with `--mcp-stdio`. */
export interface AgentLaunchInfo {
  readonly command: string
  readonly args: readonly string[]
  readonly envNames: readonly string[]
  /**
   * The app runs from macOS App Translocation: its path is a random read-only
   * mount that changes on the next launch, so no setup command is printed.
   */
  readonly translocated?: boolean
}

/**
 * Used when the app cannot say where its binary is. It is the default
 * install path of today's bundle (tauri.conf.json productName/mainBinaryName),
 * and the page says to change it if the app lives elsewhere.
 */
export const DEFAULT_LAUNCH_INFO: AgentLaunchInfo = {
  command: '/Applications/Garden.app/Contents/MacOS/garden',
  args: ['--mcp-stdio'],
  envNames: ['GARDEN_MCP_TOKEN'],
}

export type AgentHarness = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'gemini' | 'kimi' | 'other'

export const AGENT_HARNESSES: readonly { readonly id: AgentHarness; readonly label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'kimi', label: 'Kimi Code' },
  { id: 'other', label: 'Other app' },
]

export interface AgentSnippetOptions {
  /**
   * The key replaces an earlier one under the same name (a re-issue). Claude
   * Code refuses `mcp add` for a name it already has, so its command removes
   * the old entry first.
   */
  readonly replace?: boolean
}

/** A server name the harness configs can carry: lowercase, no spaces. */
export function serverName(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug ? `mycl-${slug}` : 'mycl'
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Kimi Code shows a tool result's text and then its structuredContent again,
 * so every structured answer reaches the model twice. gardend's stdio bridge
 * drops structuredContent when this is set (mcp_stdio.rs). The house's own
 * Kimi entries set it too (~/.kimi-code/mcp.json, 2026-11-02).
 */
const KIMI_ENV = { GARDEN_MCP_DROP_STRUCTURED: '1' } as const

/** The `mcpServers` JSON block most apps share (Claude Desktop, Cursor, Gemini CLI, Kimi Code). */
function mcpServersJson(name: string, launch: AgentLaunchInfo, env: Record<string, string>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mcpServers: {
      [name]: { ...extra, command: launch.command, args: [...launch.args], env },
    },
  }, null, 2)
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** The config to paste into one harness, with the token in it. */
export function agentConfigSnippet(
  harness: AgentHarness,
  label: string,
  token: string,
  launch: AgentLaunchInfo = DEFAULT_LAUNCH_INFO,
  options: AgentSnippetOptions = {},
): string {
  const name = serverName(label)
  const envName = launch.envNames[0] ?? 'GARDEN_MCP_TOKEN'
  switch (harness) {
    case 'claude-code': {
      const add = [
        'claude mcp add',
        name,
        '--scope user',
        `--env ${envName}=${shellQuote(token)}`,
        '--',
        shellQuote(launch.command),
        ...launch.args.map(shellQuote),
      ].join(' ')
      return options.replace ? `claude mcp remove ${name} --scope user\n${add}` : add
    }
    case 'other':
      return [
        `Command: ${launch.command}`,
        `Arguments: ${launch.args.join(' ')}`,
        `Environment variable: ${envName}=${token}`,
      ].join('\n')
    case 'claude-desktop':
    case 'gemini':
      return mcpServersJson(name, launch, { [envName]: token })
    // Cursor's field table marks `type` required for stdio (cursor.com/docs/context/mcp).
    case 'cursor':
      return mcpServersJson(name, launch, { [envName]: token }, { type: 'stdio' })
    case 'kimi':
      return mcpServersJson(name, launch, { [envName]: token, ...KIMI_ENV })
    case 'codex':
      return [
        `[mcp_servers.${name}]`,
        `command = ${tomlString(launch.command)}`,
        `args = [${launch.args.map(tomlString).join(', ')}]`,
        `env = { ${envName} = ${tomlString(token)} }`,
      ].join('\n')
  }
}

/** Where each harness keeps the snippet, said plainly. */
export function agentConfigHint(harness: AgentHarness): string {
  switch (harness) {
    case 'claude-code': return 'Run this in a terminal.'
    case 'claude-desktop': return 'Add this to claude_desktop_config.json (Settings, Developer, Edit Config), then restart Claude Desktop. If the file already lists other servers, add this entry inside its mcpServers block.'
    case 'codex': return 'Add this to ~/.codex/config.toml, then restart Codex.'
    case 'cursor': return 'Add this to ~/.cursor/mcp.json (or merge the entry into its mcpServers block if the file has one), then turn the server on under Customize in Cursor\'s sidebar.'
    case 'gemini': return 'Add this to ~/.gemini/settings.json (or merge the entry into its mcpServers block if the file has one), then restart Gemini CLI. Type /mcp to check that it is there.'
    case 'kimi': return 'Add this to ~/.kimi-code/mcp.json (or merge the entry into its mcpServers block if the file has one), then restart Kimi Code.'
    case 'other': return 'In your agent app\'s MCP settings, add a local (stdio) server with these three pieces.'
  }
}

/** Where a Re-issue confirm or a key card sends the person after a re-issue. */
export function reissueConfirmText(name: string, state: AgentRowState): string {
  return state === 'expired'
    ? `${name} gets a new key. Its old key has already expired, so give the agent the new one.`
    : `${name} gets a new key. Its current key stops working now, so this agent stops working until you give it the new key.`
}

/** What Test connection says, in plain words. */
export type AgentConnectionTest =
  | { readonly ok: true; readonly tools: number }
  | { readonly ok: false; readonly reason: 'refused' | 'unreachable' | 'error' }

export function connectionTestText(result: AgentConnectionTest): string {
  if (result.ok) return `Connected: this key can reach ${result.tools} ${result.tools === 1 ? 'tool' : 'tools'}.`
  switch (result.reason) {
    case 'refused': return 'Mycl did not accept this key.'
    case 'unreachable': return 'Could not reach Mycl. Make sure it is running.'
    case 'error': return 'The test did not finish. Try again.'
  }
}
