import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import '../agents-settings-editor.js'
import type { MnAgentsSettings } from '../agents-settings-editor.js'
import {
  AgentsNotOwnerError,
  GardendAgentsSettingsApi,
  REISSUE_REFUSED_MESSAGE,
  type AgentsSettingsApi,
  type CreatedAgent,
  type ReissuedAgent,
} from '../agents-settings-api.js'
import {
  AGENT_SCOPE_GROUPS,
  DEFAULT_LAUNCH_INFO,
  GARDEN_SCOPES,
  MCP_SCOPES,
  READ_ONLY_SCOPES,
  READ_WRITE_SCOPES,
  agentAccessLabel,
  AGENT_HARNESSES,
  agentConfigHint,
  AGENT_ACCESS_CHOICES,
  agentConfigSnippet,
  agentRecordFrom,
  agentRowState,
  agentRows,
  connectionTestText,
  createAgentRequest,
  orderAgentRows,
  reissueConfirmText,
  isDeleteScope,
  isReadScope,
  scopesForGroups,
  serverName,
  type AgentConnectionTest,
  type AgentLaunchInfo,
  type AgentRecord,
  type CreateAgentRequest,
} from '../agents-settings-model.js'

// The backend checkout (mycl, or the older garden) sits beside this repository in the
// layout. Elsewhere (CI, a fresh clone) the derivation tests skip.
const HERE = dirname(fileURLToPath(import.meta.url))
const GARDEN = [
  process.env.GARDEN_REPO,
  resolve(HERE, '../../../../../../mycl'),
  resolve(HERE, '../../../../../../garden'),
].find((path): path is string => Boolean(path && existsSync(resolve(path, 'parity/local-loopback-surface.json'))))

interface SurfaceTool { readonly name: string; readonly scopes?: readonly string[] }

function gardenSurface(): { tools: Map<string, readonly string[]>; garden: Set<string> } {
  const surface = JSON.parse(readFileSync(resolve(GARDEN!, 'parity/local-loopback-surface.json'), 'utf8')) as { mcpTools: SurfaceTool[] }
  const grants = readFileSync(resolve(GARDEN!, 'src-tauri/src/loopback_token_grants.rs'), 'utf8')
  const block = grants.split('pub(crate) const GARDEN_MCP_TOOLS: &[&str] = &[')[1]!.split('];')[0]!
  return {
    tools: new Map(surface.mcpTools.map(tool => [tool.name, tool.scopes ?? []])),
    garden: new Set([...block.matchAll(/"([a-z_]+)"/g)].map(match => match[1]!)),
  }
}

describe.skipIf(!GARDEN)('agent access, derived from the garden checkout', () => {
  it('GARDEN_SCOPES is exactly what the garden profile\'s tools need (gardend garden_scopes)', () => {
    const { tools, garden } = gardenSurface()
    const needed = new Set<string>()
    for (const name of garden) for (const scope of tools.get(name) ?? []) needed.add(scope)
    for (const scope of MCP_SCOPES) needed.delete(scope)
    expect([...needed].sort()).toEqual([...GARDEN_SCOPES].sort())
  })

  it("a Read only key's scopes open read tools only, inside garden's list or not", () => {
    const { tools, garden } = gardenSurface()
    const granted = new Set(READ_ONLY_SCOPES)
    const reachable = [...tools].filter(([, scopes]) => scopes.length > 0 && scopes.every(scope => granted.has(scope)))
    expect(reachable.length).toBeGreaterThan(5)
    // Read scopes alone would also open these read tools outside garden's
    // list: three never in it, and three Full access dropped on 11/18
    // (garden a05f419). The node gives a scope-only key garden's ceiling
    // (loopback_token_grants.rs effective_grant_profile_id), so none of
    // them reaches the agent, and all are reads either way.
    const outside = reachable.filter(([name]) => !garden.has(name)).map(([name]) => name).sort()
    expect(outside).toEqual([
      'check_document', 'emporium_read', 'get_values', 'list_artifact_revisions', 'list_documents', 'sparql_query_named',
    ])
    for (const [name, scopes] of reachable) expect(scopes.every(isReadScope), name).toBe(true)
    expect(reachable.map(([name]) => name)).toContain('read_document')
    expect(reachable.map(([name]) => name)).not.toContain('write_document')
  })

  it('a Read and write key reaches no tool that deletes', () => {
    const { tools } = gardenSurface()
    const granted = new Set(READ_WRITE_SCOPES)
    const reachable = [...tools].filter(([, scopes]) => scopes.length > 0 && scopes.every(scope => granted.has(scope)))
    expect(reachable.map(([name]) => name)).toContain('write_document')
    for (const [name, scopes] of reachable) expect(scopes.some(isDeleteScope), name).toBe(false)
  })
})

