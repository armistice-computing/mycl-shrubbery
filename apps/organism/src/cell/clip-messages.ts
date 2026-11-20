/**
 * What Quick Clip says when a clip fails or comes in with a caveat.
 *
 * The clip routes put a `kind` on every failure (gardend 9893eda); the words
 * are Beta's, from "Door 3 — clip and YouTube test, run 1 (2026-10-23)",
 * updated 15:05 for Gamma's two-tier floor. The person sees the sentence for
 * the kind, never the fetch library's text.
 */

export type ClipFailureKind =
  | 'invalid-url'
  | 'unreachable'
  | 'refused'
  | 'not-html'
  | 'too-large'
  | 'empty'
  | 'no-transcript'
  | 'video'
  | 'internal'

const FAILURE_SENTENCES: Readonly<Record<ClipFailureKind, string>> = {
  'invalid-url': "That doesn't look like a web address. Try a link that starts with https://.",
  unreachable: "Couldn't reach that site. Check the link or your connection and try again.",
  refused: 'This site refused to share the page, often because of a paywall or sign-in. Save the page as HTML from your browser and drop the file in.',
  'not-html': 'That link is a file, not a page. Download it and drop it in.',
  'too-large': 'That page is too large to clip. Save it as HTML and drop it in.',
  empty: 'Almost no text came back from this page. If it needs a sign-in or a cookie choice, open it in your browser, save it as HTML, and drop the file in.',
  'no-transcript': 'This video has no transcript we can read.',
  video: "Videos can't be clipped yet: only articles and pages.",
  internal: 'Something went wrong on our side. Please tell us what you clipped.',
}

/**
 * gardend refuses a loopback or private-network address with this exact
 * sentence in `errors` (clip_failure.rs CLIP_PRIVATE_HOST_MESSAGE). The general
 * `refused` sentence (paywall, sign-in) is wrong for it.
 */
const PRIVATE_HOST_SENTENCE = "This address can't be clipped from here."

const PDF_SENTENCE = 'That link is a PDF. Download it and drop it in to read and annotate it.'

/** No kind, or one we don't know: neutral, not blame (Beta, Quick Clip pass 1). */
const UNKNOWN_SENTENCE = "That page couldn't be clipped."

/** Shown under "Clipped" when the route's warnings say the page came in thin. */
export const CLIP_THIN_NOTICE = "Clipped, but only a little text came through. If that's not the whole page, it may be behind a sign-in. Save it from your browser and drop it in."

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isKind(value: unknown): value is ClipFailureKind {
  return typeof value === 'string' && value in FAILURE_SENTENCES
}

/**
 * The sentence for a failed clip. Reads `kind` (or `failureKind`) from the
 * error's route payload. "On our side" is only for an explicit `internal`;
 * a missing or unknown kind (an older backend) gets a neutral line.
 */
export function clipFailureMessage(error: unknown): string {
  const payload = record(record(error)?.payload)
  const kind = isKind(payload?.kind) ? payload.kind : isKind(payload?.failureKind) ? payload.failureKind : null
  if (kind === null) return UNKNOWN_SENTENCE
  if (kind === 'refused') {
    const errors = Array.isArray(payload?.errors) ? payload.errors : []
    if (errors.includes(PRIVATE_HOST_SENTENCE)) return PRIVATE_HOST_SENTENCE
  }
  if (kind === 'not-html') {
    const contentType = typeof payload?.contentType === 'string' ? payload.contentType.toLowerCase() : ''
    if (contentType.includes('pdf')) return PDF_SENTENCE
  }
  return FAILURE_SENTENCES[kind]
}

/** The caveat for a clip that made a document but came in thin, else ''. */
export function clipNotice(warnings: readonly string[]): string {
  return warnings.some(warning => /came in thin/i.test(warning)) ? CLIP_THIN_NOTICE : ''
}
