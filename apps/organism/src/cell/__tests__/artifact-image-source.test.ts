import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactImageSource } from '../rest-helpers.js'
import type { CellContract } from '../session-store.js'

const API = 'http://127.0.0.1:4100'

function contract(): CellContract {
  return {
    auth: { userId: () => 'owner', token: () => 'secret-token' },
    runtime: { graphBaseUrl: () => API },
  } as unknown as CellContract
}

afterEach(() => vi.unstubAllGlobals())

describe('artifactImageSource', () => {
  it('fetches artifact bytes from the current API only, with auth and no cookies', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await artifactImageSource(contract()).fetchArtifact('g', 'artifact.one')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${API}/artifacts/g/artifact.one/download`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
    expect(init.credentials).toBe('omit')
  })

  it('fetches an uploaded image by id from the current API, never the stored URL', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await artifactImageSource(contract()).fetchUploadedImage('g', 'b7ec-1')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${API}/artifacts/g/images/b7ec-1`)
    expect(url).not.toContain('token=')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
  })
})
