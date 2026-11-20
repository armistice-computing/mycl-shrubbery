import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { kernelExtensions, setBlockControls, type BlockControlButton } from '../index'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy() })

function mount(onBlockControlAction?: (blockId: string, action: string) => void): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: kernelExtensions({ onBlockControlAction }) })
  editors.push(editor)
  editor.commands.setContent(
    '<blockquote><p data-block-id="quote-a">A valued sentence.</p></blockquote>'
    + '<p data-block-id="meta-a">Its source line.</p>',
  )
  return editor
}

const buttons = (active = false): BlockControlButton[] => [
  { action: 'importance', label: 'Important', iconSvg: '<svg></svg>', active },
  { action: 'valence', label: 'No valence', iconSvg: '<svg></svg>', disabled: true },
]

const rowFor = (editor: Editor, blockId: string): HTMLElement | null =>
  editor.view.dom.querySelector(`[data-block-controls-for="${blockId}"]`)

describe('BlockControls', () => {
  it('draws the buttons at the end of the chosen block only', () => {
    const editor = mount()
    setBlockControls(editor.view, new Map([['quote-a', buttons()]]))
    const row = rowFor(editor, 'quote-a')
    expect(row).not.toBeNull()
    expect(row?.closest('[data-block-id]')?.getAttribute('data-block-id')).toBe('quote-a')
    expect(row?.getAttribute('contenteditable')).toBe('false')
    expect(Array.from(row!.querySelectorAll('button')).map(b => b.dataset.action)).toEqual(['importance', 'valence'])
    expect(rowFor(editor, 'meta-a')).toBeNull()
  })

  it('reports a click with the block and action, and ignores a disabled button', () => {
    const clicks: string[] = []
    const editor = mount((blockId, action) => clicks.push(`${blockId}:${action}`))
    setBlockControls(editor.view, new Map([['quote-a', buttons()]]))
    const row = rowFor(editor, 'quote-a')!
    ;(row.querySelector('[data-action="importance"]') as HTMLButtonElement).click()
    ;(row.querySelector('[data-action="valence"]') as HTMLButtonElement).click()
    expect(clicks).toEqual(['quote-a:importance'])
  })

  it('redraws when a button changes and clears with an empty map', () => {
    const editor = mount()
    setBlockControls(editor.view, new Map([['quote-a', buttons(false)]]))
    expect(rowFor(editor, 'quote-a')?.querySelector('.block-controls-button--active')).toBeNull()
    setBlockControls(editor.view, new Map([['quote-a', buttons(true)]]))
    expect(rowFor(editor, 'quote-a')?.querySelector('.block-controls-button--active')).not.toBeNull()
    setBlockControls(editor.view, new Map())
    expect(rowFor(editor, 'quote-a')).toBeNull()
  })

  it('keeps the controls out of the document and its text', () => {
    const editor = mount()
    const before = JSON.stringify(editor.getJSON())
    setBlockControls(editor.view, new Map([['quote-a', buttons()]]))
    expect(JSON.stringify(editor.getJSON())).toBe(before)
    expect(editor.getText()).not.toContain('Important')
  })
})
