/** Shared pagination for local and hosted computed salience, including baselines. */
export async function readSalienceScorePages(
  getJson: (path: string) => Promise<{ blocks?: unknown[]; page?: { nextOffset?: unknown } | null }>,
  graphId: string,
  documentId: string,
  blockIds?: readonly string[],
): Promise<unknown[]> {
  const ids = blockIds === undefined ? undefined : [...new Set(blockIds)]
  if (ids?.length === 0) return []
  const limit = Math.min(ids?.length ?? 1000, 1000)
  const filter = ids === undefined ? '' : `&block_ids=${encodeURIComponent(ids.join(','))}`
  const path = `/salience/${encodeURIComponent(graphId)}/blocks/values?document_id=${encodeURIComponent(documentId)}&limit=${limit}${filter}`
  const result: unknown[] = []
  let offset = 0
  while (true) {
    const raw = await getJson(`${path}${offset === 0 ? '' : `&offset=${offset}`}`)
    const blocks = Array.isArray(raw.blocks) ? raw.blocks : []
    result.push(...blocks)
    // Small filtered reads fit in one page. Legacy gateways omit page entirely.
    if (ids !== undefined && ids.length <= limit) break
    const next = raw.page?.nextOffset
    if (blocks.length === 0 || typeof next !== 'number' || !Number.isSafeInteger(next)
      || next <= offset || next > offset + limit) break
    offset = next
  }
  return result
}
