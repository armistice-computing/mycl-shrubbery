import { afterEach, describe, expect, it } from 'vitest'
import '@shrubbery/components'
import type { MnCommentPopover } from '@shrubbery/components'
import { CommentPopoverLayer, type CommentPopoverData } from '../comment-popover-layer.js'

interface Harness {
  readonly layer: CommentPopoverLayer
  readonly comments: Map<string, CommentPopoverData>
  readonly calls: string[]
  panelOpen: boolean
}

const layers: CommentPopoverLayer[] = []
afterEach(() => { for (const layer of layers.splice(0)) layer.destroy() })

function harness(): Harness {
  const comments = new Map<string, CommentPopoverData>([
    ['c1', { id: 'c1', text: 'first', createdAt: 1, resolved: false, quotedText: 'alpha' }],
    ['c2', { id: 'c2', text: 'second', createdAt: 2, resolved: false }],
  ])
  const calls: string[] = []
  const h: Harness = {
    comments,
    calls,
    panelOpen: false,
    layer: null as unknown as CommentPopoverLayer,
  }
  const layer = new CommentPopoverLayer({
    doc: document,
    comment: id => comments.get(id) ?? null,
    isPanelOpen: () => h.panelOpen,
    onSave: (id, text) => {
      calls.push(`save:${id}:${text}`)
      const current = comments.get(id)
      if (current) comments.set(id, { ...current, text })
    },
    onResolve: id => calls.push(`resolve:${id}`),
    onDelete: id => {
      calls.push(`delete:${id}`)
      comments.delete(id)
    },
    onHighlight: id => calls.push(`highlight:${id}`),
    onSelectInPanel: id => calls.push(`panel-select:${id}`),
    onOpenPanel: id => calls.push(`panel-open:${id}`),
  })
  layers.push(layer)
  ;(h as { layer: CommentPopoverLayer }).layer = layer
  return h
}

const popovers = (): MnCommentPopover[] =>
  Array.from(document.querySelectorAll('[data-comment-popover-layer] mn-comment-popover'))

const at = { x: 40, y: 50 }

describe('CommentPopoverLayer', () => {
  it('peeks on hover and hides on leave', () => {
    const h = harness()
    h.layer.pointer({ commentId: 'c1', action: 'enter', anchor: at })
    expect(popovers().map(p => [p.commentId, p.mode])).toEqual([['c1', 'peek']])
    expect(h.calls).toContain('highlight:c1')
    h.layer.pointer({ commentId: 'c1', action: 'leave', anchor: at })
    expect(popovers()).toHaveLength(0)
  })

  it('pins on click, stacks pins with the newest on top, and closes with X', () => {
    const h = harness()
    h.layer.pointer({ commentId: 'c1', action: 'click', anchor: at })
    h.layer.pointer({ commentId: 'c2', action: 'click', anchor: { x: 90, y: 90 } })
    expect(popovers().map(p => [p.commentId, p.mode, p.zIndex])).toEqual([
      ['c1', 'pinned', 901],
      ['c2', 'pinned', 902],
    ])
    popovers()[0]!.dispatchEvent(new CustomEvent('mn-close'))
    expect(popovers().map(p => p.commentId)).toEqual(['c2'])
    expect(h.comments.has('c1')).toBe(true)
  })

  it('pins a new comment in edit mode, and saving it closes the popover', () => {
    const h = harness()
    h.comments.set('c3', { id: 'c3', text: '', createdAt: 3, resolved: false })
    h.layer.pinNew('c3', at)
    const popover = popovers()[0]!
    expect([popover.commentId, popover.mode, popover.editable, popover.startEditing]).toEqual(['c3', 'pinned', true, true])
    popover.dispatchEvent(new CustomEvent('mn-save', { detail: { commentId: 'c3', text: 'hello' } }))
    expect(h.calls).toContain('save:c3:hello')
    expect(popovers()).toHaveLength(0)
    expect(h.calls).not.toContain('delete:c3')
  })

  it('closes the top popover on Escape, and every popover on a press outside them', () => {
    const h = harness()
    h.layer.pointer({ commentId: 'c1', action: 'click', anchor: at })
    h.layer.pointer({ commentId: 'c2', action: 'click', anchor: at })
    expect(popovers().map(p => p.commentId)).toEqual(['c1', 'c2'])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(popovers().map(p => p.commentId)).toEqual(['c1'])
    // A press inside a popover keeps it.
    popovers()[0]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    expect(popovers()).toHaveLength(1)
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    expect(popovers()).toHaveLength(0)
  })

  it('closes on Escape before the editor sees it, keeps a blank new comment on a stray click, and lets a mark press through', () => {
    const h = harness()
    h.layer.pointer({ commentId: 'c1', action: 'click', anchor: at })
    // The editor's own Escape handler: the layer must close first and keep it.
    const editor = document.body.appendChild(document.createElement('div'))
    let editorSaw = false
    editor.addEventListener('keydown', () => { editorSaw = true })
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }))
    expect(popovers()).toHaveLength(0)
    expect(editorSaw).toBe(false)

    h.comments.set('c3', { id: 'c3', text: '', createdAt: 3, resolved: false })
    h.layer.pinNew('c3', at)
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    expect(popovers().map(p => p.commentId)).toEqual(['c3'])
    expect(h.calls).not.toContain('delete:c3')

    h.layer.pointer({ commentId: 'c1', action: 'click', anchor: at })
    const mark = editor.appendChild(document.createElement('span'))
    mark.setAttribute('data-comment-id', 'c1')
    mark.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    expect(popovers().map(p => p.commentId)).toEqual(['c3', 'c1'])
    editor.remove()
  })

  it('keeps a popover holding unsaved words open', async () => {
    const h = harness()
    h.layer.pointer({ commentId: 'c1', action: 'click', anchor: at })
    // The edit state is the component's own; the test sets it as typing would.
    const popover = popovers()[0]! as unknown as { editText: string; isEditing: boolean; dirty: boolean; updateComplete: Promise<boolean> }
    popover.isEditing = true
    popover.editText = 'not yet saved'
    await popover.updateComplete
    expect(popover.dirty).toBe(true)
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(popovers()).toHaveLength(1)
  })

  it('deletes a new comment that is closed without text', () => {
    const h = harness()
    h.comments.set('c3', { id: 'c3', text: '', createdAt: 3, resolved: false })
    h.layer.pinNew('c3', at)
    popovers()[0]!.dispatchEvent(new CustomEvent('mn-close'))
    expect(h.calls).toContain('delete:c3')
    expect(popovers()).toHaveLength(0)
  })

  it('leaves the panel in charge while it is open', () => {
    const h = harness()
    h.panelOpen = true
    h.layer.pointer({ commentId: 'c1', action: 'enter', anchor: at })
    expect(popovers()).toHaveLength(0)
    h.layer.pointer({ commentId: 'c1', action: 'click', anchor: at })
    expect(popovers()).toHaveLength(0)
    expect(h.calls).toContain('panel-select:c1')
  })

  it('double click clears every pin and opens the panel', () => {
    const h = harness()
    h.layer.pointer({ commentId: 'c1', action: 'click', anchor: at })
    h.layer.pointer({ commentId: 'c2', action: 'dblclick', anchor: at })
    expect(popovers()).toHaveLength(0)
    expect(h.calls).toContain('panel-open:c2')
  })

  it('drops the pin of a comment deleted elsewhere', () => {
    const h = harness()
    h.layer.pointer({ commentId: 'c1', action: 'click', anchor: at })
    h.comments.delete('c1')
    h.layer.refresh()
    expect(popovers()).toHaveLength(0)
  })
})
