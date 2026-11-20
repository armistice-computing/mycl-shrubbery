/**
 * artifact-image-resolver.ts: turn a stored image src into an object URL, safely.
 *
 * Two kinds of src name an image stored in a graph (editor-kernel image-src.ts):
 * `mycl-artifact://{graph}/{artifact}` (a captured file) and an uploaded
 * image's URL (`.../artifacts/{graph}/images/{id}`). Only the two ids are used.
 * The bytes come from the node's CURRENT API, with the session's bearer auth,
 * through a fetch the host supplies:
 *
 * - GET /artifacts/{graph}/{artifact}/download (artifacts.read) for artifacts;
 * - GET /artifacts/{graph}/images/{id} (images.read) for uploads. The stored
 *   origin, port and expiring token are discarded. No URL taken from a
 *   document is ever fetched, so auth never goes anywhere but the node.
 *
 * An image is resolved only when its graph is the editor's current graph,
 * checked before the fetch and again after it, just before the object URL is
 * made. The download route answers for any captured file, so this module also
 * decides what may be shown:
 *
 * - a 2xx answer only;
 * - Content-Type image/png, image/jpeg, image/gif or image/webp, AND the first
 *   bytes match that same type (SVG, HTML and anything else are refused, even
 *   when the type claims to be an image);
 * - at most ARTIFACT_IMAGE_MAX_BYTES, checked against Content-Length and the
 *   bytes actually read.
 *
 * Memory: at most ARTIFACT_IMAGE_MAX_CONCURRENT downloads run at once (the
 * rest wait, holding no bytes). Checked blobs are kept up to
 * ARTIFACT_IMAGE_CACHE_BYTES in total, least recently used first out. This
 * bounds the resolver's own cache and downloads only: images shown in the
 * page are on top of it, each behind its view's own object URL.
 */
import { storedImageRef, type ImageResolver, type StoredImageRef } from '@shrubbery/editor-kernel'

/** Same cap as the node's LOCAL_IMAGE_UPLOAD_MAX_BYTES. */
export const ARTIFACT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
/** Total bytes of checked blobs one resolver keeps. */
export const ARTIFACT_IMAGE_CACHE_BYTES = 32 * 1024 * 1024
/** Downloads one resolver runs at once. */
export const ARTIFACT_IMAGE_MAX_CONCURRENT = 4

export type ArtifactImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface ArtifactImageSource {
  /** Authenticated GET /artifacts/{graph}/{artifact}/download on the current API. */
  fetchArtifact(graphId: string, artifactId: string): Promise<Response>
  /** Authenticated GET /artifacts/{graph}/images/{imageId} on the current API. */
  fetchUploadedImage(graphId: string, imageId: string): Promise<Response>
}

export interface ObjectUrls {
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
}

const ALLOWED = new Set<ArtifactImageType>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export const IMAGE_REFUSED = {
  missing: "Couldn't be found in this graph.",
  failed: "Couldn't be loaded.",
  notImage: 'Not an image Mycl can show.',
  tooLarge: 'Too large to show (over 10 MB).',
  otherGraph: 'Image from another graph.',
} as const

/** The image type the first bytes declare, or null. */
export function sniffImageType(bytes: Uint8Array): ArtifactImageType | null {
  const at = (i: number) => bytes[i]
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47
    && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'image/png'
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38
    && (at(4) === 0x37 || at(4) === 0x39) && at(5) === 0x61) return 'image/gif'
  if (bytes.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp'
  return null
}

function declaredType(response: Response): ArtifactImageType | null {
  const raw = response.headers.get('content-type') ?? ''
  const base = raw.split(';')[0]!.trim().toLowerCase()
  return ALLOWED.has(base as ArtifactImageType) ? (base as ArtifactImageType) : null
}

async function readCapped(response: Response, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader()
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > cap) throw new Error(IMAGE_REFUSED.tooLarge)
    return buffer
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      throw new Error(IMAGE_REFUSED.tooLarge)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Fetch and check one artifact image. Throws an Error whose message is a plain
 * sentence for the placeholder.
 */
export async function loadArtifactImage(
  source: ArtifactImageSource,
  graphId: string,
  artifactId: string,
  cap = ARTIFACT_IMAGE_MAX_BYTES,
): Promise<Blob> {
  return loadCheckedImage(() => source.fetchArtifact(graphId, artifactId), cap)
}

