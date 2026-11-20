/**
 * chronicle-surface-probe.mts — which cell surface can a front-end actually read
 * the Chronicle from, and what does each one cost?
 *
 * Established by `chronicle-graph-probe.mts`: the Chronicle is REAL on the record
 * (`read_document` returns createdBy / updatedBy / recentAuthors / the forced
 * trail) but is NOT in the RDF store — the storage-metadata face's triples do not
 * appear on the bare document subject in any named graph of a freshly written
 * document. So the SPARQL route is out, and the question becomes which of the
 * remaining surfaces carries enough for an inspector.
 *
 * Three candidates, cheapest first:
 *   get_workspace   — one call for the whole graph; the commit says entries gained
 *                     updatedBy/revision
 *   list_documents  — likewise, per the commit: revision/createdBy/updatedBy
 *   read_document   — the whole Chronicle, at the cost of the whole document
 *
 * Also asks whether `reindex_graph` puts the storage-metadata face into RDF after
 * the fact, because "never materialized" and "materialized only on reindex" are
 * different bugs and belong to different people.
 */

import { spawnGardend } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'
import { makeDocumentChronicleReader } from '../src/cell/document-chronicle.js'
import { activeDocumentSelection, projectInspectorModel } from '../src/cell/inspector-projection.js'

const GRAPH_ID = `chronicle-surface-${Date.now()}`

function show(label: string, value: unknown): void {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 62 - label.length))}`)
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  console.log(text.length > 2600 ? `${text.slice(0, 2600)}\n… (truncated)` : text)
}

async function attempt(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    show(label, await run())
  } catch (e) {
    show(`${label} — THREW`, e instanceof Error ? e.message : String(e))
  }
}

const cell = await spawnGardend()
const mcp = new LoopbackMcpClient({
  mcpUrl: cell.mcpUrl,
  healthUrl: `${cell.apiUrl}/health`,
  token: cell.token,
  origin: 'http://127.0.0.1',
})

try {
  await mcp.callTool('create_graph', { graph_id: GRAPH_ID, title: 'Chronicle surface probe' })
  const created = (await mcp.callTool('create_document', {
    graphId: GRAPH_ID,
    title: 'Surface probe document',
  })) as Record<string, unknown>
  const documentId = String(created.documentId ?? created.id ?? '')
  await mcp.callTool('write_document', {
    graphId: GRAPH_ID,
    documentId,
    content: '# A write\n\nSecond revision.',
  })
  console.log(`document: ${documentId}`)

  // Does the CHEAPEST read_document format still carry the Chronicle? If the
  // fields ride on the envelope rather than the body, the inspector can have
  // full authorship without pulling a document's prose down to read its label.
  // `markdown` is paginated (offset / nextOffset / maxChars), so the last case
  // asks the real question: can the envelope be had with the body clipped to
  // nothing? If yes, the chronicle read costs a fixed ~1KB no matter how long
  // the document is.
  const formats: { label: string; args: Record<string, unknown> }[] = [
    { label: 'ids_only', args: { format: 'ids_only' } },
    { label: 'markdown', args: { format: 'markdown' } },
    { label: 'markdown maxChars=1', args: { format: 'markdown', maxChars: 1 } },
  ]
  for (const { label, args } of formats) {
    await attempt(`read_document ${label}`, async () => {
      const doc = (await mcp.callTool('read_document', {
        graphId: GRAPH_ID,
        documentId,
        ...args,
      })) as Record<string, unknown>
      return {
        keys: Object.keys(doc),
        bytes: JSON.stringify(doc).length,
        createdBy: doc.createdBy ?? doc.created_by ?? null,
        updatedBy: doc.updatedBy ?? doc.updated_by ?? null,
        revision: doc.revision ?? null,
        hasChronicle: doc.chronicle != null,
      }
    })
  }

  await attempt('get_workspace entry', async () => {
    const ws = (await mcp.callTool('get_workspace', { graphId: GRAPH_ID })) as Record<string, unknown>
    return ws
  })

  await attempt('list_documents entry', () => mcp.callTool('list_documents', { graphId: GRAPH_ID }))

  // Does a reindex put the storage-metadata face into RDF after the fact?
  await attempt('reindex_graph', () => mcp.callTool('reindex_graph', { graphId: GRAPH_ID }))

  const subject = `urn:mnemosyne:local:document:${documentId}`
  await attempt('after reindex — the subject in ANY named graph', () =>
    mcp.callTool('sparql_query', {
      graphId: GRAPH_ID,
      query: `SELECT ?g ?p ?o WHERE { GRAPH ?g { <${subject}> ?p ?o } } ORDER BY ?g ?p`,
    }),
  )
  // END TO END: the shipped reader against the live cell, through the shipped
  // projection, to the rows the inspector will actually draw. Everything above
  // is diagnosis; this is the feature.
  await attempt('SHIPPED reader -> SHIPPED projection -> inspector chips', async () => {
    const chronicle = await makeDocumentChronicleReader((name, args) =>
      mcp.callTool(name, args),
    ).load(GRAPH_ID, documentId)
    const model = projectInspectorModel({
      selection: activeDocumentSelection(GRAPH_ID, documentId),
      graphId: GRAPH_ID,
      activeDocumentId: documentId,
      activeDocumentTitle: chronicle?.title ?? documentId,
      chronicle,
    })
    return {
      title: model?.identity.title,
      chips: (model?.identity.chips ?? []).map((chip) => `${chip.label}: ${chip.value}`),
    }
  })
} finally {
  await cell.kill()
  console.log('\ncell down')
}
