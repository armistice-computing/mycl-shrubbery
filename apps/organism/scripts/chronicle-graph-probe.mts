/**
 * chronicle-graph-probe.mts — WHERE do the Chronicle triples live, and which
 * read tool can see them?
 *
 * Follow-up to `document-chronicle-gardend.mts`, which found zero rows for both
 * the chronicle SELECT *and* its control (every triple on the bare document
 * subject). Two rows of zero from the same tool is the signature of an
 * instrument that cannot see the scope, not of an empty scope — the distinction
 * this repo already got wrong once, on the `:ux:config` graph, 2026-09-03.
 *
 * So this asks the cheapest discriminating question available: enumerate the
 * named graphs, then try the same subject through `sparql_query`,
 * `sparql_query_named`, and `rdf_dump`, and print what each one can see.
 */

import { spawnGardend } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

const GRAPH_ID = `chronicle-probe-${Date.now()}`

function show(label: string, value: unknown): void {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 62 - label.length))}`)
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  console.log(text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text)
}

async function attempt(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    show(label, await run())
  } catch (e) {
    show(`${label} — THREW`, e instanceof Error ? e.message : String(e))
  }
}

const cell = await spawnGardend()
console.log(`cell up: pid=${cell.pid}`)

const mcp = new LoopbackMcpClient({
  mcpUrl: cell.mcpUrl,
  healthUrl: `${cell.apiUrl}/health`,
  token: cell.token,
  origin: 'http://127.0.0.1',
})

try {
  await mcp.callTool('create_graph', { graph_id: GRAPH_ID, title: 'Chronicle probe' })
  const created = (await mcp.callTool('create_document', {
    graphId: GRAPH_ID,
    title: 'Chronicle probe document',
  })) as Record<string, unknown>
  const documentId = String(created.documentId ?? created.id ?? '')
  await mcp.callTool('write_document', {
    graphId: GRAPH_ID,
    documentId,
    content: '# A write\n\nSo the record has a second revision and an updatedBy.',
  })
  console.log(`document: ${documentId}`)

  const subject = `urn:mnemosyne:local:document:${documentId}`
  const docGraph = `urn:mnemosyne:local:graph:${GRAPH_ID}:projection:document:${documentId}`

  // What does read_document itself say? This is the surface the Chronicle commit
  // named first, so it is the oracle for "the record HAS authorship" — separate
  // from whether any RDF reader can reach it.
  await attempt('read_document (chronicle block)', async () => {
    const doc = (await mcp.callTool('read_document', { graphId: GRAPH_ID, documentId })) as Record<
      string,
      unknown
    >
    return {
      createdBy: doc.createdBy ?? doc.created_by ?? null,
      updatedBy: doc.updatedBy ?? doc.updated_by ?? null,
      revision: doc.revision ?? null,
      chronicle: doc.chronicle ?? null,
    }
  })

  await attempt('sparql_query — named graphs and their sizes', () =>
    mcp.callTool('sparql_query', {
      graphId: GRAPH_ID,
      query: 'SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g ORDER BY ?g',
    }),
  )

  await attempt('sparql_query — the subject ANYWHERE (no GRAPH clause)', () =>
    mcp.callTool('sparql_query', {
      graphId: GRAPH_ID,
      query: `SELECT ?p ?o WHERE { <${subject}> ?p ?o } ORDER BY ?p`,
    }),
  )

  await attempt('sparql_query — the subject in ANY named graph', () =>
    mcp.callTool('sparql_query', {
      graphId: GRAPH_ID,
      query: `SELECT ?g ?p ?o WHERE { GRAPH ?g { <${subject}> ?p ?o } } ORDER BY ?g ?p`,
    }),
  )

  await attempt('sparql_query_named — the doc projection graph', () =>
    mcp.callTool('sparql_query_named', {
      graphId: GRAPH_ID,
      graphIri: docGraph,
      query: `SELECT ?p ?o WHERE { <${subject}> ?p ?o } ORDER BY ?p`,
    }),
  )

  await attempt('rdf_dump — the doc projection graph', async () => {
    const dump = (await mcp.callTool('rdf_dump', {
      graphId: GRAPH_ID,
      sourceGraphIri: docGraph,
      format: 'application/n-triples',
    })) as Record<string, unknown>
    const body = String(dump.data ?? dump.body ?? '')
    return body || dump
  })
} finally {
  await cell.kill()
  console.log('\ncell down')
}
