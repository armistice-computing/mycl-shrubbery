import { describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_IMAGE_MAX_BYTES,
  IMAGE_REFUSED,
  loadArtifactImage,
  makeArtifactImageResolver,
  sniffImageType,
  type ArtifactImageSource,
  type ObjectUrls,
} from '../editor-services/artifact-image-resolver.js'
import { buildKernelOptions, type EditorServices } from '../editor-services/assemble.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')
const HTML = new TextEncoder().encode('<!doctype html><p>hi</p>')

function respond(bytes: Uint8Array, type: string, init: { status?: number; length?: number } = {}): Response {
  const headers = new Headers({ 'content-type': type })
  if (init.length !== undefined) headers.set('content-length', String(init.length))
  return new Response(bytes as Uint8Array<ArrayBuffer>, { status: init.status ?? 200, headers })
}

/** A PNG of exactly `size` bytes. */
function pngOf(size: number): Uint8Array {
  const out = new Uint8Array(size)
  out.set(PNG)
  return out
}

function source(handler: () => Response | Promise<Response> = () => respond(PNG, 'image/png')) {
  const fetchArtifact = vi.fn(async (_g: string, _a: string) => handler())
  const fetchUploadedImage = vi.fn(async (_g: string, _i: string) => handler())
  return { fetchArtifact, fetchUploadedImage } satisfies ArtifactImageSource
}

function objectUrls() {
  const created: Blob[] = []
  const revoked: string[] = []
  const urls: ObjectUrls = {
    createObjectURL: blob => { created.push(blob); return `blob:${created.length}` },
    revokeObjectURL: url => { revoked.push(url) },
  }
  return { urls, created, revoked }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('sniffImageType', () => {
  it('knows the four raster signatures and nothing else', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(GIF)).toBe('image/gif')
    expect(sniffImageType(WEBP)).toBe('image/webp')
    expect(sniffImageType(SVG)).toBeNull()
    expect(sniffImageType(HTML)).toBeNull()
    expect(sniffImageType(new Uint8Array())).toBeNull()
  })
})

describe('loadArtifactImage', () => {
  it('returns a typed blob when the type and the first bytes agree', async () => {
    const blob = await loadArtifactImage(source(() => respond(PNG, 'image/png; charset=binary')), 'g', 'a')
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(PNG.byteLength)
  })

  it.each([
    ['PNG bytes sent as JPEG', PNG, 'image/jpeg'],
    ['HTML sent as PNG', HTML, 'image/png'],
    ['SVG sent as SVG', SVG, 'image/svg+xml'],
    ['SVG bytes sent as PNG', SVG, 'image/png'],
    ['a PDF', new TextEncoder().encode('%PDF-1.7'), 'application/pdf'],
    ['an octet-stream PNG', PNG, 'application/octet-stream'],
    ['no type', PNG, ''],
  ])('refuses %s', async (_label, bytes, type) => {
    await expect(loadArtifactImage(source(() => respond(bytes, type)), 'g', 'a')).rejects.toThrow(IMAGE_REFUSED.notImage)
  })

  it('never treats an error answer as an image', async () => {
    await expect(loadArtifactImage(source(() => respond(PNG, 'image/png', { status: 404 })), 'g', 'a')).rejects.toThrow(IMAGE_REFUSED.missing)
    await expect(loadArtifactImage(source(() => respond(PNG, 'image/png', { status: 403 })), 'g', 'a')).rejects.toThrow(IMAGE_REFUSED.failed)
    await expect(loadArtifactImage(source(() => Promise.reject(new TypeError('network'))), 'g', 'a')).rejects.toThrow(IMAGE_REFUSED.failed)
  })

  it('refuses an image over the cap by its declared length and by the bytes read', async () => {
    await expect(loadArtifactImage(source(() => respond(PNG, 'image/png', { length: ARTIFACT_IMAGE_MAX_BYTES + 1 })), 'g', 'a'))
      .rejects.toThrow(IMAGE_REFUSED.tooLarge)
    await expect(loadArtifactImage(source(() => respond(pngOf(64), 'image/png')), 'g', 'a', 32)).rejects.toThrow(IMAGE_REFUSED.tooLarge)
  })
})

