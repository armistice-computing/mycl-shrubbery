import { describe, expect, it } from 'vitest'
import { AtlasSnapshotReader } from '../src/cell/atlas-snapshot-reader.js'

const doc = 'urn:mnemosyne:local:document:'
const rows = (title: string) => ({ rows: [{ kind: '"document"', id: `<${doc}${title}>`, title: `"${title}"` }] })

/** A query whose answers the test releases by hand. */
function controlledQuery() {
  const calls: { graphId: string; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = []
  const query = (graphId: string) => new Promise<unknown>((resolve, reject) => { calls.push({ graphId, resolve, reject }) })
  return { calls, query }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('AtlasSnapshotReader', () => {
  it('a read for graph A neither lands on B nor blocks B, through A -> B -> A', async () => {
    const { calls, query } = controlledQuery()
    const reader = new AtlasSnapshotReader({ query, onChange: () => {} })
    void reader.request('A', false)
    reader.reset('B')
    void reader.request('B', false)
    expect(calls.map((c) => c.graphId)).toEqual(['A', 'B'])
    calls[0]!.resolve(rows('a1'))
    await tick()
    expect(reader.graphId).toBe('B')
    expect(reader.snapshot).toBeNull()
    expect(reader.status).toBe('loading')

    // Back to A while B is still reading: A reads afresh; B's late answer is dropped.
    reader.reset('A')
    void reader.request('A', false)
    expect(calls.map((c) => c.graphId)).toEqual(['A', 'B', 'A'])
    calls[1]!.resolve(rows('b'))
    await tick()
    expect(reader.snapshot).toBeNull()
    calls[2]!.resolve(rows('a2'))
    await tick()
    expect(reader.snapshot?.graphId).toBe('A')
    expect(reader.snapshot?.documents.map((d) => d.id)).toEqual(['a2'])
    expect(reader.status).toBe('ready')
  })

  it('one read per graph at a time, reused while fresh, forced by Refresh', async () => {
    const { calls, query } = controlledQuery()
    let now = 1_000
    const reader = new AtlasSnapshotReader({ query, onChange: () => {}, now: () => now, freshMs: 30_000 })
    void reader.request('A', false)
    void reader.request('A', true)
    expect(calls).toHaveLength(1)
    calls[0]!.resolve(rows('a'))
    await tick()
    void reader.request('A', false)
    expect(calls).toHaveLength(1)
    now += 31_000
    void reader.request('A', false)
    expect(calls).toHaveLength(2)
    calls[1]!.resolve(rows('a'))
    await tick()
    void reader.request('A', true)
    expect(calls).toHaveLength(3)
  })

  it('a failed read keeps the last complete map', async () => {
    const { calls, query } = controlledQuery()
    const reader = new AtlasSnapshotReader({ query, onChange: () => {} })
    void reader.request('A', false)
    calls[0]!.resolve(rows('a'))
    await tick()
    void reader.request('A', true)
    calls[1]!.reject(new Error('gardend busy'))
    await tick()
    expect(reader.snapshot?.documents.map((d) => d.id)).toEqual(['a'])
    expect(reader.status).toBe('ready')
    expect(reader.error).toBe('gardend busy')
    reader.reset('B')
    void reader.request('B', false)
    calls[2]!.reject(new Error('no store'))
    await tick()
    expect(reader.status).toBe('error')
  })
})
