/**
 * What the person sees when something finishes or fails.
 *
 * The shell's `ok()`/`err()` write to a developer status line that the
 * desktop app hides, so a failure reported only there looks like a button
 * that does nothing (Friction Triage 2026-11-16, item 1). This module turns
 * the messages a person should see into toasts, and speaks each one once
 * into a single polite live region so a screen reader hears it too.
 *
 * Rules:
 *   - plain words: an `err()` message is "context error:\nreason"; the
 *     context maps to a sentence ("Couldn't import"), the reason keeps its
 *     first line, without stack frames or an "Error:" prefix;
 *   - background noise (reads that retry, "ignored" guards, render and
 *     boot diagnostics) stays on the status line only;
 *   - the same notice within `dedupeMs` is shown once;
 *   - at most `max` toasts at a time; a newer one retires the oldest;
 *   - a toast with a `key` replaces the visible toast with the same key
 *     (an import's "Importing 3 files…" becomes its result).
 */

export type NoticeKind = 'error' | 'success' | 'info'

export interface NoticeOptions {
  /** A later notice with the same key replaces this one in place. */
  readonly key?: string
  /** Milliseconds before it leaves; 0 keeps it until replaced or closed. */
  readonly duration?: number
  readonly description?: string
}

export interface Notifier {
  error(message: string, options?: NoticeOptions): void
  success(message: string, options?: NoticeOptions): void
  info(message: string, options?: NoticeOptions): void
  /** Speak into the live region without a toast. */
  announce(message: string): void
  /** Remove the toast that carries `key`, if any. */
  clear(key: string): void
}

export interface PlainNotice {
  readonly message: string
  readonly description: string
}

/**
 * Status-line messages that are diagnostics, not news for the person:
 * background reads that retry on their own, guard rails that log an ignored
 * request, and boot/render traces.
 */
const BACKGROUND = [
  /\bignored\b/i,
  /\bread error\b/i,
  /^render error/i,
  /^parse error/i,
  /^Organism boot failed/i,
  /^live config store/i,
  /^Cognito/i,
  /^SourceMirror/i,
  /^native menu:/i,
  /^title bar:/i,
  /^resolution error/i,
  /^Zotero /,
]

/** The sentence a person reads, keyed by the status line's context. */
const CONTEXTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^document import error/i, "Couldn't import"],
  [/^imported \d+, failed \d+/i, 'Some files didn’t import'],
  [/^image upload error/i, "Couldn't add the image"],
  [/^quick clip error/i, "Couldn't clip that page"],
  [/^create workspace error/i, "Couldn't create the graph"],
  [/^delete workspace error/i, "Couldn't delete the graph"],
  [/^switch workspace error/i, "Couldn't open that graph"],
  [/^workspace catalog error/i, "Couldn't read your graphs"],
  [/^restore snapshot error/i, "Couldn't restore that version"],
  [/^save snapshot error/i, "Couldn't save the version"],
  [/^delete snapshot error/i, "Couldn't delete the version"],
  [/^bookmark snapshot error/i, "Couldn't bookmark the version"],
  [/^artifact restore error/i, "Couldn't restore the file"],
  [/^artifact download error/i, "Couldn't download the file"],
  [/^artifact import error/i, "Couldn't turn the file into a document"],
  [/^artifact revision save error/i, "Couldn't save the file"],
  [/^artifact image generation error/i, "Couldn't make the image"],
  [/^wire delete error/i, "Couldn't delete the wire"],
  [/^wire refresh(-all)? error/i, "Couldn't refresh the wire"],
  [/^pinned wire update error/i, "Couldn't update the wire"],
  [/^pinned block refresh error/i, "Couldn't refresh the pinned block"],
  [/^salience rate error/i, "Couldn't save the value"],
  [/^salience renew error/i, "Couldn't renew the value"],
  [/^daily-note open error/i, "Couldn't open today's note"],
  [/^daily note date must be/i, "That isn't a date Mycl can open"],
  [/^parked work export error/i, "Couldn't export"],
  [/^keyboard command error/i, "That command didn't work"],
  [/^Excalidraw scene failed/i, "Couldn't open the drawing"],
  [/^file operation/i, "Couldn't finish that"],
]

function cleanReason(text: string): string {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^at\s/.test(line) && !/^\w*Error:?\s*$/.test(line))
  const first = (lines[0] ?? '').replace(/^(\w*Error|Error):\s*/, '')
  return first.length > 180 ? `${first.slice(0, 177)}…` : first
}

