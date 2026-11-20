/**
 * modified-boundary.ts — Shift, Option and Command keys at a block's edge.
 *
 * The same `contenteditable=false` widget that traps WebKit's plain arrows
 * (caret-boundary.ts) and its Option-Backspace (word-delete.ts) traps the
 * modified keys too. Eschaton, 2026-11-17: Shift-Left and Option-Left at a
 * block's start do not reach into the block above. WebKit's own selection
 * extension and word search stop at the widget; the packaged app is WKWebView.
 *
 * So ProseMirror does these moves itself, following macOS:
 *   - Shift-Left / Shift-Right / Shift-Up / Shift-Down at a block edge extend
 *     the selection into the neighbouring block.
 *   - Option-Left / Option-Right move by word, crossing block edges: Option-Left
 *     at a block's start lands at the start of the previous block's last word.
 *     Option-Shift extends by word.
 *   - Command-Backspace deletes back to the start of the line; at a block's
 *     start it acts as Backspace (joins with the block before).
 *     Option-Delete (forward) at a block's end acts as Delete (joins with the next).
 * Everything else stays with the browser.
 */
import type { EditorState } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

const ATOM = '￼'
const WORD = /[\p{L}\p{N}\p{M}_'’]/u

export interface ModifiedKey {
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly isComposing?: boolean
}

function blockText(state: EditorState, start: number, end: number): string | null {
  const text = state.doc.textBetween(start, end, undefined, ATOM)
  return text.length === end - start ? text : null
}

/**
 * Offset (within the text) where Option-Left from `i` lands, macOS-style:
 * skip spaces and punctuation, then the word before them. An inline atom
 * (a link chip) is a word of its own. ("see paragraph." from the end lands
 * before "paragraph".)
 */
export function wordStartBefore(text: string, i: number): number {
  while (i > 0 && !WORD.test(text[i - 1]!) && text[i - 1] !== ATOM) i -= 1
  if (i === 0) return 0
  if (text[i - 1] === ATOM) return i - 1
  while (i > 0 && WORD.test(text[i - 1]!)) i -= 1
  return i
}

/** Offset where Option-Right from `i` lands: skip spaces and punctuation, then the word. */
export function wordEndAfter(text: string, i: number): number {
  const n = text.length
  while (i < n && !WORD.test(text[i]!) && text[i] !== ATOM) i += 1
  if (i === n) return n
  if (text[i] === ATOM) return i + 1
  while (i < n && WORD.test(text[i]!)) i += 1
  return i
}

/** The textblock edge before or after `pos` (a block boundary), or null. */
function neighbour(state: EditorState, pos: number, dir: -1 | 1): TextSelection | null {
  const found = TextSelection.findFrom(state.doc.resolve(pos), dir, true)
  return found instanceof TextSelection ? found : null
}

/** Where Option-Left from `head` lands, crossing into earlier blocks when needed. */
export function wordLeftTarget(state: EditorState, head: number): number | null {
  let $pos = state.doc.resolve(head)
  if (!$pos.parent.isTextblock) return null
  // At a block's start (or with only spaces before), the move continues in the block above.
  for (let guard = 0; guard < 1000; guard += 1) {
    const start = $pos.start()
    const text = blockText(state, start, $pos.pos)
    if (text === null) return null
    const landed = wordStartBefore(text, text.length)
    if (landed < text.length) return start + landed
    if (text.length > 0 && landed === 0) return start
    const previous = neighbour(state, $pos.before(), -1)
    if (!previous) return null
    $pos = previous.$from
  }
  return null
}

/** Where Option-Right from `head` lands, crossing into later blocks when needed. */
export function wordRightTarget(state: EditorState, head: number): number | null {
  let $pos = state.doc.resolve(head)
  if (!$pos.parent.isTextblock) return null
  for (let guard = 0; guard < 1000; guard += 1) {
    const end = $pos.end()
    const text = blockText(state, $pos.pos, end)
    if (text === null) return null
    const landed = wordEndAfter(text, 0)
    if (landed > 0) return $pos.pos + landed
    const next = neighbour(state, $pos.after(), 1)
    if (!next) return null
    $pos = next.$from
  }
  return null
}

function select(view: EditorView, anchor: number, head: number): true {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)).scrollIntoView())
  return true
}

/** Re-run the editor's own handling for a plain key (Backspace or Delete). */
function asPlainKey(view: EditorView, key: 'Backspace' | 'Delete'): boolean {
  const plain = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  return Boolean(view.someProp('handleKeyDown', handler => handler(view, plain)))
}

/**
 * Handle a modified key at a block edge, or return false to leave it to the
 * browser. `vertical` gives the landing spot for Shift-Up/Down (caret-column aware).
 */
export function modifiedBoundary(
  view: EditorView,
  event: ModifiedKey,
  vertical: (direction: 'up' | 'down') => TextSelection | null,
): boolean {
  if (event.isComposing || event.ctrlKey) return false
  const { state } = view
  const { selection } = state
  if (!(selection instanceof TextSelection)) return false
  const $head = selection.$head
  if (!$head.parent.isTextblock) return false
  const atStart = $head.parentOffset === 0
  const atEnd = $head.parentOffset === $head.parent.content.size
  const { anchor, head } = selection

  // Command-Backspace and Option-Delete.
  if (event.key === 'Backspace' && event.metaKey && !event.altKey && !event.shiftKey) {
    if (!selection.empty) return false
    if (atStart) return asPlainKey(view, 'Backspace')
    // Delete back to the line's start when that start is the block's start
    // (the only line the widget sits on); other lines stay with the browser.
    try {
      const startCoords = view.coordsAtPos($head.start())
      const here = view.coordsAtPos(head)
      if (Math.abs(startCoords.top - here.top) > 2) return false
    } catch {
      // Unmeasured editor: the first line is the only safe assumption.
    }
    view.dispatch(state.tr.delete($head.start(), head).scrollIntoView())
    return true
  }
  if (event.key === 'Delete' && event.altKey && !event.metaKey && !event.shiftKey) {
    if (!selection.empty || !atEnd) return false
    return asPlainKey(view, 'Delete')
  }

  if (event.metaKey) return false

  // Option (with or without Shift): word moves, always through ProseMirror.
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const target = event.key === 'ArrowLeft' ? wordLeftTarget(state, head) : wordRightTarget(state, head)
    if (target === null) return false
    return select(view, event.shiftKey ? anchor : target, target)
  }

  // Shift alone: extend across a block edge.
  if (!event.shiftKey || event.altKey) return false
  if (event.key === 'ArrowLeft' && atStart) {
    const previous = neighbour(state, $head.before(), -1)
    return previous ? select(view, anchor, previous.from) : false
  }
  if (event.key === 'ArrowRight' && atEnd) {
    const next = neighbour(state, $head.after(), 1)
    return next ? select(view, anchor, next.from) : false
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const direction = event.key === 'ArrowUp' ? 'up' : 'down'
    if (!view.endOfTextblock(direction)) return false
    const target = vertical(direction)
    return target ? select(view, anchor, target.from) : false
  }
  return false
}
