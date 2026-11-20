/**
 * block-dnd-table-target.test.ts — a table can be picked up.
 *
 * THE BUG. `blockAtEvent` resolved its starting element with
 * `closest('[data-block-id]')`. A table carries no block id — only its cells
 * do, and deliberately so ("the wire source is the cell, not the table",
 * block-id.ts) — so from a table's drag handle the chain is:
 *
 *     tbody < table < div.tableWrapper < div.tiptap        closest: NULL
 *
 * With a null hit, `dragstart` bails and `sourcePos` is never set, so the drag
 * never begins. The table cannot be moved.
 *
 * WHAT ACTUALLY GOES WRONG NEXT, corrected after review — the first version of
 * this file (and the comment in block-dnd.ts) claimed the null also stopped
 * `dragover` from calling `preventDefault()`, and that the browser therefore
 * refused to deliver `drop`. That is FALSE, and only running it shows why:
 * prosemirror-view merges its own `editHandlers.dragover` into the same
 * dispatch table, and that handler calls `preventDefault()` unconditionally
 * whenever no plugin handler claims the event. The drop was always delivered.
 * What actually happened is that OUR drop handler bailed on the null
 * `sourcePos`, so the event fell through to ProseMirror's generic slice-insert
 * instead of the outliner-aware `applyDrop` — a different failure, reached by a
 * different path, that happens to look the same from a chair.
 *
 * THIS TEST DRIVES THE REAL HANDLER. The first version did not: it
 * reimplemented the parent-walk inline and asserted against its own copy, so
 * reverting `blockAtEvent` to the exact pre-fix one-liner left all of it green.
 * A test that restates the implementation cannot fail when the implementation
 * does. So the events below are dispatched at the editor's own DOM and the
 * assertions read the plugin's state — the fix is exercised through the code
 * path a user's pointer actually takes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import { kernelExtensions } from '../index'
// The drag handle left the kernel roster on 2026-10-07 (move mode replaced
// it); these tests mount it explicitly to keep the module covered.
import { getOutlinerBlocks } from '../outliner-tree'
import { BlockDnd, blockAtEvent, blockDndKey } from '../extensions/block-dnd'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy() })

function mountWithTable(): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: [...kernelExtensions({}), BlockDnd] })
  editors.push(editor)
  editor.commands.setContent('<p>alpha</p><p>beta</p>')
  editor.commands.focus('end')
  editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
  return editor
}

/**
 * The drag handle, after the pointer moves over `block`. There is one handle,
 * beside the document (a sibling of the editor root), and it follows the
 * hovered top-level block.
 */
function handleOver(editor: Editor, block: Element): HTMLElement {
  block.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  const handle = (editor.view.dom as HTMLElement).parentElement?.querySelector('.block-drag-handle')
  expect(handle).not.toBeNull()
  expect(handle!.hasAttribute('data-visible')).toBe(true)
  return handle as HTMLElement
}

function tableDragHandle(editor: Editor): HTMLElement {
  return handleOver(editor, (editor.view.dom as HTMLElement).querySelector('.tableWrapper')!)
}

function paragraphDragHandle(editor: Editor): HTMLElement {
  return handleOver(editor, (editor.view.dom as HTMLElement).querySelector('p[data-block-id]')!)
}

/** A real dragstart, dispatched at a real element, through the real handler. */
function dragStartOn(target: HTMLElement): void {
  const event = new Event('dragstart', { bubbles: true, cancelable: true }) as DragEvent
  // A fuller stub than it looks like it needs: prosemirror-view's OWN dragstart
  // handler runs alongside the plugin's and reads `files.length`, `clearData`
  // and `setDragImage` off it (prosemirror-view/dist/index.js:3778-3785). A
  // thinner stub throws there, which reads as the plugin failing.
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files: [],
      items: [],
      types: [],
      effectAllowed: '',
      setData: () => undefined,
      getData: () => '',
      clearData: () => undefined,
      setDragImage: () => undefined,
    },
    configurable: true,
  })
  target.dispatchEvent(event)
}

const sourcePos = (editor: Editor): number | null =>
  blockDndKey.getState(editor.state)?.sourcePos ?? null

describe('a drop released over the editor ROOT still resolves', () => {
  // From a real failing drag, captured in the app:
  //
  //   dragover NO HIT  target=DIV  targetClass=tiptap ProseMirror ...
  //   drop ABANDONED   why=no block under the pointer at release
  //
  // The pointer was in the 4px gap between two blocks, so event.target was the
  // editor root. dragAnchorElement walks UP for a direct child of the root, and
  // when the target already IS the root that walk has nowhere to go. The
  // element path covers "inside a node with no id"; this covers "between
  // nodes", which is most of the vertical space a pointer crosses.
  //
  // Calls the REAL blockAtEvent rather than dispatching a full dragover: the
  // event route runs prosemirror-dropcursor too, which throws under happy-dom
  // for reasons unrelated to any of this. Exercising the shipped function is
  // the point; going through the browser's event plumbing is not.
  it('resolves a block from pointer coordinates when the target is the root itself', () => {
    const editor = mountWithTable()
    const root = editor.view.dom as HTMLElement
    const second = getOutlinerBlocks(editor.state.doc)[1]

    // posAtCoords is geometry and happy-dom reports every rect as zero, so it
    // answers the way a browser would for a point in the gap: the nearest
    // position inside the following block.
    const original = editor.view.posAtCoords.bind(editor.view)
    editor.view.posAtCoords = () => ({ pos: second.pos + 1, inside: second.pos })

    try {
      // The exact shape of the failing event: target IS the root.
      const hit = blockAtEvent(editor.view, { target: root, clientX: 400, clientY: 300 })
      expect(hit).not.toBeNull()
      expect(hit?.pos).toBe(second.pos)
    } finally {
      editor.view.posAtCoords = original
    }
  })

  it('still fails closed when the pointer is outside the document entirely', () => {
    // posAtCoords returns null off-document; a drag released there must resolve
    // nothing rather than guessing at the nearest block.
    const editor = mountWithTable()
    const original = editor.view.posAtCoords.bind(editor.view)
    editor.view.posAtCoords = () => null
    try {
      const hit = blockAtEvent(editor.view, {
        target: editor.view.dom as HTMLElement,
        clientX: -500,
        clientY: -500,
      })
      expect(hit).toBeNull()
    } finally {
      editor.view.posAtCoords = original
    }
  })

  it('an event with no coordinates resolves nothing rather than throwing', () => {
    const editor = mountWithTable()
    expect(blockAtEvent(editor.view, { target: editor.view.dom as HTMLElement })).toBeNull()
  })
})