/**
 * The plain-words form of a status-line error, or null when the message is
 * a diagnostic the person doesn't need.
 */
export function plainErrorNotice(raw: string): PlainNotice | null {
  const text = raw.trim()
  if (!text) return null
  if (BACKGROUND.some(pattern => pattern.test(text))) return null
  const split = text.indexOf(':\n')
  const context = split >= 0 ? text.slice(0, split) : text
  const reason = split >= 0 ? cleanReason(text.slice(split + 2)) : ''
  const match = CONTEXTS.find(([pattern]) => pattern.test(context))
  if (match) return { message: match[1], description: reason }
  // Unknown contexts still reach the person, said neutrally: the context is
  // developer wording, so it stays out of the headline.
  return { message: "Something didn't work", description: reason || cleanReason(context) }
}

type ToastElement = HTMLElement & {
  type: string
  position: string
  message: string
  description: string
  duration: number
  announce: boolean
  dismiss(): void
}

interface Live {
  readonly element: ToastElement
  readonly key: string | null
}

export interface NotifierOptions {
  readonly now?: () => number
  readonly max?: number
  readonly dedupeMs?: number
}

const ANNOUNCER_ID = 'mn-announcer'

function announcer(doc: Document): HTMLElement {
  let region = doc.getElementById(ANNOUNCER_ID)
  if (!region) {
    region = doc.createElement('div')
    region.id = ANNOUNCER_ID
    region.setAttribute('aria-live', 'polite')
    region.setAttribute('aria-atomic', 'true')
    // Visually hidden, still in the accessibility tree.
    region.setAttribute(
      'style',
      'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;',
    )
    doc.body.appendChild(region)
  }
  return region
}

export function createNotifier(doc: Document, options: NotifierOptions = {}): Notifier {
  const now = options.now ?? (() => Date.now())
  const max = Math.max(1, options.max ?? 3)
  const dedupeMs = options.dedupeMs ?? 8000
  const recent = new Map<string, number>()
  let live: Live[] = []

  function speak(text: string): void {
    const region = announcer(doc)
    // Set after insertion: a region that changes from empty to text is
    // announced; one created with its text already in it often is not.
    region.textContent = ''
    const view = doc.defaultView
    if (view) view.setTimeout(() => { region.textContent = text }, 50)
    else region.textContent = text
  }

  function restack(): void {
    let offset = 0
    for (const item of [...live].reverse()) {
      item.element.style.setProperty('--mn-toast-offset', `${offset}px`)
      const height = item.element.getBoundingClientRect().height
      offset += (height > 0 ? height : 56) + 8
    }
  }

  function remove(item: Live): void {
    live = live.filter(entry => entry !== item)
    if (item.element.isConnected) item.element.dismiss()
    restack()
  }

  function show(kind: NoticeKind, message: string, opts: NoticeOptions = {}): void {
    const description = opts.description ?? ''
    const signature = `${kind}\u0000${message}\u0000${description}`
    const at = now()
    const seen = recent.get(signature)
    if (opts.key === undefined && seen !== undefined && at - seen < dedupeMs) return
    recent.set(signature, at)

    if (opts.key !== undefined) {
      const same = live.find(item => item.key === opts.key)
      if (same) remove(same)
    }
    while (live.length >= max) {
      const oldest = live[0]
      if (!oldest) break
      remove(oldest)
    }

    const toast = doc.createElement('mn-toast') as ToastElement
    toast.type = kind
    toast.position = 'bottom-center'
    toast.message = message
    toast.description = description
    toast.duration = opts.duration ?? (kind === 'error' ? 8000 : 4000)
    // The live region speaks for every toast; the toast itself stays quiet
    // so a screen reader hears each notice once.
    toast.announce = false
    const item: Live = { element: toast, key: opts.key ?? null }
    toast.addEventListener('mn-dismiss', () => {
      if (live.includes(item)) {
        live = live.filter(entry => entry !== item)
        restack()
      }
    })
    live = [...live, item]
    doc.body.appendChild(toast)
    restack()
    speak(description ? `${message}. ${description}` : message)
  }

  return {
    error: (message, opts) => show('error', message, opts),
    success: (message, opts) => show('success', message, opts),
    info: (message, opts) => show('info', message, opts),
    announce: message => speak(message),
    clear: key => {
      const item = live.find(entry => entry.key === key)
      if (item) remove(item)
    },
  }
}
