/**
 * agent-attribution-probe.mts — does a write ever get attributed to an AGENT?
 *
 * The whole point of the inspector's authorship rows is telling "you wrote this"
 * apart from "Delta wrote this". The Chronicle commit says the MCP dispatcher
 * refines the actor from an explicit `agent` argument (1c3b240), and the
 * loopback middleware resolves a named client token to `agent:<label>`. But an
 * earlier probe passed `agent: 'delta'` on a write and read back `human:owner`,
 * which — if that is the general case — means the agent branch of the UI never
 * fires and every row on a local node says "you".
 *
 * So: the same write, three ways, against a real cell.
 *
 * Run:  pnpm -C apps/organism exec tsx scripts/agent-attribution-probe.mts
 */

import { spawnGardend } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'
import { makeDocumentChronicleReader } from '../src/cell/document-chronicle.js'

const GRAPH_ID = `agent-attribution-${Date.now()}`

const cell = await spawnGardend()
const mcp = new LoopbackMcpClient({
  mcpUrl: cell.mcpUrl,
  healthUrl: `${cell.apiUrl}/health`,
  token: cell.token,
  origin: 'http://127.0.0.1',
})
const reader = makeDocumentChronicleReader((name, args) => mcp.callTool(name, args))

try {
  await mcp.callTool('create_graph', { graph_id: GRAPH_ID, title: 'Agent attribution probe' })
  const created = (await mcp.callTool('create_document', {
    graphId: GRAPH_ID,
    title: 'Who gets the credit',
  })) as Record<string, unknown>
  const documentId = String(created.documentId ?? created.id ?? '')

  async function writeAs(label: string, extra: Record<string, unknown>): Promise<void> {
    await mcp.callTool('write_document', {
      graphId: GRAPH_ID,
      documentId,
      content: `# ${label}\n\nWritten for the attribution probe.`,
      ...extra,
    })
    const c = await reader.load(GRAPH_ID, documentId)
    const authors = (c?.recentAuthors ?? [])
      .map((e) => `${e.actor.label}${e.actor.via ? `(via ${e.actor.via})` : ''}×${e.writes}`)
      .join(', ')
    console.log(
      `${label.padEnd(30)} updatedBy=${(c?.updatedBy?.label ?? '—').padEnd(14)}` +
        ` via=${c?.updatedBy?.via ?? '—'}\n${''.padEnd(30)} authors=[${authors}]`,
    )
  }

  console.log()
  await writeAs('no agent argument', {})
  await writeAs("agent: 'delta'", { agent: 'delta' })
  await writeAs("agent: {kind,name}", { agent: { kind: 'agent', name: 'delta' } })
  await writeAs("agent: 'agent:delta'", { agent: 'agent:delta' })
} finally {
  await cell.kill()
  console.log('\ncell down')
}
