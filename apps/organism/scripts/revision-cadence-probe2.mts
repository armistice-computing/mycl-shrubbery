/**
 * revision-cadence-probe2.mts — follow-up to revision-cadence-probe.mts, which
 * found something the 600ms debounce does not explain.
 *
 * That probe measured, on one document, in order:
 *   A. 20 edits ~50ms apart, then settle  -> +1 revision   (the debounce, as expected)
 *   B.  5 edits ~900ms apart, then settle -> +0 revisions  (NOT expected — each of
 *                                                           those gaps is longer than
 *                                                           the debounce window, so
 *                                                           they should have flushed
 *                                                           independently)
 *   C.  3 write_document MCP calls        -> +3 revisions  (one each, as expected)
 *
 * Two readings of B, and they imply very different things for a person typing:
 *   (i)  paced editing genuinely never produces a second revision — the room flushes
 *        once and then stops counting until something else pokes it, so a two-hour
 *        writing session is ONE revision;
 *   (ii) B was suppressed by state left behind by A, and on a fresh document each
 *        pause would flush — so a writing session is roughly "one revision per pause",
 *        which could be hundreds.
 *
 * So: a FRESH document, paced edits from the very first keystroke, and a revision
 * read after EVERY edit rather than only at the end. Also reports the write epoch
 * indirectly via updatedAt, so a flush that happened without moving the revision is
 * still visible.
 *
 * Run:  pnpm -C apps/organism exec tsx scripts/revision-cadence-probe2.mts
 */

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { spawnGardend } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'
import { makeDocumentChronicleReader } from '../src/cell/document-chronicle.js'

const GRAPH_ID = `revision-cadence2-${Date.now()}`
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const cell = await spawnGardend()
const mcp = new LoopbackMcpClient({
  mcpUrl: cell.mcpUrl,
  healthUrl: `${cell.apiUrl}/health`,
  token: cell.token,
  origin: 'http://127.0.0.1',
})
const reader = makeDocumentChronicleReader((name, args) => mcp.callTool(name, args))

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
  await mcp.callTool('create_graph', { graph_id: GRAPH_ID, title: 'Revision cadence probe 2' })
  const created = (await mcp.callTool('create_document', {
    graphId: GRAPH_ID,
    title: 'Paced typing from a cold start',
  })) as Record<string, unknown>
  const documentId = String(created.documentId ?? created.id ?? '')

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

  async function line(label: string): Promise<void> {
    const c = await reader.load(GRAPH_ID, documentId)
    const authors = (c?.recentAuthors ?? [])
      .map((e) => `${e.actor.label}${e.actor.via ? `(${e.actor.via})` : ''}×${e.writes}`)
      .join(', ')
    console.log(
      `${label.padEnd(30)} rev=${String(c?.revision ?? '—').padEnd(4)}` +
        ` updatedAt=${c?.updatedAt ?? '—'}  authors=[${authors}]`,
    )
  }

  console.log('\n── PACED FROM COLD: one edit, then a 2.5s pause, ten times ──')
  await line('before any edit')
  for (let i = 1; i <= 10; i += 1) {
    type(`edit ${i}`)
    await sleep(2500)
    await line(`after edit ${i} + 2.5s`)
  }

  console.log('\n── then a fast burst on the SAME document ──')
  for (let i = 0; i < 15; i += 1) {
    type(`burst ${i}`)
    await sleep(40)
  }
  await sleep(2500)
  await line('after 15 fast edits')

  console.log('\n── then one more lone edit ──')
  type('one more')
  await sleep(2500)
  await line('after 1 lone edit')

  provider.destroy()
} finally {
  await cell.kill()
  console.log('\ncell down')
}
