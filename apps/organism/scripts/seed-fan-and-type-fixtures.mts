/**
 * seed-fan-and-type-fixtures.mts — two things to LOOK at, side by side with
 * cloud-1.
 *
 * Run AFTER `pnpm gardend:dev` is up (it reads that cell's coordinates from
 * .gardend-loopback.json) and before or during `pnpm dev`.
 *
 *   pnpm -C apps/organism exec tsx scripts/seed-fan-and-type-fixtures.mts
 *
 * Seeds:
 *   - "Fanout — six wires", a document carrying SIX document-level wires (three
 *     out, three in) plus one block-level wire, so the status-dot fan and the
 *     gutter bubble can be compared in one place. Six is past the n > 4
 *     boundary where the fan switches to ellipse mode, which is the geometry a
 *     real document actually reaches.
 *   - "Type specimen", every weight and family the app uses, at the sizes it
 *     uses them, so "everything is a smidge thicker" can be pinned to a
 *     specific family or weight rather than a general impression. Open the same
 *     page in two browsers and the difference is either there or it is not.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

const ORGANISM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loopback = JSON.parse(
  readFileSync(join(ORGANISM_DIR, '.gardend-loopback.json'), 'utf8'),
) as { mcpUrl: string; apiUrl: string; token: string; graphId: string }

const mcp = new LoopbackMcpClient({
  mcpUrl: loopback.mcpUrl,
  healthUrl: `${loopback.apiUrl}/health`,
  token: loopback.token,
  origin: 'http://127.0.0.1',
})
const call = (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  mcp.callTool(name, args) as Promise<Record<string, unknown>>

const graphId = loopback.graphId
const FAN_DOC = 'doc-fanout-six'
const TYPE_DOC = 'doc-type-specimen'
const OUT = ['doc-fan-out-1', 'doc-fan-out-2', 'doc-fan-out-3']
const IN = ['doc-fan-in-1', 'doc-fan-in-2', 'doc-fan-in-3']

// ── the fan ────────────────────────────────────────────────────────────────
await call('create_document', { graphId, documentId: FAN_DOC, title: 'Fanout — six wires' })
await call('write_document', {
  graphId,
  documentId: FAN_DOC,
  content: [
    '<h1>Fanout — six wires</h1>',
    '<p>The status dot at the far left of the bar above the toolbar should be ringed and pulsing. Hover it: six cards should fan out, each with a faint line back to the dot.</p>',
    '<p>THIS paragraph also carries a block-level wire, so the gutter bubble and the document bubble can be compared without switching documents.</p>',
    '<p>Filler.</p>',
    '<p>Filler.</p>',
  ].join(''),
})

for (const [index, id] of [...OUT, ...IN].entries()) {
  await call('create_document', { graphId, documentId: id, title: `Fan neighbour ${index + 1}` })
  await call('write_document', {
    graphId,
    documentId: id,
    content: `<h1>Fan neighbour ${index + 1}</h1><p>The far end of one wire.</p>`,
  })
}

/** query_blocks nests rows under results[].blocks, not a top-level `blocks`. */
async function blockIds(documentId: string): Promise<string[]> {
  const payload = await call('query_blocks', { graphId, documentId })
  const results = (payload.results ?? []) as Record<string, unknown>[]
  const blocks = (results[0]?.blocks ?? []) as Record<string, unknown>[]
  return blocks.map(block => String(block.block_id ?? block.blockId ?? '')).filter(Boolean)
}

const fanBlocks = await blockIds(FAN_DOC)
await call('create_wires', {
  graphId,
  wires: [
    // One block-level wire, as the control: it wears a gutter bubble and must
    // NOT appear in the document-level fan.
    {
      sourceDocumentId: FAN_DOC,
      targetDocumentId: OUT[0],
      sourceBlockId: fanBlocks[2] ?? fanBlocks[0],
      predicate: 'supports',
    },
    ...OUT.map(target => ({ sourceDocumentId: FAN_DOC, targetDocumentId: target, predicate: 'relatedTo' })),
    ...IN.map(source => ({ sourceDocumentId: source, targetDocumentId: FAN_DOC, predicate: 'supports' })),
  ],
})

// ── the type specimen ──────────────────────────────────────────────────────
await call('create_document', { graphId, documentId: TYPE_DOC, title: 'Type specimen' })
await call('write_document', {
  graphId,
  documentId: TYPE_DOC,
  content: [
    '<h1>Type specimen</h1>',
    '<p>Open this document in both browsers, at the same zoom, on the same display. If the weight differs it differs HERE, on prose, and the culprit is the family or its weight — not the renderer.</p>',
    '<h2>Heading two, for the bold comparison</h2>',
    '<h3>Heading three</h3>',
    '<p>Regular prose at body size. The quick brown fox jumps over the lazy dog, and the same sentence again so there is enough ink on the line to judge stem weight rather than a single word.</p>',
    '<p><strong>Bold prose at body size.</strong> The quick brown fox jumps over the lazy dog, and the same sentence again so there is enough ink on the line to judge stem weight rather than a single word.</p>',
    '<p><em>Italic prose at body size.</em> The quick brown fox jumps over the lazy dog.</p>',
    '<p><strong><em>Bold italic.</em></strong> The quick brown fox jumps over the lazy dog.</p>',
    '<p><code>Monospace inline at body size — 0O1lI conveys the family.</code></p>',
    '<blockquote><p>A blockquote, which some themes set at a different weight than the prose around it.</p></blockquote>',
    '<ul><li>A list item, regular.</li><li><strong>A list item, bold.</strong></li></ul>',
    '<p>Numerals and punctuation, where weight differences hide: 0123456789 — “quotes” ‘single’ … —</p>',
  ].join(''),
})

console.log(`
seeded into graph "${graphId}":

  ${FAN_DOC}   — "Fanout — six wires"   six document-level wires + one block-level
  ${TYPE_DOC}  — "Type specimen"        every weight and family, for side-by-side

For the fan, in the browser console:  window.__wireFanDebug = true
then hover the status dot and paste what it logs.
`)
