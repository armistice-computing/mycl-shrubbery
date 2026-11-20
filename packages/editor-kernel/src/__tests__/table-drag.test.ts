/**
 * table-drag.test.ts — a TABLE is a draggable outliner block. Nothing asserted
 * that until now.
 *
 * 'table' has been in OUTLINER_NODE_TYPES (outliner-tree.ts:27) all along, so
 * BlockDnd mints a drag handle for a top-level table and applyDrop will happily
 * be asked to move one. block-dnd.test.ts covers paragraphs, headings, list
 * items and code blocks — every registered type EXCEPT this one.
 *
 * That gap mattered the moment the editor's table CSS was written: the reveal
 * rules in editor-host.ts never named a table, so the handle existed at
 * opacity 0 and the affordance was unreachable. Before making it reachable, the
 * thing it triggers has to be known to work — a visible grip on a broken drop
 * is worse than an invisible grip on a working one.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import { kernelExtensions } from '../index'
// The drag handle left the kernel roster on 2026-10-07 (move mode replaced
// it); these tests mount it explicitly to keep the module covered.
import { getOutlinerBlocks } from '../outliner-tree'
import { BlockDnd, applyDrop } from '../extensions/block-dnd'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy() })

function mount(): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: [...kernelExtensions({}), BlockDnd] })
  editors.push(editor)
  editor.commands.setContent('<p>alpha</p><p>omega</p>')
  editor.commands.focus('end')
  editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
  return editor
}

const order = (editor: Editor): string[] =>
  Array.from({ length: editor.state.doc.childCount }, (_, i) => editor.state.doc.child(i).type.name)

describe('a table is a draggable block', () => {
  it('appears in the outliner and gets the drag handle like any other block', () => {
    const editor = mount()
    const names = getOutlinerBlocks(editor.state.doc).map(block => block.node.type.name)
    expect(names).toContain('table')
    // The one handle, beside the document, shows for the hovered table.
    const table = (editor.view.dom as HTMLElement).querySelector('.tableWrapper')!
    table.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    const handle = (editor.view.dom as HTMLElement).parentElement?.querySelector('.block-drag-handle')
    expect(handle?.hasAttribute('data-visible')).toBe(true)
  })

  it('moves to the top of the document and leaves the doc valid', () => {
    const editor = mount()
    const blocks = getOutlinerBlocks(editor.state.doc)
    const tableIndex = blocks.findIndex(block => block.node.type.name === 'table')
    expect(tableIndex).toBeGreaterThan(0)
    const childrenBefore = editor.state.doc.childCount

    const tr = applyDrop(editor.state, blocks[tableIndex].pos, blocks[0].pos, 'before')
    expect(tr).not.toBeNull()
    editor.view.dispatch(tr!)

    expect(order(editor)[0]).toBe('table')
    expect(editor.state.doc.childCount).toBe(childrenBefore)
    // ProseMirror's own structural audit — a malformed table would throw here
    // rather than merely looking wrong.
    expect(() => editor.state.doc.check()).not.toThrow()
  })
})
