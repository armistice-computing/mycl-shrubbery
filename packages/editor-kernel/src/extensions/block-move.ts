/**
 * Block move mode: a locked state for moving one block and its children.
 *
 * The bubble menu's "Move block" starts it (Eschaton, 2026-10-07). It
 * replaces the drag handle, which was an eyesore for a niche case. While the
 * mode is on:
 *
 *   ↑ / ↓              move the block with its subtree past the sibling subtree
 *   Tab / → , ⇧Tab / ←  indent and outdent, children following
 *   drag the block     the same moves, following the pointer
 *   Enter              keep the new place
 *   Escape             put the block back where it started
 *   click elsewhere    keep the new place
 *
 * Every other key and all text input are swallowed, so the text cannot change
 * while the block is lifted. Command-key shortcuts pass through (undo works).
 *
 * The moves reuse the outliner's own commands (moveBlockUp/Down,
 * increase/decreaseIndent), which act on a collapsed selection inside the
 * block, so the mode keeps the caret there.
 *
 * Escape does not replay undo: in a shared document, undo steps can group
 * with nearby edits. It restores by place instead: the original indent, then
 * the same block before it in document order (or the top of the document).
 */

import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  blockIdOf,
  blockIndexById,
  getIndent,
  getOutlinerBlocks,
  planMoveDown,
  planMoveUp,
} from '../outliner-tree'

export interface BlockMoveState {
  readonly blockId: string
  /** The block before it in document order when the move began, or null at the top. */
  readonly originPrevId: string | null
  readonly originIndent: number
}

export interface BlockMoveStorage {
  start: (blockId: string) => boolean
  finish: () => boolean
  cancel: () => boolean
}

export const blockMoveKey = new PluginKey<BlockMoveState | null>('blockMove')

type MoveMeta = { readonly start: BlockMoveState } | { readonly end: true }

export function activeBlockMove(state: EditorState): BlockMoveState | null {
  return blockMoveKey.getState(state) ?? null
}

/** Position just inside the block, where the outliner commands look for it. */
function caretPosInBlock(state: EditorState, blockId: string): number | null {
  const blocks = getOutlinerBlocks(state.doc)
  const index = blockIndexById(blocks, blockId)
  if (index === -1) return null
  const block = blocks[index]
  let pos: number | null = null
  state.doc.nodesBetween(block.pos, block.end, (node, at) => {
    if (pos !== null) return false
    if (node.isTextblock) {
      pos = at + 1
      return false
    }
    return true
  })
  return pos ?? block.pos + 1
}

function placeCaret(editor: Editor, blockId: string): boolean {
  const pos = caretPosInBlock(editor.state, blockId)
  if (pos === null) return false
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
  return true
}

function previousBlockId(state: EditorState, blockId: string): string | null | undefined {
  const blocks = getOutlinerBlocks(state.doc)
  const index = blockIndexById(blocks, blockId)
  if (index === -1) return undefined
  return index === 0 ? null : blockIdOf(blocks[index - 1].node)
}

/** One outliner step on the moving block. The caret is put back first in case it wandered. */
function step(editor: Editor, blockId: string, run: (editor: Editor) => boolean): boolean {
  if (!placeCaret(editor, blockId)) return false
  return run(editor)
}

/**
 * Put the block back: indent first, then step it up or down until the block
 * before it is the one that was there. Stops when a step makes no progress.
 */
function restore(editor: Editor, move: BlockMoveState): void {
  const { blockId } = move
  for (let guard = 0; guard < 64; guard++) {
    const blocks = getOutlinerBlocks(editor.state.doc)
    const index = blockIndexById(blocks, blockId)
    if (index === -1) return
    const indent = getIndent(blocks[index].node)
    if (indent === move.originIndent) break
    const moved = step(editor, blockId, (e) =>
      indent < move.originIndent ? e.commands.increaseIndent() : e.commands.decreaseIndent(),
    )
    if (!moved) break
  }
  const limit = getOutlinerBlocks(editor.state.doc).length * 2
  for (let guard = 0; guard < limit; guard++) {
    const prev = previousBlockId(editor.state, blockId)
    if (prev === undefined || prev === move.originPrevId) return
    const blocks = getOutlinerBlocks(editor.state.doc)
    const index = blockIndexById(blocks, blockId)
    const target = move.originPrevId === null ? -1 : blockIndexById(blocks, move.originPrevId)
    const up = target < index
    const moved = step(editor, blockId, (e) => (up ? e.commands.moveBlockUp() : e.commands.moveBlockDown()))
    if (!moved) return
  }
}

/** The DOM element of the root of the sibling subtree a move would swap with. */
function siblingElement(view: EditorView, blockId: string, direction: 'up' | 'down'): HTMLElement | null {
  const blocks = getOutlinerBlocks(view.state.doc)
  const index = blockIndexById(blocks, blockId)
  if (index === -1) return null
  const plan = direction === 'up' ? planMoveUp(blocks, index) : planMoveDown(blocks, index)
  if (!plan) return null
  const dom = view.nodeDOM(plan.target.from)
  return dom instanceof HTMLElement ? dom : null
}

function blockElement(view: EditorView, blockId: string): HTMLElement | null {
  const blocks = getOutlinerBlocks(view.state.doc)
  const index = blockIndexById(blocks, blockId)
  if (index === -1) return null
  const dom = view.nodeDOM(blocks[index].pos)
  return dom instanceof HTMLElement ? dom : null
}

function midpoint(element: HTMLElement): number {
  const rect = element.getBoundingClientRect()
  return rect.top + rect.height / 2
}

/*
 * Plain functions, not TipTap commands: a TipTap command dispatches the one
 * transaction it was handed, and restoring a place takes several outliner
 * steps, each its own transaction.
 */