describe('agent access model', () => {
  it('the custom groups split garden\'s scopes exactly, with no overlap', () => {
    const all = AGENT_SCOPE_GROUPS.flatMap(group => group.scopes)
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual([...GARDEN_SCOPES].sort())
  })

  it('the presets read, or read and write without deleting, and always carry the MCP scopes', () => {
    expect(READ_ONLY_SCOPES.slice(0, 2)).toEqual([...MCP_SCOPES])
    expect(READ_ONLY_SCOPES.slice(2).every(isReadScope)).toBe(true)
    expect(READ_ONLY_SCOPES).toContain('documents.read')
    expect(READ_WRITE_SCOPES).toContain('documents.write.crdt')
    expect(READ_WRITE_SCOPES.some(isDeleteScope)).toBe(false)
    expect(READ_WRITE_SCOPES.length).toBe(2 + GARDEN_SCOPES.length - 4)
  })

  it('builds the request for each kind of access', () => {
    expect(createAgentRequest('  Laptop ', 'full')).toEqual({ label: 'Laptop', expiresInDays: 90, grantProfileId: 'garden' })
    expect(createAgentRequest('x', 'developer', [], 30)).toEqual({ label: 'x', expiresInDays: 30, grantProfileId: 'developer' })
    expect(createAgentRequest('x', 'read-only')).toMatchObject({ scopes: READ_ONLY_SCOPES })
    const custom = createAgentRequest('x', 'custom', ['wires', 'search']) as unknown as { scopes: string[] }
    expect(custom.scopes).toEqual(['mcp.tools.read', 'mcp.tools.call', 'search.lexical.read', 'wires.read', 'wires.write'])
    expect(scopesForGroups([])).toEqual([...MCP_SCOPES])
  })

  it('names a key\'s access from its profile or its scopes', () => {
    expect(agentAccessLabel({ grantProfileId: 'garden', scopes: [] })).toBe('Full access')
    expect(agentAccessLabel({ grantProfileId: 'hivemind', scopes: [] })).toBe('Hivemind')
    expect(agentAccessLabel({ grantProfileId: 'someday', scopes: [] })).toBe('someday')
    expect(agentAccessLabel({ grantProfileId: null, scopes: [...READ_ONLY_SCOPES].reverse() })).toBe('Read only')
    expect(agentAccessLabel({ grantProfileId: null, scopes: READ_WRITE_SCOPES })).toBe('Read and write, no deleting')
    expect(agentAccessLabel({ grantProfileId: null, scopes: scopesForGroups(['wires']) })).toBe('Custom')
  })

  it('lists working and expired keys, newest first, and leaves revoked ones out', () => {
    const records = [
      { tokenId: 'a', label: 'Old', grantProfileId: 'garden', scopes: [], createdAt: '1000', expiresAt: '2000', revoked_at: null, active: true },
      { tokenId: 'b', label: 'New', grant_profile_id: null, scopes: READ_ONLY_SCOPES, created_at: '5000', expires_at: '9000', active: true },
      { tokenId: 'c', label: 'Gone', grantProfileId: 'garden', scopes: [], createdAt: '7000', expiresAt: '9000', revokedAt: '8000', active: false },
    ].map(agentRecordFrom).filter((r): r is AgentRecord => r !== null)
    const rows = agentRows(records, 'en-US', 3000)
    expect(rows.map(row => [row.name, row.access, row.state])).toEqual([['New', 'Read only', 'expiring'], ['Old', 'Full access', 'expired']])
    expect(rows[0]!.created).toMatch(/19(69|70)/)
    expect(agentRows([{ ...records[0]!, createdAt: 'nonsense' }])[0]!.created).toBe('—')
  })

  it('says whether a key works, ends soon, or has ended', () => {
    const day = 24 * 60 * 60 * 1000
    const now = 1_000 * day
    expect(agentRowState({ active: true, expiresAt: String(now + 90 * day) }, now)).toBe('active')
    expect(agentRowState({ active: true, expiresAt: String(now + 29 * day) }, now)).toBe('expiring')
    expect(agentRowState({ active: true, expiresAt: String(now - 1) }, now)).toBe('expired')
    expect(agentRowState({ active: false, expiresAt: String(now + 90 * day) }, now)).toBe('expired')
    expect(agentRowState({ active: true, expiresAt: '' }, now)).toBe('active')
  })

  it('keeps rows where the person last saw them, new keys first, a re-issued key in its place', () => {
    const row = (tokenId: string) => ({ tokenId, name: tokenId, access: '', created: '', expires: '', state: 'active' as const })
    expect(orderAgentRows([row('c'), row('b'), row('a')], []).map(r => r.tokenId)).toEqual(['c', 'b', 'a'])
    // b was re-issued as b2: the page swapped b2 into b's place before reloading.
    expect(orderAgentRows([row('b2'), row('c'), row('a')], ['c', 'b2', 'a']).map(r => r.tokenId)).toEqual(['c', 'b2', 'a'])
    expect(orderAgentRows([row('d'), row('c'), row('a')], ['c', 'a']).map(r => r.tokenId)).toEqual(['d', 'c', 'a'])
  })

  it('says what a re-issue does and what a test found, plainly', () => {
    expect(reissueConfirmText('Laptop', 'active')).toBe('Laptop gets a new key. Its current key stops working now, so this agent stops working until you give it the new key.')
    expect(reissueConfirmText('Laptop', 'expired')).toMatch(/already expired/)
    expect(connectionTestText({ ok: true, tools: 56 })).toBe('Connected: this key can reach 56 tools.')
    expect(connectionTestText({ ok: true, tools: 1 })).toBe('Connected: this key can reach 1 tool.')
    expect(connectionTestText({ ok: false, reason: 'refused' })).toBe('Mycl did not accept this key.')
    expect(connectionTestText({ ok: false, reason: 'unreachable' })).toMatch(/running/)
  })

  it('writes a config for each agent app, with the key and the bridge command', () => {
    const launch: AgentLaunchInfo = { command: '/Apps/My App.app/bin/garden', args: ['--mcp-stdio'], envNames: ['GARDEN_MCP_TOKEN'] }
    expect(serverName('Claude Code on my laptop')).toBe('mycl-claude-code-on-my-laptop')
    expect(agentConfigSnippet('claude-code', 'Laptop', 'tok', launch))
      .toBe("claude mcp add mycl-laptop --scope user --env GARDEN_MCP_TOKEN=tok -- '/Apps/My App.app/bin/garden' --mcp-stdio")
    const desktop = JSON.parse(agentConfigSnippet('claude-desktop', 'Laptop', 'tok', launch))
    expect(desktop).toEqual({ mcpServers: { 'mycl-laptop': { command: launch.command, args: ['--mcp-stdio'], env: { GARDEN_MCP_TOKEN: 'tok' } } } })
    expect(agentConfigSnippet('codex', 'Laptop', 'tok')).toBe([
      '[mcp_servers.mycl-laptop]',
      `command = "${DEFAULT_LAUNCH_INFO.command}"`,
      'args = ["--mcp-stdio"]',
      'env = { GARDEN_MCP_TOKEN = "tok" }',
    ].join('\n'))
  })

  it('writes Cursor, Gemini CLI and Kimi Code entries, and asks Kimi to drop the doubled structured results', () => {
    const launch: AgentLaunchInfo = { command: '/Apps/Mycl.app/bin/garden', args: ['--mcp-stdio'], envNames: ['GARDEN_MCP_TOKEN'] }
    const entry = (harness: Parameters<typeof agentConfigSnippet>[0]) =>
      JSON.parse(agentConfigSnippet(harness, 'Laptop', 'tok', launch)).mcpServers['mycl-laptop']
    expect(entry('cursor')).toEqual({ type: 'stdio', command: launch.command, args: ['--mcp-stdio'], env: { GARDEN_MCP_TOKEN: 'tok' } })
    // Gemini CLI hides inherited *TOKEN* variables; listing the key in env is what passes it.
    expect(entry('gemini')).toEqual({ command: launch.command, args: ['--mcp-stdio'], env: { GARDEN_MCP_TOKEN: 'tok' } })
    expect(entry('kimi')).toEqual({
      command: launch.command,
      args: ['--mcp-stdio'],
      env: { GARDEN_MCP_TOKEN: 'tok', GARDEN_MCP_DROP_STRUCTURED: '1' },
    })
    expect(AGENT_HARNESSES.map(h => h.label)).toEqual(['Claude Code', 'Claude Desktop', 'Codex', 'Cursor', 'Gemini CLI', 'Kimi Code', 'Other app'])
    for (const harness of ['cursor', 'gemini', 'kimi'] as const) expect(agentConfigHint(harness)).toMatch(/~\/\.(cursor|gemini|kimi-code)\//)
  })

  it('removes the old Claude Code entry first when the key replaces one, and lists the raw pieces for other apps', () => {
    const launch: AgentLaunchInfo = { command: '/Apps/Mycl.app/bin/garden', args: ['--mcp-stdio'], envNames: ['GARDEN_MCP_TOKEN'] }
    expect(agentConfigSnippet('claude-code', 'Laptop', 'tok2', launch, { replace: true })).toBe([
      'claude mcp remove mycl-laptop --scope user',
      'claude mcp add mycl-laptop --scope user --env GARDEN_MCP_TOKEN=tok2 -- /Apps/Mycl.app/bin/garden --mcp-stdio',
    ].join('\n'))
    // A re-issue changes nothing but the key for the apps that read a file.
    expect(agentConfigSnippet('codex', 'Laptop', 'tok2', launch, { replace: true })).toBe(agentConfigSnippet('codex', 'Laptop', 'tok2', launch))
    expect(agentConfigSnippet('other', 'Laptop', 'tok', launch)).toBe([
      'Command: /Apps/Mycl.app/bin/garden',
      'Arguments: --mcp-stdio',
      'Environment variable: GARDEN_MCP_TOKEN=tok',
    ].join('\n'))
  })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const contract = {
  auth: { token: () => 'owner-token', userId: () => 'local', whenReady: async () => {} },
  runtime: { graphBaseUrl: () => 'http://127.0.0.1:9/' },
} as unknown as ConstructorParameters<typeof GardendAgentsSettingsApi>[0]['contract']

describe('GardendAgentsSettingsApi', () => {
  it('lists, creates and revokes through the owner routes with the owner token', async () => {
    const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = []
    const fetch = (async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null, auth: headers.get('Authorization') })
      if (init.method === 'POST') {
        return json({ mcpUrl: 'x', token: 'secret', connector: { tokenId: 't1', label: 'Laptop', grantProfileId: 'garden', scopes: [], createdAt: '1', expiresAt: '2', active: true } })
      }
      if (init.method === 'DELETE') return json({ revoked: true })
      return json([{ tokenId: 't1', label: 'Laptop', grantProfileId: 'garden', scopes: [], createdAt: '1', expiresAt: '2', active: true }])
    }) as unknown as typeof globalThis.fetch
    const api = new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch })
    expect((await api.list()).map(r => r.tokenId)).toEqual(['t1'])
    const created = await api.create(createAgentRequest('Laptop', 'full'))
    expect(created).toMatchObject({ token: 'secret', record: { tokenId: 't1' } })
    await api.revoke('t1')
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'GET http://127.0.0.1:9/owner/connectors',
      'POST http://127.0.0.1:9/owner/connectors',
      'DELETE http://127.0.0.1:9/owner/connectors/t1',
    ])
    expect(calls[1]!.body).toEqual({ label: 'Laptop', expiresInDays: 90, grantProfileId: 'garden' })
    expect(calls.every(c => c.auth === 'Bearer owner-token')).toBe(true)
  })

  it('names a not-owner refusal, and falls back when the app cannot say where it is', async () => {
    const fetch = (async () => json({ error: 'nope' }, 401)) as unknown as typeof globalThis.fetch
    const api = new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch })
    await expect(api.list()).rejects.toBeInstanceOf(AgentsNotOwnerError)
    expect(await api.launchInfo()).toBeNull()
    const failing = new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch, invoke: async () => { throw new Error('unknown command') } })
    expect(await failing.launchInfo()).toBeNull()
    await expect(api.reissue('t1')).rejects.toBeInstanceOf(AgentsNotOwnerError)
    const knowing = new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch, invoke: async () => ({ command: '/x/garden', args: ['--mcp-stdio'], envNames: ['GARDEN_MCP_TOKEN'] }) })
    expect(await knowing.launchInfo()).toEqual({ command: '/x/garden', args: ['--mcp-stdio'], envNames: ['GARDEN_MCP_TOKEN'], translocated: false })
    const moved = new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch, invoke: async () => ({ command: '/private/var/folders/x/AppTranslocation/y/d/Garden.app/Contents/MacOS/garden', args: ['--mcp-stdio'], envNames: ['GARDEN_MCP_TOKEN'], translocated: true }) })
    expect((await moved.launchInfo())?.translocated).toBe(true)
  })
})