describe('makeArtifactImageResolver', () => {
  it('resolves a captured file of the current graph to a revocable object URL', async () => {
    const src = source(() => respond(GIF, 'image/gif'))
    const { urls, created, revoked } = objectUrls()
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => 'my-graph', urls })
    const result = await resolve('mycl-artifact://my-graph/artifact%2Eone')
    expect(src.fetchArtifact).toHaveBeenCalledWith('my-graph', 'artifact.one')
    expect(result?.url).toBe('blob:1')
    expect(created[0]?.type).toBe('image/gif')
    result!.revoke()
    result!.revoke()
    expect(revoked).toEqual(['blob:1'])
  })

  it('refuses an image from another graph and fetches nothing', async () => {
    const src = source()
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => 'mine', urls: objectUrls().urls })
    await expect(resolve('mycl-artifact://theirs/a1')).rejects.toThrow(IMAGE_REFUSED.otherGraph)
    await expect(resolve('http://127.0.0.1:4100/artifacts/theirs/images/i1?token=t')).rejects.toThrow(IMAGE_REFUSED.otherGraph)
    const noGraph = makeArtifactImageResolver(src, { currentGraphId: () => null, urls: objectUrls().urls })
    await expect(noGraph('mycl-artifact://mine/a1')).rejects.toThrow(IMAGE_REFUSED.otherGraph)
    expect(src.fetchArtifact).not.toHaveBeenCalled()
    expect(src.fetchUploadedImage).not.toHaveBeenCalled()
  })

  it('drops the image when the editor changes graph while it downloads', async () => {
    let finish!: (r: Response) => void
    const src = source(() => new Promise<Response>(resolve => { finish = resolve }))
    const { urls, created } = objectUrls()
    let graph = 'mine'
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => graph, urls })
    const pending = resolve('mycl-artifact://mine/a1')
    await flush()
    graph = 'elsewhere'
    finish(respond(PNG, 'image/png'))
    await expect(pending).rejects.toThrow(IMAGE_REFUSED.otherGraph)
    expect(created).toHaveLength(0)
  })

  it('fetches a legacy upload by ids through the current API, whatever origin, port or token it stored', async () => {
    const src = source()
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => 'g', urls: objectUrls().urls })
    const result = await resolve('http://127.0.0.1:61234/artifacts/g/images/b7ec-1?token=expired&exp=1&fn=a.png')
    expect(result?.url).toBe('blob:1')
    expect(src.fetchUploadedImage).toHaveBeenCalledWith('g', 'b7ec-1')
    expect(src.fetchArtifact).not.toHaveBeenCalled()
  })

  it('downloads an image once for re-created views and retries a refusal', async () => {
    let calls = 0
    const src = source(() => (++calls === 1 ? respond(HTML, 'image/png') : respond(PNG, 'image/png')))
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => 'g', urls: objectUrls().urls })
    await expect(resolve('mycl-artifact://g/a')).rejects.toThrow(IMAGE_REFUSED.notImage)
    const first = await resolve('mycl-artifact://g/a')
    const second = await resolve('mycl-artifact://g/a')
    expect(calls).toBe(2)
    expect(first?.url).not.toBe(second?.url)
  })

  it('shares one download between views asking at the same time', async () => {
    const src = source()
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => 'g', urls: objectUrls().urls })
    await Promise.all([resolve('mycl-artifact://g/a'), resolve('mycl-artifact://g/a'), resolve('mycl-artifact://g/a')])
    expect(src.fetchArtifact).toHaveBeenCalledTimes(1)
  })

  it('keeps cached bytes under the byte cap, least recently used out first', async () => {
    const src = source(() => respond(pngOf(40), 'image/png'))
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => 'g', urls: objectUrls().urls, maxCacheBytes: 100 })
    await resolve('mycl-artifact://g/a')
    await resolve('mycl-artifact://g/b')
    await flush()
    await resolve('mycl-artifact://g/a') // a is now the most recent
    await resolve('mycl-artifact://g/c') // 120 bytes: b goes
    await flush()
    expect(src.fetchArtifact).toHaveBeenCalledTimes(3)
    await resolve('mycl-artifact://g/a')
    await resolve('mycl-artifact://g/c')
    expect(src.fetchArtifact).toHaveBeenCalledTimes(3)
    await resolve('mycl-artifact://g/b')
    expect(src.fetchArtifact).toHaveBeenCalledTimes(4)
  })

  it('a view keeps showing an evicted image until it revokes its own URL', async () => {
    const src = source(() => respond(pngOf(60), 'image/png'))
    const { urls, revoked } = objectUrls()
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => 'g', urls, maxCacheBytes: 100 })
    const a = await resolve('mycl-artifact://g/a')
    await resolve('mycl-artifact://g/b') // evicts a from the cache
    await flush()
    expect(revoked).toEqual([])
    a!.revoke()
    expect(revoked).toEqual([a!.url])
  })

  it('runs at most four downloads at once', async () => {
    let active = 0
    let peak = 0
    const finishers: Array<() => void> = []
    const src = source(() => new Promise<Response>(resolve => {
      active += 1
      peak = Math.max(peak, active)
      finishers.push(() => { active -= 1; resolve(respond(PNG, 'image/png')) })
    }))
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => 'g', urls: objectUrls().urls })
    const all = Promise.all(Array.from({ length: 10 }, (_, i) => resolve(`mycl-artifact://g/a${i}`)))
    await flush()
    expect(active).toBe(4)
    while (finishers.length) {
      finishers.shift()!()
      await flush()
      await flush()
    }
    await all
    expect(peak).toBe(4)
    expect(src.fetchArtifact).toHaveBeenCalledTimes(10)
  })

  it('makes no fetch for a src that names no stored image', async () => {
    const src = source()
    const resolve = makeArtifactImageResolver(src, { currentGraphId: () => 'g', urls: objectUrls().urls })
    for (const bad of ['https://example.com/x.png', 'mycl-artifact://g/a?token=1', 'mycl-artifact://g/a/b', '/artifacts/g/a/download']) {
      expect(await resolve(bad)).toBeNull()
    }
    expect(src.fetchArtifact).not.toHaveBeenCalled()
    expect(src.fetchUploadedImage).not.toHaveBeenCalled()
  })
})

describe('buildKernelOptions', () => {
  const base = { navigation: {}, wire: {}, queryBlocks: {} } as unknown as EditorServices
  const scope = { centerMode: 'document', graphId: 'g', documentId: 'd' } as const

  it('passes no image resolver when the host gives no image source', () => {
    expect(buildKernelOptions(base, scope).resolveImage).toBeUndefined()
  })

  it("binds the resolver to the editor's own graph", async () => {
    const src = source()
    const options = buildKernelOptions({ ...base, artifactImages: src }, scope)
    await expect(options.resolveImage!('mycl-artifact://other/a')).rejects.toThrow(IMAGE_REFUSED.otherGraph)
    expect(src.fetchArtifact).not.toHaveBeenCalled()
  })
})
