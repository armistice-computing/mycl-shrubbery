/**
 * revision-cadence-probe.mts — what is ONE REVISION, for a human?
 *
 * Eschaton's question: revision counters make obvious sense for MCP ops, which
 * are bulk changes with a clear beginning and end. A person typing has no such
 * boundary. So what does the counter count for her — keystrokes? sessions?
 * something in between? And is an author recorded for every one of them?
 *
 * Reading the source gets you as far as "a 600ms document projection debounce"
 * (crdt_engine/rooms.rs:148) and "one projection flush is one revision"
 * (rooms.rs:52-53, the comment forbidding the same snapshot from being saved as
 * two). It does NOT tell you what that produces under a real typing rhythm,
 * because that depends on how often a person's keystrokes are more than 600ms
 * apart — which is a fact about people, not about the code.
 *
 * So this types, at three rhythms, over the SAME websocket the shrubbery editor
 * uses (`/hocuspocus/docs/{graph}/{doc}`), and reads the revision back:
 *
 *   A. a fast burst      — 20 edits, ~50ms apart (fluent typing)
 *   B. a thinking rhythm — 5 edits, ~900ms apart (typing with pauses)
 *   C. MCP writes        — 3 write_document calls (the control)
 *
 * Run:  pnpm -C apps/organism exec tsx scripts/revision-cadence-probe.mts
 */

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { spawnGardend } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'
import { makeDocumentChronicleReader } from '../src/cell/document-chronicle.js'

const GRAPH_ID = `revision-cadence-${Date.now()}`
/** Comfortably past the 600ms document debounce, so a burst has certainly settled. */
const SETTLE_MS = 2500

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const cell = await spawnGardend()
const mcp = new LoopbackMcpClient({
  mcpUrl: cell.mcpUrl,
  healthUrl: `${cell.apiUrl}/health`,
  token: cell.token,
  origin: 'http://127.0.0.1',
})
const readChronicle = makeDocumentChronicleReader((name, args) => mcp.callTool(name, args))

/** The cell accepts `bearer.<token>` in Sec-WebSocket-Protocol (loopback authorize_ws). */
function authWebSocket(token: string): typeof WebSocket {
  // Same trick as loopback-crdt-backend: the cell's authorize_ws accepts a
  // `bearer.<token>` entry in Sec-WebSocket-Protocol, which is the only way to
  // carry auth on a WebSocket the browser (and Node's undici WebSocket) will
  // build — neither can set an Authorization header.
  const Base = globalThis.WebSocket as unknown as {
    new (url: string, protocols?: string | string[]): unknown
  }
  class AuthWebSocket extends (Base as new (url: string, protocols?: string | string[]) => object) {
    constructor(url: string, protocols?: string | string[]) {
      const carried = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols]
      super(url, [...carried, `bearer.${token}`])
    }
  }
  return AuthWebSocket as unknown as typeof WebSocket
}

try {
  await mcp.callTool('create_graph', { graph_id: GRAPH_ID, title: 'Revision cadence probe' })
  const created = (await mcp.callTool('create_document', {
    graphId: GRAPH_ID,
    title: 'Revision cadence probe',
  })) as Record<string, unknown>
  const documentId = String(created.documentId ?? created.id ?? '')
  console.log(`graph=${GRAPH_ID}\ndocument=${documentId}\n`)

  const apiOrigin = new URL(cell.apiUrl)
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(
    `ws://${apiOrigin.host}/hocuspocus/docs/${GRAPH_ID}`,
    documentId,
    doc,
    { connect: false, WebSocketPolyfill: authWebSocket(cell.token) },
  )
  provider.connect()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket never synced')), 15000)
    provider.on('sync', (synced: boolean) => {
      if (!synced) return
      clearTimeout(timer)
      resolve()
    })
  })
  console.log('websocket synced — the same room the editor uses\n')

  // THE FIELD MATTERS. The editor binds `yDoc.getXmlFragment('content')`
  // (collab/live-editor.ts:30) and gardend's projection reads that fragment.
  // An earlier version of this probe typed into `doc.getText('probe')`, which
  // is a different shared type entirely — it synced perfectly and projected
  // nothing, so the revision sat still and looked like a finding. Type where
  // the editor types or you are measuring your own mistake.
  const fragment = doc.getXmlFragment('content')
  const type = (chars: string): void => {
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText(chars)])
    fragment.insert(fragment.length, [paragraph])
  }

  async function revision(label: string): Promise<number | null> {
    const chronicle = await readChronicle.load(GRAPH_ID, documentId)
    const authors = (chronicle?.recentAuthors ?? [])
      .map((entry) => `${entry.actor.label}×${entry.writes}`)
      .join(', ')
    console.log(
      `${label.padEnd(34)} revision=${String(chronicle?.revision).padEnd(5)}` +
        ` updatedBy=${chronicle?.updatedBy?.label ?? '—'}   authors=[${authors}]`,
    )
    return chronicle?.revision ?? null
  }

  const before = await revision('baseline (created, no edits)')

  // ── A. fluent typing: 20 edits ~50ms apart ─────────────────────────────────
  for (let i = 0; i < 20; i += 1) {
    type(`fast ${i}`)
    await sleep(50)
  }
  await sleep(SETTLE_MS)
  const afterFast = await revision('A. 20 edits @50ms, then settle')

  // ── B. typing with thought: 5 edits ~900ms apart, each its own quiet ───────
  for (let i = 0; i < 5; i += 1) {
    type(`paced ${i}`)
    await sleep(900)
  }
  await sleep(SETTLE_MS)
  const afterSlow = await revision('B. 5 edits @900ms, then settle')

  // ── C. the control: MCP writes, one revision each by construction ─────────
  for (let i = 0; i < 3; i += 1) {
    await mcp.callTool('write_document', {
      graphId: GRAPH_ID,
      documentId,
      content: `# MCP write ${i}\n\nBulk change ${i}.`,
    })
  }
  const afterMcp = await revision('C. 3 write_document calls')

  console.log('\n── deltas ───────────────────────────────────────────────────')
  const delta = (a: number | null, b: number | null) => (a == null || b == null ? '?' : b - a)
  console.log(`A  20 fast edits           -> +${delta(before, afterFast)} revisions`)
  console.log(`B  5 paced edits           -> +${delta(afterFast, afterSlow)} revisions`)
  console.log(`C  3 MCP write_document    -> +${delta(afterSlow, afterMcp)} revisions`)

  provider.destroy()
} finally {
  await cell.kill()
  console.log('\ncell down')
}
