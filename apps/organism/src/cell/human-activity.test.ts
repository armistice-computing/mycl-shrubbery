import { afterEach, describe, expect, it, vi } from 'vitest'
import { HumanActivityClient, parseHumanRecent } from './human-activity.js'
import type { CellContract } from './session-store.js'

const contract = {
  runtime: { graphBaseUrl: () => 'http://127.0.0.1:9/' },
  auth: { userId: () => 'owner', token: () => 'owner-token' },
} as unknown as CellContract

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseHumanRecent', () => {
  it('keeps rows with an id and a usable time, in gardend order', () => {
    expect(parseHumanRecent({
      graphId: 'g',
      documents: [
        { documentId: 'a', title: 'A', lastOpenedAt: 30, openCount: 4 },
        { documentId: '', lastOpenedAt: 20 },
        { documentId: 'b', title: null, lastOpenedAt: 'yesterday' },
        { documentId: 'c', lastOpenedAt: 10 },
      ],
    })).toEqual([
      { documentId: 'a', lastOpenedAt: 30, openCount: 4 },
      { documentId: 'c', lastOpenedAt: 10, openCount: 1 },
    ])
    expect(parseHumanRecent(null)).toEqual([])
  })
})

describe('HumanActivityClient', () => {
  it('posts opens to the owner route and reads recents back', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/opened')) return new Response(JSON.stringify({ ok: true, recorded: true }))
      return new Response(JSON.stringify({ graphId: 'g', documents: [{ documentId: 'a', lastOpenedAt: 5, openCount: 1 }] }))
    })
    const client = new HumanActivityClient()
    await client.recordOpened(contract, 'g', 'a')
    expect(await client.recent(contract, 'g', 10)).toEqual([{ documentId: 'a', lastOpenedAt: 5, openCount: 1 }])
    expect(calls[0]!.url).toBe('http://127.0.0.1:9/activity/g/opened')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ documentId: 'a' })
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer owner-token')
    expect(calls[1]!.url).toBe('http://127.0.0.1:9/activity/g/recent?limit=10')
  })

  it('stops asking a gardend without the routes, and survives a network failure', async () => {
    let count = 0
    vi.stubGlobal('fetch', async () => {
      count += 1
      return new Response('not found', { status: 404 })
    })
    const client = new HumanActivityClient()
    expect(await client.recent(contract, 'g')).toBeNull()
    expect(client.available('g')).toBe(false)
    await client.recordOpened(contract, 'g', 'a')
    expect(await client.recent(contract, 'g')).toBeNull()
    expect(count).toBe(1)
    // gardend also answers 404 for an unknown graph, so one graph's 404
    // leaves the others asking.
    expect(client.available('other')).toBe(true)

    vi.stubGlobal('fetch', async () => { throw new TypeError('offline') })
    const fresh = new HumanActivityClient()
    await expect(fresh.recordOpened(contract, 'g', 'a')).resolves.toBeUndefined()
    expect(await fresh.recent(contract, 'g')).toBeNull()
    expect(fresh.available('g')).toBe(true)
  })
})