describe('GardendAgentsSettingsApi re-issue and test', () => {
  it('re-issues through the owner route and returns the new key with the one it replaced', async () => {
    const calls: string[] = []
    const fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url} ${new Headers(init.headers).get('Authorization')}`)
      return json({ mcpUrl: 'http://127.0.0.1:9/mcp', token: 'secret-2', previousTokenId: 't1', connector: { tokenId: 't2', label: 'Laptop', grantProfileId: 'garden', scopes: [], createdAt: '5', expiresAt: '9', active: true } })
    }) as unknown as typeof globalThis.fetch
    const api = new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch })
    const reissued = await api.reissue('t1')
    expect(reissued).toMatchObject({ token: 'secret-2', previousTokenId: 't1', mcpUrl: 'http://127.0.0.1:9/mcp', record: { tokenId: 't2', label: 'Laptop' } })
    expect(calls).toEqual(['POST http://127.0.0.1:9/owner/connectors/t1/reissue Bearer owner-token'])
  })

  it('says a legacy key can\'t be re-issued, in plain words', async () => {
    const fetch = (async () => json({ error: 'legacy owner-grade connector; mint a new connector' }, 400)) as unknown as typeof globalThis.fetch
    const api = new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch })
    await expect(api.reissue('old')).rejects.toThrow(REISSUE_REFUSED_MESSAGE)
  })

  it('tests a key with tools/list on the MCP address, using the key and not the owner token', async () => {
    const seen: string[] = []
    const fetch = (async (url: string, init: RequestInit = {}) => {
      seen.push(`${url} ${new Headers(init.headers).get('Authorization')} ${JSON.parse(String(init.body)).method}`)
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a' }, { name: 'b' }] } })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }) as unknown as typeof globalThis.fetch
    const api = new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch })
    expect(await api.testConnection('http://127.0.0.1:9/mcp', 'new-key')).toEqual({ ok: true, tools: 2 })
    expect(seen).toEqual(['http://127.0.0.1:9/mcp Bearer new-key tools/list'])
  })

  it('reports a refused key, an unreachable app and a broken answer as failures', async () => {
    const at = (response: () => Response) => new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch: (async () => response()) as unknown as typeof globalThis.fetch })
    expect(await at(() => json({ error: 'unauthorized' }, 401)).testConnection('http://x/mcp', 'k')).toEqual({ ok: false, reason: 'refused' })
    expect(await at(() => new Response('not json', { status: 200 })).testConnection('http://x/mcp', 'k')).toEqual({ ok: false, reason: 'error' })
    expect(await at(() => json({ jsonrpc: '2.0', id: 1, error: { message: 'no' } })).testConnection('http://x/mcp', 'k')).toEqual({ ok: false, reason: 'error' })
    const down = new GardendAgentsSettingsApi({ contract, graphId: 'g', fetch: (async () => { throw new TypeError('Load failed') }) as unknown as typeof globalThis.fetch })
    expect(await down.testConnection('http://x/mcp', 'k')).toEqual({ ok: false, reason: 'unreachable' })
  })
})

class FakeAgentsApi implements AgentsSettingsApi {
  records: AgentRecord[] = []
  requests: CreateAgentRequest[] = []
  revoked: string[] = []
  private next = 1

  async list(): Promise<AgentRecord[]> { return this.records }
  async create(request: CreateAgentRequest): Promise<CreatedAgent> {
    this.requests.push(request)
    const record: AgentRecord = {
      tokenId: `t${this.next}`,
      label: request.label,
      grantProfileId: 'grantProfileId' in request ? request.grantProfileId : null,
      scopes: 'scopes' in request ? request.scopes : [],
      createdAt: String(1000 + this.next),
      expiresAt: '9999999999999',
      revokedAt: null,
      active: true,
    }
    this.next += 1
    this.records = [...this.records, record]
    return { token: `secret-${record.tokenId}`, record, mcpUrl: 'http://127.0.0.1:9/mcp' }
  }
  reissued: string[] = []
  reissueError: Error | null = null
  async reissue(tokenId: string): Promise<ReissuedAgent> {
    if (this.reissueError) throw this.reissueError
    this.reissued.push(tokenId)
    const old = this.records.find(record => record.tokenId === tokenId)!
    const record: AgentRecord = { ...old, tokenId: `t${this.next}`, createdAt: String(1000 + this.next), expiresAt: '9999999999999', active: true }
    this.next += 1
    this.records = this.records.map(entry => entry.tokenId === tokenId ? { ...entry, revokedAt: '1', active: false } : entry).concat(record)
    return { token: `secret-${record.tokenId}`, record, previousTokenId: tokenId, mcpUrl: 'http://127.0.0.1:9/mcp' }
  }
  testResult: AgentConnectionTest = { ok: true, tools: 56 }
  tested: Array<[string, string]> = []
  async testConnection(mcpUrl: string, token: string): Promise<AgentConnectionTest> {
    this.tested.push([mcpUrl, token])
    return this.testResult
  }
  async revoke(tokenId: string): Promise<void> {
    this.revoked.push(tokenId)
    this.records = this.records.filter(record => record.tokenId !== tokenId)
  }
  launch: AgentLaunchInfo | null = null
  async launchInfo(): Promise<AgentLaunchInfo | null> { return this.launch }
}

async function settle(el: MnAgentsSettings): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise(r => setTimeout(r, 0))
    await el.updateComplete
  }
}

async function mount(api: AgentsSettingsApi): Promise<MnAgentsSettings> {
  const el = document.createElement('mn-agents-settings')
  el.api = api
  document.body.appendChild(el)
  await settle(el)
  return el
}

const q = <T extends Element = HTMLElement>(el: MnAgentsSettings, selector: string): T | null =>
  el.shadowRoot!.querySelector<T>(selector) as T | null

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input'))
}

describe('mn-agents-settings', () => {
  it('says plainly what Full access allows', () => {
    const full = AGENT_ACCESS_CHOICES.find(choice => choice.kind === 'full')!
    expect(full.description).toMatch(/every graph/)
    expect(full.description).toMatch(/deleting documents and whole graphs/)
    expect(full.description).toMatch(/Song/)
  })

  it('connects an agent with custom access, shows its key once, and lists it', async () => {
    const api = new FakeAgentsApi()
    const el = await mount(api)
    expect(q(el, '[data-empty]')?.textContent).toContain('No agents yet')
    q<HTMLButtonElement>(el, '[data-action="open-form"]')!.click()
    await settle(el)
    expect(q<HTMLButtonElement>(el, '[data-action="create"]')!.disabled).toBe(true)
    type(q<HTMLInputElement>(el, 'input[name="name"]')!, 'Reader')
    q<HTMLInputElement>(el, '[data-access="custom"] input')!.click()
    await settle(el)
    q<HTMLInputElement>(el, '[data-group="wires"] input')!.click()
    await settle(el)
    q<HTMLButtonElement>(el, '[data-action="create"]')!.click()
    await settle(el)
    expect(api.requests).toHaveLength(1)
    expect((api.requests[0] as unknown as { scopes: string[] }).scopes).toEqual(scopesForGroups(['read-documents', 'wires']))
    expect(q(el, '[data-snippet]')?.textContent).toContain('secret-t1')
    expect(q(el, '[data-default-path]')).not.toBeNull()
    expect(el.shadowRoot!.textContent).toContain('It is shown only now')
    expect(el.shadowRoot!.querySelector('[data-undo-note]')?.textContent).toContain("can't be undone with ⌘Z")
    expect(q(el, 'tbody tr .access')?.textContent).toBe('Custom')
    q<HTMLButtonElement>(el, '[data-harness="codex"]')!.click()
    await settle(el)
    expect(q(el, '[data-snippet]')?.textContent).toContain('[mcp_servers.mycl-reader]')
    q<HTMLButtonElement>(el, '[data-action="done"]')!.click()
    await settle(el)
    expect(el.shadowRoot!.textContent).not.toContain('secret-t1')
    expect(el.shadowRoot!.textContent).not.toMatch(/connector|Garden/)
    el.remove()
  })

  it('shows the key alone, and says to move the app, when it runs translocated', async () => {
    const api = new FakeAgentsApi()
    api.launch = { command: '/private/var/folders/x/AppTranslocation/y/d/Garden.app/Contents/MacOS/garden', args: ['--mcp-stdio'], envNames: ['GARDEN_MCP_TOKEN'], translocated: true }
    const el = await mount(api)
    q<HTMLButtonElement>(el, '[data-action="open-form"]')!.click()
    await settle(el)
    type(q<HTMLInputElement>(el, 'input[name="name"]')!, 'Laptop agent')
    await settle(el)
    q<HTMLButtonElement>(el, '[data-action="create"]')!.click()
    await settle(el)
    expect(q(el, '[data-translocated]')).not.toBeNull()
    expect(q(el, '[data-snippet]')).toBeNull()
    expect(q(el, '[data-key]')?.textContent).toContain('secret-t1')
    expect(q(el, '[data-move-app]')?.textContent).toContain('Applications folder')
    expect(el.shadowRoot!.textContent).not.toContain('AppTranslocation')
    el.remove()
  })

  it('re-issues a key in place, behind a confirm, and shows the new key once with Claude Code\'s replace command', async () => {
    const api = new FakeAgentsApi()
    await api.create(createAgentRequest('First', 'full'))
    await api.create(createAgentRequest('Second', 'read-only'))
    await api.create(createAgentRequest('Third', 'full'))
    const el = await mount(api)
    const names = () => [...el.shadowRoot!.querySelectorAll('tbody tr .name')].map(cell => cell.textContent)
    expect(names()).toEqual(['Third', 'Second', 'First'])
    const second = () => q(el, 'tr[data-agent-id="t2"]')
    second()!.querySelector<HTMLButtonElement>('[data-action="reissue"]')!.click()
    await settle(el)
    expect(q(el, '[data-reissue-confirm-text]:not([hidden])')?.textContent).toContain('this agent stops working until you give it the new key')
    q<HTMLButtonElement>(el, '[data-action="cancel-reissue"]')!.click()
    await settle(el)
    expect(api.reissued).toEqual([])
    second()!.querySelector<HTMLButtonElement>('[data-action="reissue"]')!.click()
    await settle(el)
    q<HTMLButtonElement>(el, '[data-action="confirm-reissue"]')!.click()
    await settle(el)
    expect(api.reissued).toEqual(['t2'])
    expect(names()).toEqual(['Third', 'Second', 'First'])
    expect(q(el, 'tr[data-agent-id="t4"] .access')?.textContent).toBe('Read only')
    expect(q(el, '[data-created]')?.hasAttribute('data-reissued')).toBe(true)
    expect(q(el, '[data-created] h3')?.textContent).toBe('Second has a new key')
    expect(q(el, '[data-snippet]')?.textContent).toBe(
      `claude mcp remove mycl-second --scope user\nclaude mcp add mycl-second --scope user --env GARDEN_MCP_TOKEN=secret-t4 -- ${DEFAULT_LAUNCH_INFO.command} --mcp-stdio`,
    )
    q<HTMLButtonElement>(el, '[data-action="done"]')!.click()
    await settle(el)
    expect(el.shadowRoot!.textContent).not.toContain('secret-t4')
    el.remove()
  })

  it('lists an expired key with a way to bring it back, and no Disconnect', async () => {
    const api = new FakeAgentsApi()
    await api.create(createAgentRequest('Old laptop', 'full'))
    api.records = api.records.map(record => ({ ...record, expiresAt: '1000', active: false }))
    const el = await mount(api)
    const row = q(el, 'tr[data-agent-id="t1"]')!
    expect(row.querySelector('.state')?.textContent).toBe('Expired')
    expect(row.querySelector('[data-action="revoke"]')).toBeNull()
    row.querySelector<HTMLButtonElement>('[data-action="reissue"]')!.click()
    await settle(el)
    expect(q(el, '[data-reissue-confirm-text]:not([hidden])')?.textContent).toContain('already expired')
    el.remove()
  })

  it('says a refused re-issue in plain words', async () => {
    const api = new FakeAgentsApi()
    await api.create(createAgentRequest('Legacy', 'full'))
    api.reissueError = new Error(REISSUE_REFUSED_MESSAGE)
    const el = await mount(api)
    q<HTMLButtonElement>(el, '[data-action="reissue"]')!.click()
    await settle(el)
    q<HTMLButtonElement>(el, '[data-action="confirm-reissue"]')!.click()
    await settle(el)
    expect(q(el, '[role="alert"]')?.textContent).toBe(REISSUE_REFUSED_MESSAGE)
    el.remove()
  })

  it('shows other apps the raw pieces, with the address as a second choice', async () => {
    const api = new FakeAgentsApi()
    const el = await mount(api)
    q<HTMLButtonElement>(el, '[data-action="open-form"]')!.click()
    await settle(el)
    type(q<HTMLInputElement>(el, 'input[name="name"]')!, 'Cursor')
    await settle(el)
    q<HTMLButtonElement>(el, '[data-action="create"]')!.click()
    await settle(el)
    q<HTMLButtonElement>(el, '[data-harness="other"]')!.click()
    await settle(el)
    expect(q(el, '[data-snippet]')).toBeNull()
    expect(q(el, '[data-piece="command"] code')?.textContent).toBe(DEFAULT_LAUNCH_INFO.command)
    expect(q(el, '[data-piece="args"] code')?.textContent).toBe('--mcp-stdio')
    expect(q(el, '[data-piece="env"] .piece-label')?.textContent).toBe('Environment variable GARDEN_MCP_TOKEN')
    expect(q(el, '[data-piece="env"] code')?.textContent).toBe('secret-t1')
    expect(q(el, '[data-by-address]')?.textContent).toContain('the command above is the steadier choice')
    expect(q(el, '[data-piece="url"] code')?.textContent).toBe('http://127.0.0.1:9/mcp')
    expect(q(el, '[data-piece="header"] code')?.textContent).toBe('Authorization: Bearer secret-t1')
    el.remove()
  })

  it('tests the new key and says what it found, honestly', async () => {
    const api = new FakeAgentsApi()
    const el = await mount(api)
    q<HTMLButtonElement>(el, '[data-action="open-form"]')!.click()
    await settle(el)
    type(q<HTMLInputElement>(el, 'input[name="name"]')!, 'Laptop')
    await settle(el)
    q<HTMLButtonElement>(el, '[data-action="create"]')!.click()
    await settle(el)
    expect(q(el, '[data-test-note]')?.textContent).toContain('does not check your agent app')
    q<HTMLButtonElement>(el, '[data-action="test-connection"]')!.click()
    await settle(el)
    expect(api.tested).toEqual([['http://127.0.0.1:9/mcp', 'secret-t1']])
    expect(q(el, '[data-test-result]')?.textContent).toBe('Connected: this key can reach 56 tools.')
    api.testResult = { ok: false, reason: 'refused' }
    q<HTMLButtonElement>(el, '[data-action="test-connection"]')!.click()
    await settle(el)
    expect(q(el, '[data-test-result]')?.textContent).toBe('Mycl did not accept this key.')
    el.remove()
  })

  it('preselects 90 days', async () => {
    const api = new FakeAgentsApi()
    const el = await mount(api)
    q<HTMLButtonElement>(el, '[data-action="open-form"]')!.click()
    await settle(el)
    expect(q(el, '[data-expiry][aria-pressed="true"]')?.getAttribute('data-expiry')).toBe('90')
    type(q<HTMLInputElement>(el, 'input[name="name"]')!, 'Laptop')
    await settle(el)
    q<HTMLButtonElement>(el, '[data-action="create"]')!.click()
    await settle(el)
    expect(api.requests[0]).toMatchObject({ expiresInDays: 90 })
    el.remove()
  })

  it('asks before disconnecting, and keeps the agent if told to', async () => {
    const api = new FakeAgentsApi()
    await api.create(createAgentRequest('Laptop', 'full'))
    const el = await mount(api)
    q<HTMLButtonElement>(el, '[data-action="revoke"]')!.click()
    await settle(el)
    q<HTMLButtonElement>(el, '[data-action="cancel-revoke"]')!.click()
    await settle(el)
    expect(api.revoked).toEqual([])
    q<HTMLButtonElement>(el, '[data-action="revoke"]')!.click()
    await settle(el)
    q<HTMLButtonElement>(el, '[data-action="confirm-revoke"]')!.click()
    await settle(el)
    expect(api.revoked).toEqual(['t1'])
    expect(q(el, '[data-empty]')).not.toBeNull()
    el.remove()
  })

  it('tells a viewer who is not the owner, and offers no form', async () => {
    const api = new FakeAgentsApi()
    api.list = async () => { throw new AgentsNotOwnerError() }
    const el = await mount(api)
    expect(el.shadowRoot!.textContent).toContain('Only the owner of this app')
    expect(q(el, '[data-action="open-form"]')).toBeNull()
    el.remove()
  })
})
