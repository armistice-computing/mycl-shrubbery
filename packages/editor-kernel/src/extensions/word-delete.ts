/**
 * word-delete.ts — Option-Backspace deletes the word before the caret through
 * ProseMirror instead of the browser.
 *
 * WHY. The same widget that traps WebKit's arrow keys (caret-boundary.ts): a
 * `contenteditable=false` element in front of a block's first character (the
 * value-marks row on every block while the gutter shows, the fold button,
 * margin glosses). Measured in WebKit on 2026-11-13: with the caret after the
 * FIRST word of a block, Option-Backspace deleted one character ("hello world"
 * became "hell world"); later words deleted whole. WebKit's word search
 * stops at the widget. Chromium is unaffected; the packaged app is WKWebView.
 *
 * The rule follows macOS: skip whitespace back from the caret, then delete one
 * run of word characters, or one run of punctuation. An inline atom (a
 * wikilink chip, a hard break) counts as a word of its own. At the very start
 * of a block this hands the key back, so the existing Backspace handling joins
 * with the block before, as plain Backspace does.
 */
import type { EditorState } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'

const ATOM = '￼'
const WORD = /[\p{L}\p{N}\p{M}_'’]/u
const SPACE = /\s/u

/** The [from, to) document range Option-Backspace deletes, or null to hand the key back. */
export function wordBackwardRange(state: EditorState): { from: number; to: number } | null {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return null
  const $pos = selection.$from
  if (!$pos.parent.isTextblock) return null
  const offset = $pos.parentOffset
  if (offset === 0) return null
  const start = $pos.start()
  // One character per position: text maps 1:1, and every inline leaf is one ATOM.
  const before = state.doc.textBetween(start, $pos.pos, undefined, ATOM)
  if (before.length !== offset) return null
  let i = before.length
  while (i > 0 && SPACE.test(before[i - 1]!)) i -= 1
  if (i > 0) {
    const ch = before[i - 1]!
    if (ch === ATOM) {
      i -= 1
    } else if (WORD.test(ch)) {
      while (i > 0 && WORD.test(before[i - 1]!)) i -= 1
    } else {
      while (i > 0 && !WORD.test(before[i - 1]!) && !SPACE.test(before[i - 1]!) && before[i - 1] !== ATOM) i -= 1
    }
  }
  return { from: start + i, to: $pos.pos }
}

export interface WordDeleteKey {
  readonly key: string
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly isComposing?: boolean
}

export function isWordBackspace(event: WordDeleteKey): boolean {
  return event.key === 'Backspace' && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.isComposing
}
