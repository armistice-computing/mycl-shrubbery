/**
 * Handing focus back to the page.
 *
 * Friction Triage 2026-11-16, item 8: after a document opened, after ⌘;,
 * after Settings closed, and after the picker, the drum, the pin or a dialog
 * closed, focus landed on <body>, so the next keystroke went nowhere. Two
 * pieces fix that without each transient learning about the editor:
 *
 *   - `focusWhenReady` focuses the active pane's editor once it has mounted
 *     (opening a document mounts its editor asynchronously);
 *   - `installFocusRescue` notices focus falling to <body> because the
 *     element that held it was removed or hidden (a transient closing), and
 *     returns focus to the active editor, which keeps its last selection.
 *     A click on empty space leaves its target in place, so it is not
 *     rescued.
 */

export interface FocusableEditor {
  focusEditor(): boolean
}

export interface FocusWhenReadyOptions {
  readonly doc?: Document
  /** Give up after this long; a document that never mounts takes nothing. */
  readonly timeoutMs?: number
  readonly requestFrame?: (callback: () => void) => number
  readonly now?: () => number
}

/** Elements a person may be typing into, outside the editor, that focus must not leave. */
function isTextEntry(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(element.type)
  }
  return element instanceof HTMLElement && element.isContentEditable
}

/** The innermost focused element, through shadow roots. */
export function deepActiveElement(doc: Document = document): Element | null {
  let active: Element | null = doc.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}

/**
 * Whether moving focus to the editor would take it from nothing the person
 * is using: <body>, a button or tree row, a removed element, or the sidebar.
 */
export function canTakeFocus(doc: Document = document): boolean {
  const active = deepActiveElement(doc)
  if (!active || active === doc.body || active === doc.documentElement) return true
  if (!active.isConnected) return true
  if (active.closest?.('sh-editor-host, [contenteditable="true"].ProseMirror')) return true
  const host = doc.activeElement
  if (host && /^MN-SIDEBAR-PANEL$/i.test(host.tagName)) return true
  return !isTextEntry(active)
}

/**
 * Focus the editor `getEditor` returns once it can take focus. Returns a
 * cancel function. Stops quietly if focus moves to a text field meanwhile.
 */
export function focusWhenReady(
  getEditor: () => FocusableEditor | null,
  options: FocusWhenReadyOptions = {},
): () => void {
  const doc = options.doc ?? document
  const view = doc.defaultView
  const raf = options.requestFrame ?? ((callback: () => void) => (view ? view.requestAnimationFrame(callback) : setTimeout(callback, 16) as unknown as number))
  const now = options.now ?? (() => Date.now())
  const deadline = now() + (options.timeoutMs ?? 4000)
  let cancelled = false
  const attempt = (): void => {
    if (cancelled) return
    if (!canTakeFocus(doc)) return
    if (getEditor()?.focusEditor()) return
    if (now() >= deadline) return
    raf(attempt)
  }
  attempt()
  return () => { cancelled = true }
}

export interface FocusRescueOptions {
  readonly doc?: Document
  /** The active pane's editor right now. */
  readonly getEditor: () => FocusableEditor | null
  /** True while something modal (the Settings overlay, a dialog) owns focus. */
  readonly isBlocked?: () => boolean
}

function isGone(element: Element): boolean {
  if (!element.isConnected) return true
  // A transient hidden in place (display: none, [hidden]) has no boxes.
  return element instanceof HTMLElement && element.getClientRects().length === 0
}

/**
 * Browsers move focus to <body> silently when the focused element is
 * removed or hidden (no blur, no focusout), so the rescue remembers the
 * last focused element and looks again whenever the page's light DOM
 * changes. Returns an uninstall function.
 */
export function installFocusRescue(options: FocusRescueOptions): () => void {
  const doc = options.doc ?? document
  const view = doc.defaultView
  let last: Element | null = null
  let scheduled = false

  const onFocusIn = (event: FocusEvent): void => {
    const origin = event.composedPath()[0]
    if (origin instanceof Element) last = origin
  }

  const check = (): void => {
    scheduled = false
    const active = doc.activeElement
    if (active && active !== doc.body) return
    const origin = last
    if (!origin) return
    // Never pull focus "back" to the editor from the editor itself.
    if (origin.closest('.ProseMirror')) return
    if (!isGone(origin)) return
    if (options.isBlocked?.()) return
    last = null
    options.getEditor()?.focusEditor()
  }

  const schedule = (): void => {
    if (scheduled) return
    if (doc.activeElement && doc.activeElement !== doc.body) return
    scheduled = true
    // After the transient has finished closing and run its own focus return.
    if (view) view.setTimeout(check, 0)
    else check()
  }

  doc.addEventListener('focusin', onFocusIn, true)
  // A focusout with nowhere to go is the cheap case (some engines do fire it).
  const onFocusOut = (event: FocusEvent): void => { if (!event.relatedTarget) schedule() }
  doc.addEventListener('focusout', onFocusOut, true)
  const MutationObserverCtor = view?.MutationObserver ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const observer = MutationObserverCtor ? new MutationObserverCtor(schedule) : null
  observer?.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'open', 'style', 'class'],
  })
  return () => {
    doc.removeEventListener('focusin', onFocusIn, true)
    doc.removeEventListener('focusout', onFocusOut, true)
    observer?.disconnect()
  }
}