/** Fetch and check one stored image's bytes (see the module comment). */
export async function loadCheckedImage(
  fetchBytes: () => Promise<Response>,
  cap = ARTIFACT_IMAGE_MAX_BYTES,
): Promise<Blob> {
  let response: Response
  try {
    response = await fetchBytes()
  } catch {
    throw new Error(IMAGE_REFUSED.failed)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(response.status === 404 ? IMAGE_REFUSED.missing : IMAGE_REFUSED.failed)
  }
  const type = declaredType(response)
  if (!type) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(IMAGE_REFUSED.notImage)
  }
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > cap) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(IMAGE_REFUSED.tooLarge)
  }
  const bytes = await readCapped(response, cap)
  if (sniffImageType(bytes) !== type) throw new Error(IMAGE_REFUSED.notImage)
  return new Blob([bytes], { type })
}

const browserObjectUrls: ObjectUrls = {
  createObjectURL: blob => URL.createObjectURL(blob),
  revokeObjectURL: url => URL.revokeObjectURL(url),
}

export interface ArtifactImageResolverOptions {
  /** The editor's graph right now; an image from any other graph is refused. */
  readonly currentGraphId: () => string | null | undefined
  readonly urls?: ObjectUrls
  readonly maxCacheBytes?: number
  readonly maxConcurrent?: number
}

/** A counting gate: at most `limit` tasks run, the rest wait in order. */
function concurrencyGate(limit: number) {
  let running = 0
  const waiting: Array<() => void> = []
  // A finishing task hands its slot straight to the next waiter, so a new
  // caller can never slip in between and push the count over the limit.
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else running -= 1
  }
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>(resolve => waiting.push(resolve))
    else running += 1
    try {
      return await task()
    } finally {
      release()
    }
  }
}

function refKey(ref: StoredImageRef): string {
  return `${ref.source}\u0000${ref.graphId}\u0000${ref.id}`
}

/**
 * The kernel's `resolveImage`. Each call gets its own object URL (each view
 * revokes its own). Checked Blobs are shared: one download per image while
 * it is in flight, then kept in a byte-capped LRU. A refusal is not kept, so
 * the next view asks again. Evicting a Blob only drops the cache's reference:
 * a view still showing it keeps it alive until that view revokes its URL.
 */
export function makeArtifactImageResolver(
  source: ArtifactImageSource,
  options: ArtifactImageResolverOptions,
): ImageResolver {
  const urls = options.urls ?? browserObjectUrls
  const maxCacheBytes = options.maxCacheBytes ?? ARTIFACT_IMAGE_CACHE_BYTES
  const gate = concurrencyGate(options.maxConcurrent ?? ARTIFACT_IMAGE_MAX_CONCURRENT)
  const cache = new Map<string, Blob>()
  let cachedBytes = 0
  const inFlight = new Map<string, Promise<Blob>>()

  const remember = (key: string, blob: Blob) => {
    if (blob.size > maxCacheBytes) return
    const prior = cache.get(key)
    if (prior) {
      cache.delete(key)
      cachedBytes -= prior.size
    }
    cache.set(key, blob)
    cachedBytes += blob.size
    while (cachedBytes > maxCacheBytes) {
      const oldest = cache.keys().next().value!
      cachedBytes -= cache.get(oldest)!.size
      cache.delete(oldest)
    }
  }

  const blobFor = (ref: StoredImageRef): Promise<Blob> => {
    const key = refKey(ref)
    const cached = cache.get(key)
    if (cached) {
      cache.delete(key)
      cache.set(key, cached)
      return Promise.resolve(cached)
    }
    const pending = inFlight.get(key)
    if (pending) return pending
    const fetchBytes = ref.source === 'artifact'
      ? () => source.fetchArtifact(ref.graphId, ref.id)
      : () => source.fetchUploadedImage(ref.graphId, ref.id)
    const loading = gate(() => loadCheckedImage(fetchBytes))
    inFlight.set(key, loading)
    loading.then(
      blob => {
        inFlight.delete(key)
        remember(key, blob)
      },
      () => inFlight.delete(key),
    )
    return loading
  }

  const isCurrentGraph = (graphId: string) => {
    const current = options.currentGraphId()
    return typeof current === 'string' ? current === graphId : false
  }

  return async (src: string) => {
    const ref = storedImageRef(src)
    if (!ref) return null
    if (!isCurrentGraph(ref.graphId)) throw new Error(IMAGE_REFUSED.otherGraph)
    const blob = await blobFor(ref)
    // The editor may have moved to another graph while the bytes came in.
    if (!isCurrentGraph(ref.graphId)) throw new Error(IMAGE_REFUSED.otherGraph)
    const url = urls.createObjectURL(blob)
    let revoked = false
    return {
      url,
      revoke: () => {
        if (revoked) return
        revoked = true
        urls.revokeObjectURL(url)
      },
    }
  }
}