/** Lift a block into move mode. False when the block is not found. */
export function startBlockMove(editor: Editor, blockId: string): boolean {
  const blocks = getOutlinerBlocks(editor.state.doc)
  const index = blockIndexById(blocks, blockId)
  if (index === -1) return false
  const start: BlockMoveState = {
    blockId,
    originPrevId: index === 0 ? null : blockIdOf(blocks[index - 1].node),
    originIndent: getIndent(blocks[index].node),
  }
  const pos = caretPosInBlock(editor.state, blockId)
  if (pos === null) return false
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, pos))
      .setMeta(blockMoveKey, { start } satisfies MoveMeta),
  )
  editor.view.focus()
  return true
}

/** Leave move mode where the block now is. */
export function finishBlockMove(editor: Editor): boolean {
  if (!activeBlockMove(editor.state)) return false
  editor.view.dispatch(editor.state.tr.setMeta(blockMoveKey, { end: true } satisfies MoveMeta))
  return true
}

/** Leave move mode and put the block back where it started. */
export function cancelBlockMove(editor: Editor): boolean {
  const move = activeBlockMove(editor.state)
  if (!move) return false
  restore(editor, move)
  editor.view.dispatch(editor.state.tr.setMeta(blockMoveKey, { end: true } satisfies MoveMeta))
  return true
}

export const BlockMove = Extension.create({
  name: 'blockMove',
  // Ahead of the outliner and block-selection keymaps, so Tab, the arrows,
  // Enter and Escape reach move mode first while it is on.
  priority: 1000,

  /**
   * The host reaches the mode through editor.storage.blockMove: it does not
   * import the kernel (the island guard in editor-host.ts).
   */
  addStorage(): BlockMoveStorage {
    return { start: () => false, finish: () => false, cancel: () => false }
  },


  addProseMirrorPlugins() {
    const editor = this.editor
    // Bound here rather than in onCreate, which TipTap fires a tick late.
    const storage = this.storage as BlockMoveStorage
    storage.start = (blockId) => startBlockMove(editor, blockId)
    storage.finish = () => finishBlockMove(editor)
    storage.cancel = () => cancelBlockMove(editor)
    let dragging = false

    const onPointerMove = (event: PointerEvent): void => {
      const move = activeBlockMove(editor.state)
      if (!dragging || !move) return
      event.preventDefault()
      const above = siblingElement(editor.view, move.blockId, 'up')
      if (above && event.clientY < midpoint(above)) {
        step(editor, move.blockId, (e) => e.commands.moveBlockUp())
        return
      }
      const below = siblingElement(editor.view, move.blockId, 'down')
      if (below && event.clientY > midpoint(below)) {
        step(editor, move.blockId, (e) => e.commands.moveBlockDown())
      }
    }
    const onPointerUp = (): void => {
      dragging = false
      const doc = editor.view.dom.ownerDocument
      doc.removeEventListener('pointermove', onPointerMove, true)
      doc.removeEventListener('pointerup', onPointerUp, true)
    }

    return [
      new Plugin<BlockMoveState | null>({
        key: blockMoveKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(blockMoveKey) as MoveMeta | undefined
            if (meta && 'start' in meta) return meta.start
            if (meta && 'end' in meta) return null
            return value
          },
        },
        props: {
          decorations(state) {
            const move = activeBlockMove(state)
            if (!move) return null
            const blocks = getOutlinerBlocks(state.doc)
            const index = blockIndexById(blocks, move.blockId)
            if (index === -1) return null
            const block = blocks[index]
            return DecorationSet.create(state.doc, [
              Decoration.node(block.pos, block.end, { class: 'block-moving', 'data-block-moving': 'true' }),
            ])
          },
          handleKeyDown(view, event) {
            const move = activeBlockMove(view.state)
            if (!move) return false
            if (event.metaKey || event.ctrlKey) return false
            const { blockId } = move
            switch (event.key) {
              case 'ArrowUp':
                step(editor, blockId, (e) => e.commands.moveBlockUp())
                break
              case 'ArrowDown':
                step(editor, blockId, (e) => e.commands.moveBlockDown())
                break
              case 'ArrowRight':
                step(editor, blockId, (e) => e.commands.increaseIndent())
                break
              case 'ArrowLeft':
                step(editor, blockId, (e) => e.commands.decreaseIndent())
                break
              case 'Tab':
                step(editor, blockId, (e) => (event.shiftKey ? e.commands.decreaseIndent() : e.commands.increaseIndent()))
                break
              case 'Enter':
                finishBlockMove(editor)
                break
              case 'Escape':
                cancelBlockMove(editor)
                break
              default:
                break
            }
            event.preventDefault()
            return true
          },
          handleTextInput: (view) => activeBlockMove(view.state) !== null,
          handlePaste: (view) => activeBlockMove(view.state) !== null,
          handleDrop: (view) => activeBlockMove(view.state) !== null,
          handleDOMEvents: {
            mousedown(view, event) {
              const move = activeBlockMove(view.state)
              if (!move) return false
              const lifted = blockElement(view, move.blockId)
              if (lifted && event.target instanceof Node && lifted.contains(event.target)) {
                event.preventDefault()
                dragging = true
                const doc = view.dom.ownerDocument
                doc.addEventListener('pointermove', onPointerMove, true)
                doc.addEventListener('pointerup', onPointerUp, true)
                return true
              }
              finishBlockMove(editor)
              return false
            },
            blur(view) {
              if (activeBlockMove(view.state) && !dragging) finishBlockMove(editor)
              return false
            },
          },
        },
        view: () => ({ destroy: onPointerUp }),
      }),
    ]
  },
})
