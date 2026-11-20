/**
 * image-src.ts: what an image block may load, decided from its src alone.
 *
 * An image block's src is persisted verbatim in the document. The node view
 * asks classifyImageSrc which of three things to do with it:
 *
 * - `resolve`: an image stored in a graph, which only the host may fetch:
 *   - `mycl-artifact://{graphId}/{artifactId}`, a captured file;
 *   - an uploaded image's URL, whose path ends `/artifacts/{graphId}/images/{imageId}`
 *     (it may carry an old origin, port or token). Only the two ids are kept.
 *     The stored origin and query are discarded, never fetched, and never sent
 *     credentials.
 *   The host decides whether the graph is the editor's own and fetches through
 *   its current API. The kernel never fetches anything itself.
 * - `direct`: safe to put straight into <img src>: a data URL of a raster type
 *   (png, jpeg, gif, webp) or a blob: URL.
 * - `blocked`: everything else. A web image must never load by itself, so the
 *   node view shows a placeholder and keeps the src unchanged.
 */

/** Graph, artifact and image ids follow garden's rule (capture_event.rs valid_graph_id). */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ARTIFACT_SCHEME = 'mycl-artifact://'
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp)(;[a-z0-9=.+-]+)*(;base64)?,/i
/** An optional one-segment base path (a proxy such as /cell), then the upload route. */
const UPLOAD_PATH_RE = /^(?:\/[A-Za-z0-9._-]+)?\/artifacts\/([^/]+)\/images\/([^/]+)$/

export interface MyclArtifactRef {
  readonly graphId: string
  readonly artifactId: string
}

/** A graph-stored image the host may resolve. */
export type StoredImageRef =
  | { readonly source: 'artifact'; readonly graphId: string; readonly id: string }
  | { readonly source: 'upload'; readonly graphId: string; readonly id: string }

export type ImageSrcClass =
  | { readonly kind: 'resolve'; readonly ref: StoredImageRef }
  | { readonly kind: 'direct' }
  | { readonly kind: 'blocked'; readonly reason: 'web' | 'unsupported' | 'not-imported' }

function decodeSegment(segment: string): string | null {
  if (segment === '') return null
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    return null
  }
  return ID_RE.test(decoded) ? decoded : null
}

/**
 * Parse `mycl-artifact://{graphId}/{artifactId}`. Strict: exactly two
 * percent-encoded segments that decode to valid ids, and nothing else (no
 * query, no fragment, no extra path, no whitespace). Returns null otherwise.
 */
export function parseMyclArtifactSrc(src: string): MyclArtifactRef | null {
  if (typeof src !== 'string' || !src.startsWith(ARTIFACT_SCHEME)) return null
  const rest = src.slice(ARTIFACT_SCHEME.length)
  if (/[?#\s\\]/.test(rest)) return null
  const parts = rest.split('/')
  if (parts.length !== 2) return null
  const graphId = decodeSegment(parts[0]!)
  const artifactId = decodeSegment(parts[1]!)
  if (!graphId || !artifactId) return null
  return { graphId, artifactId }
}

/**
 * Parse an uploaded image's stored URL down to its graph and image ids. It
 * accepts an http(s) or same-origin path ending
 * `/artifacts/{graphId}/images/{imageId}`, with at most one base segment
 * before `/artifacts`. Origin, query and fragment are dropped. Returns null
 * otherwise.
 */
export function parseUploadedImageSrc(src: string): { readonly graphId: string; readonly imageId: string } | null {
  if (typeof src !== 'string' || /[\s\\]/.test(src)) return null
  const relative = src.startsWith('/') && !src.startsWith('//')
  if (!relative && !/^https?:\/\//i.test(src)) return null
  let url: URL
  try {
    url = new URL(src, 'http://stored.invalid')
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const match = UPLOAD_PATH_RE.exec(url.pathname)
  if (!match) return null
  const graphId = decodeSegment(match[1]!)
  const imageId = decodeSegment(match[2]!)
  if (!graphId || !imageId) return null
  return { graphId, imageId }
}

/** Build the persisted src for a captured artifact. */
export function myclArtifactSrc(ref: MyclArtifactRef): string {
  if (!ID_RE.test(ref.graphId) || !ID_RE.test(ref.artifactId)) {
    throw new Error('mycl-artifact ids must be plain graph and artifact ids')
  }
  return `${ARTIFACT_SCHEME}${encodeURIComponent(ref.graphId)}/${encodeURIComponent(ref.artifactId)}`
}

/** The stored image a src names, or null when it names none. */
export function storedImageRef(src: string): StoredImageRef | null {
  const value = typeof src === 'string' ? src.trim() : ''
  if (value.startsWith(ARTIFACT_SCHEME)) {
    const ref = parseMyclArtifactSrc(value)
    return ref ? { source: 'artifact', graphId: ref.graphId, id: ref.artifactId } : null
  }
  const upload = parseUploadedImageSrc(value)
  return upload ? { source: 'upload', graphId: upload.graphId, id: upload.imageId } : null
}

export function classifyImageSrc(src: string | null | undefined): ImageSrcClass {
  const value = typeof src === 'string' ? src.trim() : ''
  if (value === '') return { kind: 'blocked', reason: 'unsupported' }
  // A vault image the import did not bring in (remote, unsupported, or not
  // captured): the importer keeps the original src percent-encoded after this
  // scheme. It is never loaded.
  if (value.startsWith('mycl-unresolved-image:')) return { kind: 'blocked', reason: 'not-imported' }
  if (value.startsWith(ARTIFACT_SCHEME)) {
    const ref = storedImageRef(value)
    return ref ? { kind: 'resolve', ref } : { kind: 'blocked', reason: 'unsupported' }
  }
  if (DATA_IMAGE_RE.test(value)) return { kind: 'direct' }
  if (value.startsWith('blob:')) return { kind: 'direct' }
  const upload = storedImageRef(value)
  if (upload) return { kind: 'resolve', ref: upload }
  if (/^https?:\/\//i.test(value) || value.startsWith('//')) return { kind: 'blocked', reason: 'web' }
  return { kind: 'blocked', reason: 'unsupported' }
}

/** A host-resolved image: an object URL the node view must revoke when done. */
export interface ResolvedImage {
  readonly url: string
  revoke(): void
}

/**
 * Host resolver for stored images (see `resolve` above). It is called with the
 * src as persisted. Resolve to null, or throw, when the image can't be shown;
 * an Error's message becomes the placeholder reason.
 */
export type ImageResolver = (src: string) => Promise<ResolvedImage | null>
