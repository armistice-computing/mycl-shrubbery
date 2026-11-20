import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import { createKernelEditor } from '../index'
import { wordEndAfter, wordLeftTarget, wordRightTarget, wordStartBefore } from '../extensions/modified-boundary'

const mounted: Array<ReturnType<typeof createKernelEditor>> = []
afterEach(() => {
  for (const editor of mounted.splice(0)) editor.destroy()
  document.body.innerHTML = ''
})

function mount(html: string): ReturnType<typeof createKernelEditor> {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = createKernelEditor(element, {})
  editor.commands.setContent(html)
  mounted.push(editor)
  return editor
}

function posIn(editor: ReturnType<typeof createKernelEditor>, text: string, chars: number): number {
  let target = -1
  editor.state.doc.descendants((node, pos) => {
    if (target === -1 && node.isTextblock && node.textContent === text) target = pos + 1 + chars
    return target === -1
  })
  expect(target).toBeGreaterThan(-1)
  return target
}

function caret(editor: ReturnType<typeof createKernelEditor>, pos: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
}

function press(editor: ReturnType<typeof createKernelEditor>, init: KeyboardEventInit): boolean {
  let handled = false
  editor.view.someProp('handleKeyDown', (fn) => {
    handled = fn(editor.view, new KeyboardEvent('keydown', init)) || handled
    return handled
  })
  return handled
}

function selectedText(editor: ReturnType<typeof createKernelEditor>): string {
  const { from, to } = editor.state.selection
  return editor.state.doc.textBetween(from, to, '|')
}

describe('word moves (macOS rule)', () => {
  it('finds word starts and ends, skipping spaces', () => {
    expect(wordStartBefore('hello world', 11)).toBe(6)
    expect(wordStartBefore('hello world  ', 13)).toBe(6)
    expect(wordStartBefore('hello', 5)).toBe(0)
    expect(wordEndAfter('hello world', 0)).toBe(5)
    expect(wordEndAfter('  hello', 0)).toBe(7)
    // Punctuation is skipped, as macOS does when moving by word.
    expect(wordStartBefore('see paragraph.', 14)).toBe(4)
    expect(wordEndAfter('"quoted" rest', 0)).toBe(7)
  })

  it('Option-Left at a block start lands at the start of the previous block\'s last word', () => {
    const editor = mount('<p>alpha beta</p><p>gamma</p>')
    const start = posIn(editor, 'gamma', 0)
    expect(wordLeftTarget(editor.state, start)).toBe(posIn(editor, 'alpha beta', 6))
    expect(wordRightTarget(editor.state, posIn(editor, 'alpha beta', 10))).toBe(posIn(editor, 'gamma', 5))
  })
})

describe('modified keys at a block edge go through ProseMirror (Eschaton, 2026-11-17)', () => {
  it('Shift-Left at a block start extends the selection into the block above', () => {
    const editor = mount('<p>alpha</p><p>beta</p>')
    caret(editor, posIn(editor, 'beta', 0))
    expect(press(editor, { key: 'ArrowLeft', shiftKey: true })).toBe(true)
    const { anchor, head } = editor.state.selection
    expect(anchor).toBe(posIn(editor, 'beta', 0))
    expect(head).toBe(posIn(editor, 'alpha', 5))
  })

  it('Shift-Right at a block end extends into the block below', () => {
    const editor = mount('<p>alpha</p><p>beta</p>')
    caret(editor, posIn(editor, 'alpha', 5))
    expect(press(editor, { key: 'ArrowRight', shiftKey: true })).toBe(true)
    expect(editor.state.selection.head).toBe(posIn(editor, 'beta', 0))
  })

  it('Option-Left at a block start moves into the previous block by word', () => {
    const editor = mount('<p>alpha beta</p><p>gamma</p>')
    caret(editor, posIn(editor, 'gamma', 0))
    expect(press(editor, { key: 'ArrowLeft', altKey: true })).toBe(true)
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.head).toBe(posIn(editor, 'alpha beta', 6))
  })

  it('Option-Shift-Left extends by word, across the edge', () => {
    const editor = mount('<p>alpha beta</p><p>gamma</p>')
    caret(editor, posIn(editor, 'gamma', 5))
    press(editor, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(selectedText(editor)).toBe('gamma')
    press(editor, { key: 'ArrowLeft', altKey: true, shiftKey: true })
    expect(selectedText(editor)).toBe('beta|gamma')
  })

  it('Command-Backspace deletes back to the line start, and joins at a block start', () => {
    const editor = mount('<p>alpha</p><p>beta gamma</p>')
    caret(editor, posIn(editor, 'beta gamma', 10))
    expect(press(editor, { key: 'Backspace', metaKey: true })).toBe(true)
    expect(editor.getText({ blockSeparator: '|' })).toBe('alpha|')
  })

  it('leaves plain and unrelated keys to the existing handlers', () => {
    const editor = mount('<p>alpha</p><p>beta</p>')
    caret(editor, posIn(editor, 'beta', 2))
    expect(press(editor, { key: 'ArrowLeft', shiftKey: true })).toBe(false)
    expect(press(editor, { key: 'ArrowUp', metaKey: true })).toBe(false)
  })
})
