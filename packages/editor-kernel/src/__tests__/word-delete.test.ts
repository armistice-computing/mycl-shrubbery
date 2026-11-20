import { afterEach, describe, expect, it } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import { createKernelEditor } from '../index'
import { wordBackwardRange } from '../extensions/word-delete'

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

/** Put the caret after `chars` characters of the block whose text is `text`. */
function caretIn(editor: ReturnType<typeof createKernelEditor>, text: string, chars: number): void {
  let target = -1
  editor.state.doc.descendants((node, pos) => {
    if (target === -1 && node.isTextblock && node.textContent === text) target = pos + 1 + chars
    return target === -1
  })
  expect(target).toBeGreaterThan(-1)
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, target)))
}

function optionBackspace(editor: ReturnType<typeof createKernelEditor>): boolean {
  let handled = false
  editor.view.someProp('handleKeyDown', (fn) => {
    handled = fn(editor.view, new KeyboardEvent('keydown', { key: 'Backspace', altKey: true })) || handled
    return handled
  })
  return handled
}

function blocks(editor: ReturnType<typeof createKernelEditor>): string[] {
  const out: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.isTextblock) out.push(node.textContent)
    return true
  })
  return out
}

describe('Option-Backspace deletes the word before the caret', () => {
  it('deletes the first word of a block whole (WebKit deleted one character)', () => {
    const editor = mount('<p>before</p><p>hello world</p>')
    caretIn(editor, 'hello world', 5)
    expect(optionBackspace(editor)).toBe(true)
    expect(blocks(editor)).toEqual(['before', ' world'])
  })

  it('deletes a block that holds a single word, without joining blocks', () => {
    const editor = mount('<p>before</p><p>hello</p>')
    caretIn(editor, 'hello', 5)
    expect(optionBackspace(editor)).toBe(true)
    expect(blocks(editor)).toEqual(['before', ''])
  })

  it('skips spaces first, then deletes one word, as macOS does', () => {
    const editor = mount('<p>one two three</p>')
    caretIn(editor, 'one two three', 8)
    optionBackspace(editor)
    expect(blocks(editor)).toEqual(['one three'])
  })

  it('deletes a run of punctuation as one unit', () => {
    const editor = mount('<p>wait...</p>')
    caretIn(editor, 'wait...', 7)
    optionBackspace(editor)
    expect(blocks(editor)).toEqual(['wait'])
  })

  it('hands the key back at the start of a block, so it joins as Backspace does', () => {
    const editor = mount('<p>before</p><p>hello</p>')
    caretIn(editor, 'hello', 0)
    expect(wordBackwardRange(editor.state)).toBeNull()
  })
})
