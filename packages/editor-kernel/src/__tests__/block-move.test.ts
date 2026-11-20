/**
 * Block move mode: the bubble menu's "Move block" (Eschaton, 2026-10-07).
 *
 * Keys go through the plugin's real handleKeyDown, reached with
 * view.someProp, because happy-dom does not run ProseMirror's keymap from a
 * synthetic OS keydown.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createKernelEditor } from '../index'
import { activeBlockMove, startBlockMove } from '../extensions/block-move'
import { getIndent, getOutlinerBlocks, blockIdOf } from '../outliner-tree'

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
  document.body.innerHTML = ''
})

function mount(html: string): Editor {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createKernelEditor(el)
  editor.commands.setContent(html)
  editors.push(editor)
  return editor
}

function press(editor: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  return editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, event)) ?? false
}

function order(editor: Editor): string[] {
  return getOutlinerBlocks(editor.state.doc).map((block) => {
    const indent = getIndent(block.node)
    return `${'>'.repeat(indent)}${blockIdOf(block.node)}`
  })
}

const FOUR = '<p data-block-id="a">A</p><p data-block-id="b">B</p><p data-block-id="c">C</p><p data-block-id="d">D</p>'

describe('block move mode', () => {
  it('moves with the arrow keys and keeps the place on Enter', () => {
    const editor = mount(FOUR)
    expect(order(editor)).toEqual(['a', 'b', 'c', 'd'])
    expect(startBlockMove(editor, 'b')).toBe(true)
    expect(activeBlockMove(editor.state)?.blockId).toBe('b')
    press(editor, 'ArrowDown')
    press(editor, 'ArrowDown')
    expect(order(editor)).toEqual(['a', 'c', 'd', 'b'])
    press(editor, 'Enter')
    expect(activeBlockMove(editor.state)).toBeNull()
    expect(order(editor)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('puts the block back on Escape, indent included', () => {
    const editor = mount(FOUR)
    startBlockMove(editor, 'c')
    press(editor, 'ArrowUp')
    press(editor, 'Tab')
    expect(order(editor)).toEqual(['a', '>c', 'b', 'd'])
    press(editor, 'Escape')
    expect(activeBlockMove(editor.state)).toBeNull()
    expect(order(editor)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('indents with Tab and the right arrow, outdents with Shift-Tab and the left arrow', () => {
    const editor = mount(FOUR)
    startBlockMove(editor, 'b')
    press(editor, 'Tab')
    expect(order(editor)).toEqual(['a', '>b', 'c', 'd'])
    press(editor, 'ArrowLeft')
    expect(order(editor)).toEqual(['a', 'b', 'c', 'd'])
    press(editor, 'ArrowRight')
    expect(order(editor)).toEqual(['a', '>b', 'c', 'd'])
    press(editor, 'Tab', { shiftKey: true })
    expect(order(editor)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('swallows typing while lifted and lets command keys through', () => {
    const editor = mount(FOUR)
    startBlockMove(editor, 'a')
    expect(press(editor, 'x')).toBe(true)
    expect(press(editor, 'Backspace')).toBe(true)
    expect(press(editor, 'z', { metaKey: true })).toBe(false)
    const typed = editor.view.someProp('handleTextInput', (handle) => handle(editor.view, 1, 1, 'x', () => editor.state.tr))
    expect(typed).toBe(true)
    expect(editor.getText()).toContain('A')
    expect(editor.getText()).not.toContain('xA')
  })

  it('marks the lifted block for styling, and only while lifted', () => {
    const editor = mount(FOUR)
    startBlockMove(editor, 'b')
    expect(editor.view.dom.querySelector('[data-block-moving="true"]')?.getAttribute('data-block-id')).toBe('b')
    press(editor, 'Enter')
    expect(editor.view.dom.querySelector('[data-block-moving]')).toBeNull()
  })

  it('is reachable through editor.storage, the way the host calls it', () => {
    const editor = mount(FOUR)
    const storage = (editor.storage as unknown as Record<string, { start(id: string): boolean; cancel(): boolean }>).blockMove
    expect(storage.start('d')).toBe(true)
    press(editor, 'ArrowUp')
    expect(order(editor)).toEqual(['a', 'b', 'd', 'c'])
    expect(storage.cancel()).toBe(true)
    expect(order(editor)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does nothing when the mode is off, and refuses an unknown block', () => {
    const editor = mount(FOUR)
    expect(press(editor, 'ArrowDown')).toBe(false)
    expect(startBlockMove(editor, 'nope')).toBe(false)
    expect(activeBlockMove(editor.state)).toBeNull()
  })
})
