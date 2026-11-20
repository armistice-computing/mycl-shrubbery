import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { graphSlug, nativeCreateGraphArguments } from '../native-graph-create.js'

// gardend's own argument contract, read from a backend checkout beside this one
// (GARDEN_REPO, or ../mycl or ../garden). Without one, the contract check skips.
// The shell once sent { title } alone, which gardend refuses ("arguments.graph_id
// is required"), so the New Workspace button did nothing.
const CATALOG_CANDIDATES = [
  ...(process.env.GARDEN_REPO ? [new URL(`file://${process.env.GARDEN_REPO}/src-tauri/src/mcp_tool_catalog.json`)] : []),
  ...[
    '../../../../../../mycl/src-tauri/src/mcp_tool_catalog.json',
    '../../../../../../garden/src-tauri/src/mcp_tool_catalog.json',
  ].map(rel => new URL(rel, import.meta.url)),
]

function createGraphRequired(): string[] | null {
  const file = CATALOG_CANDIDATES.find(url => existsSync(url))
  if (!file) return null
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const tools = (Array.isArray(raw) ? raw : (raw as { tools?: unknown[] }).tools ?? Object.values(raw as object)) as Array<Record<string, unknown>>
  const tool = tools.find(t => t?.name === 'create_graph')
  const schema = (tool?.inputSchema ?? tool?.input_schema) as { required?: string[] } | undefined
  return schema?.required ?? null
}

describe('the desktop app creating a graph', () => {
  it('sends a graph id and a title', () => {
    const args = nativeCreateGraphArguments('Money for girls', [])
    expect(args).toEqual({ graph_id: 'money-for-girls', title: 'Money for girls' })
  })

  const required = createGraphRequired()
  it.skipIf(required === null)('sends every argument gardend requires', () => {
    const args = nativeCreateGraphArguments('Money for girls', [])
    for (const key of required ?? []) expect(args).toHaveProperty(key)
  })

  it('keeps the id readable and unique among the graphs that exist', () => {
    expect(nativeCreateGraphArguments('Notes', ['notes', 'notes-2']).graph_id).toBe('notes-3')
    expect(nativeCreateGraphArguments('  Café: Études!  ', []).graph_id).toBe('cafe-etudes')
    expect(graphSlug('***')).toBe('graph')
    expect(graphSlug('a'.repeat(80))).toHaveLength(48)
  })
})