describe('a drag that never became a drag does not strand the block', () => {
  // Captured in the app: picking a block up and nudging it in place produced a
  // dragstart with NO drop and NO dragend after it. sourcePos stayed set, the
  // source kept its `block-dragging` decoration, and nothing cleared it — the
  // "block stays greyed out" report. Both existing clearers (drop, dragend) are
  // events the browser skips for a gesture it abandons before it becomes a real
  // drag.
  it('mouseup clears state left behind by an abandoned dragstart', () => {
    const editor = mountWithTable()
    const paragraphHandle = paragraphDragHandle(editor)

    dragStartOn(paragraphHandle)
    expect(blockDndKey.getState(editor.state)?.sourcePos).not.toBeNull()

    // No drop, no dragend — just the release of a press that never travelled.
    paragraphHandle.dispatchEvent(new Event('mouseup', { bubbles: true, cancelable: true }))

    expect(blockDndKey.getState(editor.state)?.sourcePos ?? null).toBeNull()
  })

  it('the source block loses its dragging decoration once state is cleared', () => {
    // The decoration is what the user actually sees; asserting the state alone
    // would pass even if the class outlived it.
    const editor = mountWithTable()
    const paragraphHandle = paragraphDragHandle(editor)

    dragStartOn(paragraphHandle)
    expect((editor.view.dom as HTMLElement).querySelectorAll('.block-dragging').length).toBe(1)

    editor.view.dom.dispatchEvent(new Event('mouseup', { bubbles: true, cancelable: true }))
    expect((editor.view.dom as HTMLElement).querySelectorAll('.block-dragging').length).toBe(0)
  })

  it('mouseup with no drag in flight changes nothing', () => {
    // The net must not fire on ordinary clicks — it would be dispatching a
    // transaction on every mouseup in the document.
    const editor = mountWithTable()
    let transactions = 0
    editor.on('transaction', () => { transactions += 1 })
    editor.view.dom.dispatchEvent(new Event('mouseup', { bubbles: true, cancelable: true }))
    expect(transactions).toBe(0)
  })
})

describe('a table can be picked up by its drag handle', () => {
  it('the table has NO id-bearing ancestor — the condition that broke it', () => {
    // Guarding the premise. If tables ever start carrying a block id, the rest
    // of this file would silently stop testing anything, so the absence is
    // asserted rather than assumed.
    const editor = mountWithTable()
    expect((editor.view.dom as HTMLElement).querySelector('.tableWrapper')?.closest('[data-block-id]')).toBeNull()
    expect((editor.view.dom as HTMLElement).querySelector('table')?.closest('[data-block-id]')).toBeNull()
  })

  it('dragstart on the table handle sets sourcePos to the TABLE position', () => {
    const editor = mountWithTable()
    expect(sourcePos(editor)).toBeNull()

    dragStartOn(tableDragHandle(editor))

    const pos = sourcePos(editor)
    expect(pos).not.toBeNull()
    // It resolved to the table itself, not to a cell and not to a neighbour.
    expect(editor.state.doc.nodeAt(pos!)?.type.name).toBe('table')
    // And to a position the drop planner will accept — `applyDrop` refuses
    // anything `blockIndexAtPos` cannot find.
    expect(getOutlinerBlocks(editor.state.doc).some(block => block.pos === pos)).toBe(true)
  })

  it('dragstart on an ordinary paragraph still works — the fallback changed nothing there', () => {
    const editor = mountWithTable()
    dragStartOn(paragraphDragHandle(editor))

    const pos = sourcePos(editor)
    expect(pos).not.toBeNull()
    expect(editor.state.doc.nodeAt(pos!)?.type.name).toBe('paragraph')
  })

  it('the handle can start a drag from every top-level block', () => {
    // The general property. A handle the user can see and grab and get nothing
    // from is worse than no handle, and before the fix the table had exactly
    // one of those.
    const editor = mountWithTable()
    const blocks = Array.from((editor.view.dom as HTMLElement).children)
      .filter(child => !child.classList.contains('ProseMirror-gapcursor'))
    expect(blocks.length).toBeGreaterThan(1)

    const dead: string[] = []
    for (const block of blocks) {
      // Clear between attempts so each is measured on its own.
      editor.view.dispatch(editor.state.tr.setMeta(blockDndKey, { sourcePos: null, indicator: null }))
      dragStartOn(handleOver(editor, block))
      if (sourcePos(editor) === null) dead.push(block.tagName.toLowerCase())
    }
    expect(dead).toEqual([])
  })
})
