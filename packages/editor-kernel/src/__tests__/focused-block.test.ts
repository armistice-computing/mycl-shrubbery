import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { kernelExtensions } from '../index'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy() })

function mount(): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: kernelExtensions({}) })
  editors.push(editor)
  editor.commands.setContent('<p data-block-id="block-a">A</p><p data-block-id="block-b">B</p>')
  return editor
}

const focused = (editor: Editor): string[] =>
  Array.from(editor.view.dom.querySelectorAll('[data-block-focused]'))
    .map(element => element.getAttribute('data-block-id') ?? '?')

describe('FocusedBlock', () => {
  it('marks exactly the block holding the selection, and follows it', () => {
    const editor = mount()
    editor.commands.setTextSelection(1)
    expect(focused(editor)).toEqual(['block-a'])
    editor.commands.setTextSelection(4)
    expect(focused(editor)).toEqual(['block-b'])
  })

  it('survives ProseMirror redrawing the block, because ProseMirror draws it', () => {
    // A host-written attribute is lost the moment the node is redrawn; the
    // reason this is a decoration. Typing replaces the text and redraws.
    const editor = mount()
    editor.commands.setTextSelection(2)
    editor.commands.insertContent('x')
    expect(focused(editor)).toEqual(['block-a'])
  })
})
