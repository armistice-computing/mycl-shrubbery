/**
 * The arguments the desktop app sends to gardend's `create_graph`.
 *
 * gardend's strict argument contract requires `graph_id` beside `title`
 * (garden mcp_tool_catalog.json, since 634b024); a call with the title alone
 * is refused with "arguments.graph_id is required" and creates nothing. The
 * id is readable, because it shows in the address (/g/<id>): the title as a
 * slug, with -2, -3 ... when a graph already has it.
 */

export interface NativeCreateGraphArguments {
  readonly graph_id: string
  readonly title: string
}

const MAX_SLUG_LENGTH = 48

export function graphSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
  return slug || 'graph'
}

export function nativeCreateGraphArguments(
  title: string,
  existingGraphIds: Iterable<string>,
): NativeCreateGraphArguments {
  const taken = new Set(existingGraphIds)
  const base = graphSlug(title)
  let graphId = base
  for (let n = 2; taken.has(graphId); n += 1) graphId = `${base}-${n}`
  return { graph_id: graphId, title: title.trim() }
}
