import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { commentMarkRanges, kernelExtensions, setActiveCommentId } from '../index'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy() })

function mount(): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: kernelExtensions({}) })
  editors.push(editor)
  editor.commands.setContent(
    '<p data-block-id="block-a"><span data-comment-id="c1">alpha <strong>bold</strong></span> gap '
    + '<span data-comment-id="c2">beta</span></p>',
  )
  return editor
}

const activeText = (editor: Editor): string[] =>
  Array.from(editor.view.dom.querySelectorAll('.comment-active')).map(element => element.textContent ?? '')

describe('CommentActive', () => {
  it('finds every run of one comment as one merged range', () => {
    const editor = mount()
    const ranges = commentMarkRanges(editor.state, 'c1')
    expect(ranges).toHaveLength(1)
    expect(editor.state.doc.textBetween(ranges[0]!.from, ranges[0]!.to)).toBe('alpha bold')
  })

  it('paints only the active comment, inside its marks, and clears', () => {
    const editor = mount()
    expect(setActiveCommentId(editor.view, 'c1')).toBe(true)
    expect(activeText(editor).join('')).toBe('alpha bold')
    for (const element of Array.from(editor.view.dom.querySelectorAll('.comment-active'))) {
      expect(element.closest('.comment-mark')?.getAttribute('data-comment-id')).toBe('c1')
    }
    expect(editor.view.dom.querySelector('.comment-mark[data-active]')).toBeNull()
    setActiveCommentId(editor.view, 'c2')
    expect(activeText(editor)).toEqual(['beta'])
    setActiveCommentId(editor.view, null)
    expect(activeText(editor)).toEqual([])
  })

  it('survives ProseMirror redrawing the text, because ProseMirror draws it', () => {
    const editor = mount()
    setActiveCommentId(editor.view, 'c2')
    editor.commands.setTextSelection(2)
    editor.commands.insertContent('x')
    expect(activeText(editor)).toEqual(['beta'])
  })

  it('does not change the document', () => {
    const editor = mount()
    const before = JSON.stringify(editor.getJSON())
    setActiveCommentId(editor.view, 'c1')
    expect(JSON.stringify(editor.getJSON())).toBe(before)
  })
})
