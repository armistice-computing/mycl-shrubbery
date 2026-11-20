/**
 * TipTap block drag/drop extension.
 *
 * Drag/drop validity and indent math are delegated to the pure outliner-tree
 * planner. This module owns the ProseMirror transaction and DOM event wiring.
 */

import { Extension } from '@tiptap/core'
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  MAX_INDENT,
  blockIndexAtPos,
  blockIndexById,
  getOutlinerBlocks,
  getSubtreeRange,
  planDrop,
  type OutlinerBlock,
  type DropMode,
} from '../outliner-tree'
import { getZoomedBlockId } from './outliner-zoom'
import { selectionMetaForClick, setSelectionMeta } from './block-selection'

const clampIndent = (value: number): number => Math.max(0, Math.min(MAX_INDENT, value))

/**
 * While subtree zoom is active, the focused root reads as the view header and
 * drag/drop targets are restricted to its visible descendants.
 */
export function isDropTargetAllowedUnderZoom(
  blocks: OutlinerBlock[],
  targetIndex: number,
  zoomedBlockId: string | null,
): boolean {
  if (!zoomedBlockId) return true
  const rootIndex = blockIndexById(blocks, zoomedBlockId)
  if (rootIndex === -1) return true

  const { startIndex, endIndex } = getSubtreeRange(blocks, rootIndex)
  return targetIndex > rootIndex && targetIndex >= startIndex && targetIndex <= endIndex
}

/**
 * Build the transaction that performs a block drop. The source subtree is
 * removed and reinserted relative to the target in one transaction, with block
 * IDs and node content preserved.
 */
export function applyDrop(
  state: EditorState,
  sourcePos: number,
  targetPos: number,
  mode: DropMode,
): Transaction | null {
  const blocks = getOutlinerBlocks(state.doc)
  const sourceIndex = blockIndexAtPos(blocks, sourcePos)
  const targetIndex = blockIndexAtPos(blocks, targetPos)
  if (sourceIndex === -1 || targetIndex === -1) {
    return null
  }

  if (!isDropTargetAllowedUnderZoom(blocks, targetIndex, getZoomedBlockId(state))) {
    return null
  }

  const plan = planDrop(blocks, sourceIndex, targetIndex, mode)
  if (!plan) {
    return null
  }

  const sliceContent = state.doc.slice(plan.source.from, plan.source.to).content
  const shifted: ProseMirrorNode[] = []

  sliceContent.forEach((node) => {
    const indent = clampIndent(((node.attrs.indent as number) || 0) + plan.indentDelta)
    shifted.push(
      node.type.create(
        {
          ...node.attrs,
          indent,
        },
        node.content,
        node.marks,
      ),
    )
  })

  const tr = state.tr
  tr.delete(plan.source.from, plan.source.to)

  const mappedTargetPos = tr.mapping.map(targetPos, 1)
  const after = getOutlinerBlocks(tr.doc)
  const mappedTargetIndex = blockIndexAtPos(after, mappedTargetPos)
  if (mappedTargetIndex === -1) {
    return null
  }

  const target = after[mappedTargetIndex]
  let insertPos: number

  if (plan.mode === 'before') {
    insertPos = target.pos
  } else {
    const targetIndent = target.indent
    insertPos = target.end
    for (let i = mappedTargetIndex + 1; i < after.length; i++) {
      if (after[i].indent <= targetIndent) break
      insertPos = after[i].end
    }
  }

  tr.insert(insertPos, Fragment.fromArray(shifted))
  return tr
}

interface DndState {
  sourcePos: number | null
  indicator: { pos: number; end: number; mode: DropMode } | null
}

const EMPTY_DND_STATE: DndState = { sourcePos: null, indicator: null }

export const blockDndKey = new PluginKey<DndState>('blockDnd')

/**
 * The element to resolve a document position from.
 *
 * NOT just closest([data-block-id]), and the difference is a real bug this
 * fixes. A TABLE carries no block id — only its cells do, deliberately ("the
 * wire source is the cell, not the table", block-id.ts) — so nothing in the
 * chain above a table's drag handle has one:
 *
 *     handle in : tbody < table < div.tableWrapper < div.tiptap
 *     closest   : NULL
 *
 * With a null hit, dragstart bails and sourcePos is never set, so the table
 * cannot be picked up at all. Verified through the real handler
 * (block-dnd-table-target.test.ts): buggy, sourcePos stays null; fixed, it is
 * the table's own position.
 *
 * A CORRECTION, because the first version of this comment was confidently
 * wrong and a wrong explanation is worse than none. It claimed the null also
 * stopped dragover from calling preventDefault(), and that the browser
 * therefore refused to deliver the drop. It does not: prosemirror-view merges
 * its own editHandlers.dragover into the same dispatch table, and that one
 * calls preventDefault() unconditionally whenever no plugin handler claims the
 * event (prosemirror-view/dist/index.js, initInput). The drop was always
 * delivered. What actually went wrong downstream is that OUR drop handler bails
 * on the null sourcePos, so the event falls through to ProseMirror's generic
 * slice-insert instead of the outliner-aware applyDrop — a different failure
 * reached by a different path, which happens to look identical from a chair.
 * Anyone optimising this later should know the browser was never the obstacle.
 *
 * The fallback is the nearest element that is a direct child of the editor
 * root: the top-level block wrapper whatever the node type — a paragraph, or a
 * .tableWrapper — which is exactly what .before(1) below resolves to a
 * top-level position. Nothing about the drop math changes; only the search for
 * a starting element stops assuming every block carries an id.
 *
 * WHEN THE FALLBACK FIRES is a coincidence between two lists that are
 * maintained separately, and worth knowing before adding a node type: `table`
 * is in OUTLINER_NODE_TYPES (outliner-tree.ts) but deliberately absent from
 * BASE_BLOCK_TYPES (block-id.ts). Every other block type appears in both and is
 * caught by the first branch. Add a draggable type to the first list without
 * the second and it will quietly start depending on this geometric path rather
 * than failing loudly as a missing id.
 *
 * One element genuinely does sit as a direct child of the root: ProseMirror's
 * gapcursor widget, which StarterKit leaves enabled on the document profile.
 * The walk can return it. That resolves safely rather than corrupting anything
 * — ResolvedPos.before special-cases a depth+1 resolve by returning the
 * position unchanged, which in this flat schema is the start of the following
 * block — and at the end of the document blockIndexAtPos returns -1 and the
 * drag fails closed exactly as it did before.
 */
function dragAnchorElement(view: EditorView, target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null
  const identified = el?.closest?.('[data-block-id]') as HTMLElement | null
  if (identified) return identified
  const root = view.dom as HTMLElement
  let node: HTMLElement | null = el
  while (node && node !== root) {
    if (node.parentElement === root) return node
    node = node.parentElement
  }
  return null
}

/**
 * Resolve a block from POINTER COORDINATES when there is no element to walk up
 * from — the case that was still losing drops after the table fix.
 *
 * Measured from a real failing drag: the last event before release was
 * `dragover NO HIT target=DIV targetClass=tiptap ProseMirror`, then
 * `drop ABANDONED`. The pointer was over the editor ROOT — the 4px gap between
 * blocks, or the page padding beside them — so `event.target` was
 * `.ProseMirror` itself. `dragAnchorElement` walks UP looking for a direct
 * child of the root, and when the target already IS the root that loop exits
 * immediately with nothing. The element path handles "inside a node with no
 * id"; it cannot handle "between nodes".
 *
 * That also explains the indicator appearing to lie: a NO HIT dragover returns
 * without clearing the indicator, so the green line kept promising the last
 * block it saw while the pointer sat in dead space, and the release then did
 * nothing. One cause, both complaints.
 *
 * `posAtCoords` is ProseMirror's own answer for a point that is not on any
 * particular node — it returns the nearest document position, which for a gap
 * is the boundary between the two blocks. Returns null outside the editor
 * entirely, so a drag released off the document still fails closed.
 */
function blockFromCoords(view: EditorView, clientX: number, clientY: number): number | null {
  const found = view.posAtCoords({ left: clientX, top: clientY })
  if (!found) return null
  try {
    return view.state.doc.resolve(found.pos).before(1)
  } catch {
    return null
  }
}

/**
 * EXPORTED for tests, deliberately. A previous version of the table test
 * reimplemented this function's element-walk inline and asserted against its
 * own copy — which meant reverting the real code to the original bug left the
 * test green. Exporting the real unit is the cheap way to make that mistake
 * impossible; a test that cannot reach the shipped function will reach for a
 * duplicate instead.
 */
export function blockAtEvent(
  view: EditorView,
  event: { target: EventTarget | null; clientX?: number; clientY?: number },
): { dom: HTMLElement; pos: number } | null {
  const el = dragAnchorElement(view, event.target)
  if (!el) {
    // No element to resolve from: fall back to the pointer's position.
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return null
    const blockPos = blockFromCoords(view, event.clientX, event.clientY)
    if (blockPos === null) return null
    const nodeDom = view.nodeDOM(blockPos)
    const blockDom =
      nodeDom instanceof HTMLElement
        ? nodeDom
        : nodeDom?.parentElement instanceof HTMLElement
          ? nodeDom.parentElement
          : null
    return blockDom ? { dom: blockDom, pos: blockPos } : null
  }

  try {
    const pos = view.posAtDOM(el, 0)
    const blockPos = view.state.doc.resolve(pos).before(1)
    const nodeDom = view.nodeDOM(blockPos)
    const blockDom =
      nodeDom instanceof HTMLElement
        ? nodeDom
        : nodeDom?.parentElement instanceof HTMLElement
          ? nodeDom.parentElement
          : el

    return { dom: blockDom, pos: blockPos }
  } catch {
    return null
  }
}

/**
 * Above the midpoint drops before the target, below it drops after. The whole
 * block is a target and there is no dead zone.
 *
 * It used to read three bands — before (top 25%), after (bottom 25%), and a
 * middle 50% that resolved to 'child' or 'after' by horizontal position against
 * a 28px threshold. That made nesting the default result of dragging onto a
 * block while reordering, the common case, lived in two 10-pixel strips on a
 * 40px paragraph. On a 217px table the middle band alone was 109 pixels.
 *
 * No `clientX` any more, and no threshold: horizontal position no longer means
 * anything to a drop, because the mode it used to select is gone.
 */
export function dropModeFromGeometry(
  rect: { top: number; height: number },
  clientY: number,
): DropMode {
  return (clientY - rect.top) / rect.height < 0.5 ? 'before' : 'after'
}

/**
 * Move the caret across a block boundary through ProseMirror instead of the
 * browser.
 *
 * WHY. Some blocks carry a `contenteditable=false` widget INSIDE their text,
 * in front of the first character: the outliner's fold button on every block
 * with children (outliner.ts), and margin-gloss notes on wired blocks. WebKit's
 * native caret movement walks into such a widget. Measured in WebKit with the
 * caret at the start of a parent block: one Left left the caret in no
 * paragraph at all — a typed character landed nowhere — and the next Backspace
 * joined the block into the previous one. Up from a block's start did the
 * same. Chromium steps over the widget, so this only showed in the packaged
 * app, which is WKWebView.
 *
 * Every block carries one again while the value gutter shows (value-marks.ts).
 * The drag handle that first carried this handler is out of the roster, so
 * CaretBoundary (caret-boundary.ts) installs it. If every such widget moves
 * out of the text, this can go: the arrow harness in WebKit, flat and with
 * SHRUBBERY_ARROW_NESTED=1, is the check.
 *
 * When ProseMirror sets the selection itself it draws the DOM caret correctly
 * past the widget, so the fix is to handle exactly the moves that cross a
 * textblock edge and leave every other arrow press to the browser.
 *
 * Plain keys only here. Shift, Option and Command at a block edge are
 * modified-boundary.ts's, for the same widget's sake.
 */
export function crossBlockBoundary(view: EditorView, event: KeyboardEvent): boolean {
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
  const { state } = view
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const $pos = selection.$from
  if (!$pos.parent.isTextblock) return false

  const atStart = $pos.parentOffset === 0
  const atEnd = $pos.parentOffset === $pos.parent.content.size
  let target: TextSelection | null = null

  if (event.key === 'ArrowLeft' && atStart) {
    target = previousTextblockEnd(state, $pos.before())
  } else if (event.key === 'ArrowRight' && atEnd) {
    target = nextTextblockStart(state, $pos.after())
  } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && atStart) {
    // Only when the move would leave this block. Up and Down from the middle of
    // a wrapped paragraph stay inside it, and the browser does those correctly.
    const direction = event.key === 'ArrowUp' ? 'up' : 'down'
    if (!view.endOfTextblock(direction)) return false
    target = event.key === 'ArrowUp'
      ? verticalTarget(view, previousTextblockEnd(state, $pos.before()), 'up')
      : verticalTarget(view, nextTextblockStart(state, $pos.after()), 'down')
  } else {
    return false
  }

  if (!target) return false
  view.dispatch(state.tr.setSelection(target).scrollIntoView())
  return true
}

export function previousTextblockEnd(state: EditorState, before: number): TextSelection | null {
  const found = TextSelection.findFrom(state.doc.resolve(before), -1, true)
  return found instanceof TextSelection ? found : null
}

export function nextTextblockStart(state: EditorState, after: number): TextSelection | null {
  const found = TextSelection.findFrom(state.doc.resolve(after), 1, true)
  return found instanceof TextSelection ? found : null
}

/**
 * For Up and Down, keep the caret's column the way the browser would: land at
 * the caret's x on the nearest line of the neighbouring block. Falls back to the
 * block edge when coordinates are unavailable (a hidden or unmeasured editor).
 */
export function verticalTarget(
  view: EditorView,
  edge: TextSelection | null,
  direction: 'up' | 'down',
  /** Where the caret's column is read from; the selection's head when extending. */
  fromPos: number = view.state.selection.from,
): TextSelection | null {
  if (!edge) return null
  try {
    const here = view.coordsAtPos(fromPos)
    const there = view.coordsAtPos(edge.from)
    const y = direction === 'up' ? there.bottom - 2 : there.top + 2
    const hit = view.posAtCoords({ left: here.left, top: y })
    if (!hit) return edge
    const $hit = view.state.doc.resolve(hit.pos)
    if (!$hit.parent.isTextblock) return edge
    return TextSelection.create(view.state.doc, hit.pos)
  } catch {
    return edge
  }
}

/**
 * THE DRAG HANDLE LIVES BESIDE THE DOCUMENT, NOT IN IT.
 *
 * It used to be a widget decoration at `block.pos + 1` on every block: a
 * `contenteditable=false` span INSIDE each block's inline content, in front of
 * its first character, and only drawn outside the block by CSS. Chromium steps
 * over a non-editable island like that; WebKit (the packaged app is WKWebView)
 * does not, and three bugs came from it:
 *
 *   - Left at the start of a block put the caret in no paragraph at all; the
 *     next Backspace merged blocks.
 *   - A drag selection moving DOWN entered each block at its start, which is
 *     where the handle was, and the selection snapped and caught the handles;
 *     one measured drag became a block reorder.
 *   - Select All selected, but WebKit painted no highlight.
 *
 * So there is ONE handle, a sibling of the editor root inside its parent (the
 * scrolling mount), positioned over whichever top-level block the pointer is
 * level with. The document's text flow contains nothing but text.
 *
 * Nothing in ProseMirror sees events on it, because it is outside `view.dom`:
 * dragstart, dragend, mouseup and click are handled here. dragover and drop
 * still happen over the document and stay in the plugin's handlers below;
 * they only need `sourcePos` in plugin state, which dragstart sets.
 */
class BlockHandleOverlay {
  readonly handle: HTMLElement
  private host: HTMLElement | null = null
  private block: HTMLElement | null = null

  constructor(private readonly view: EditorView) {
    const handle = view.dom.ownerDocument.createElement('span')
    handle.className = 'block-drag-handle'
    handle.setAttribute('draggable', 'true')
    handle.setAttribute('aria-label', 'Drag to move block')
    handle.title = 'Drag to move'
    this.handle = handle
    this.attach()
    // TipTap builds the view BEFORE it mounts view.dom into its element, so
    // there is usually no parent yet at construction. Safe if the editor is
    // destroyed first: EditorView.destroy removes view.dom from its parent (it
    // was appended, not passed as { mount }), so attach() finds none.
    queueMicrotask(() => this.attach())
    handle.addEventListener('dragstart', this.onDragStart)
    handle.addEventListener('dragend', this.onRelease)
    handle.addEventListener('mouseup', this.onRelease)
    handle.addEventListener('click', this.onClick)
  }

  /** Sit beside the editor root, in whatever element holds it. */
  private attach(): void {
    const parent = this.view.dom.parentElement
    if (!parent || parent === this.host) return
    this.detach()
    this.host = parent
    parent.appendChild(this.handle)
    parent.addEventListener('mousemove', this.onPointer)
    parent.addEventListener('mouseover', this.onPointer)
    parent.addEventListener('mouseleave', this.onLeave)
  }

  private detach(): void {
    this.host?.removeEventListener('mousemove', this.onPointer)
    this.host?.removeEventListener('mouseover', this.onPointer)
    this.host?.removeEventListener('mouseleave', this.onLeave)
    this.host = null
  }

  update(): void {
    this.attach()
    if (!this.view.editable) this.hide()
    else if (this.block?.isConnected === false) this.hide()
  }

  destroy(): void {
    this.detach()
    this.handle.remove()
  }

  private readonly onPointer = (event: MouseEvent): void => {
    if (event.target === this.handle) return
    if (!this.view.editable) {
      this.hide()
      return
    }
    const block = this.blockForPointer(event)
    if (block) this.show(block)
    else this.hide()
  }

  private readonly onLeave = (): void => {
    // A drag in flight keeps its handle; dragend clears it.
    if (blockDndKey.getState(this.view.state)?.sourcePos == null) this.hide()
  }

  /**
   * The top-level block the pointer is over, or, when the pointer is beside the
   * text (the gutter where the handle sits, or the gap between blocks), the one
   * whose vertical band contains it.
   */
  private blockForPointer(event: MouseEvent): HTMLElement | null {
    const root = this.view.dom as HTMLElement
    let node = event.target instanceof Element ? event.target : null
    while (node && node !== root && node.parentElement !== root) node = node.parentElement
    if (node && node !== root) return node as HTMLElement
    for (const child of Array.from(root.children)) {
      const rect = child.getBoundingClientRect()
      if (event.clientY >= rect.top && event.clientY < rect.bottom) return child as HTMLElement
    }
    return null
  }

  private show(block: HTMLElement): void {
    if (this.blockPos(block) === null) {
      this.hide()
      return
    }
    this.block = block
    const host = this.host
    if (host) {
      const rect = block.getBoundingClientRect()
      const hostRect = host.getBoundingClientRect()
      const style = block.ownerDocument.defaultView?.getComputedStyle(block)
      const paddingTop = Number.parseFloat(style?.paddingTop ?? '') || 0
      const lineHeight = Number.parseFloat(style?.lineHeight ?? '') || 0
      // Centred on the block's first line, where the old in-block handle sat.
      const top = rect.top - hostRect.top + host.scrollTop + paddingTop + lineHeight / 2
      const left = rect.left - hostRect.left + host.scrollLeft
      this.handle.style.left = `${left}px`
      this.handle.style.top = `${top}px`
    }
    this.handle.setAttribute('data-visible', 'true')
  }

  private hide(): void {
    this.block = null
    this.handle.removeAttribute('data-visible')
  }

  /** Resolved at the moment of use: positions move under every edit. */
  private blockPos(block: HTMLElement | null = this.block): number | null {
    if (!block?.isConnected) return null
    const hit = blockAtEvent(this.view, { target: block })
    if (!hit) return null
    return getOutlinerBlocks(this.view.state.doc).some(b => b.pos === hit.pos) ? hit.pos : null
  }

  private readonly onDragStart = (event: DragEvent): void => {
    const pos = this.view.editable ? this.blockPos() : null
    if (pos === null) {
      event.preventDefault()
      return
    }
    event.dataTransfer?.setData('text/plain', '')
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
    this.view.dispatch(this.view.state.tr.setMeta(blockDndKey, { sourcePos: pos, indicator: null }))
  }

  /**
   * dragend always fires at the drag's SOURCE, which is this handle, so the
   * plugin never sees it. mouseup is the net for a press that never became a
   * drag (the "block stays greyed out" report): the browser then sends neither
   * drop nor dragend.
   */
  private readonly onRelease = (): void => {
    if (blockDndKey.getState(this.view.state)?.sourcePos != null) {
      this.view.dispatch(this.view.state.tr.setMeta(blockDndKey, EMPTY_DND_STATE))
    }
  }

  /** A click on the handle selects the block; Shift extends the selection. */
  private readonly onClick = (event: MouseEvent): void => {
    const pos = this.blockPos()
    if (pos === null) return
    event.preventDefault()
    this.view.dispatch(setSelectionMeta(this.view.state.tr, selectionMetaForClick(this.view.state, pos, event.shiftKey)))
    this.view.focus()
  }
}

export const BlockDnd = Extension.create({
  name: 'blockDnd',

  addProseMirrorPlugins() {
    return [
      new Plugin<DndState>({
        key: blockDndKey,
        state: {
          init: () => EMPTY_DND_STATE,
          apply(tr, previous) {
            const next = tr.getMeta(blockDndKey) as DndState | undefined
            return next ?? previous
          },
        },
        view: (editorView) => new BlockHandleOverlay(editorView),
        props: {
          handleKeyDown(view, event) {
            return crossBlockBoundary(view, event)
          },
          decorations(state) {
            const blocks = getOutlinerBlocks(state.doc)
            const dndState = blockDndKey.getState(state)
            const decorations: Decoration[] = []

            if (dndState?.sourcePos != null) {
              const index = blockIndexAtPos(blocks, dndState.sourcePos)
              if (index !== -1) {
                decorations.push(Decoration.node(blocks[index].pos, blocks[index].end, { class: 'block-dragging' }))
              }
            }

            if (dndState?.indicator) {
              decorations.push(
                Decoration.widget(
                  dndState.indicator.pos + 1,
                  () => {
                    const indicator = document.createElement('span')
                    indicator.className = 'block-drop-indicator'
                    indicator.setAttribute('data-mode', dndState.indicator!.mode)
                    indicator.setAttribute('contenteditable', 'false')
                    return indicator
                  },
                  {
                    side: -1,
                    key: `block-drop-indicator-${dndState.indicator.pos}-${dndState.indicator.mode}`,
                    ignoreSelection: true,
                  },
                ),
              )
            }

            return DecorationSet.create(state.doc, decorations)
          },
          handleDOMEvents: {
            dragover: (view, event) => {
              const dndState = blockDndKey.getState(view.state)
              if (dndState?.sourcePos == null) return false

              const hit = blockAtEvent(view, event)
              if (!hit) {
                // CLEAR THE INDICATOR rather than leaving it. A miss used to
                // return early and leave the last line on screen, so the green
                // guide went on promising a block the pointer had already left
                // — and a release there did nothing, because the drop handler
                // could not resolve a target either. The line must never claim
                // a landing the release will not honour: no target, no line.
                if (dndState.indicator) {
                  view.dispatch(
                    view.state.tr.setMeta(blockDndKey, {
                      sourcePos: dndState.sourcePos,
                      indicator: null,
                    }),
                  )
                }
                return false
              }

              event.preventDefault()

              const mode = dropModeFromGeometry(hit.dom.getBoundingClientRect(), event.clientY)
              const blocks = getOutlinerBlocks(view.state.doc)
              const index = blockIndexAtPos(blocks, hit.pos)
              if (index === -1) return false

              if (!isDropTargetAllowedUnderZoom(blocks, index, getZoomedBlockId(view.state))) {
                if (dndState.indicator) {
                  view.dispatch(
                    view.state.tr.setMeta(blockDndKey, {
                      sourcePos: dndState.sourcePos,
                      indicator: null,
                    }),
                  )
                }
                return true
              }

              const indicator = { pos: blocks[index].pos, end: blocks[index].end, mode }
              const current = dndState.indicator
              if (current && current.pos === indicator.pos && current.mode === indicator.mode) return true

              view.dispatch(view.state.tr.setMeta(blockDndKey, { sourcePos: dndState.sourcePos, indicator }))
              return true
            },
            drop: (view, event) => {
              const dndState = blockDndKey.getState(view.state)
              if (dndState?.sourcePos == null) return false

              const hit = blockAtEvent(view, event)
              if (!hit) {
                view.dispatch(view.state.tr.setMeta(blockDndKey, EMPTY_DND_STATE))
                return false
              }

              event.preventDefault()

              const mode = dropModeFromGeometry(hit.dom.getBoundingClientRect(), event.clientY)
              const tr = applyDrop(view.state, dndState.sourcePos, hit.pos, mode)
              if (tr) {
                tr.setMeta(blockDndKey, EMPTY_DND_STATE)
                view.dispatch(tr)
              } else {
                view.dispatch(view.state.tr.setMeta(blockDndKey, EMPTY_DND_STATE))
              }
              return true
            },
            /**
             * THE SAFETY NET FOR A DRAG THAT NEVER BEGAN — the "block stays
             * greyed out" report.
             *
             * Captured from a real session: picking a block up and nudging it
             * in place produced a `dragstart` with no `drop` and no `dragend`
             * after it. `sourcePos` was set, the source therefore kept its
             * `block-dragging` decoration, and nothing existed to take it off:
             * the only two clearers were drop and dragend, and a gesture the
             * browser abandons before it becomes a real drag fires neither.
             *
             * mouseup is the right net precisely BECAUSE it does not fire
             * during an HTML5 drag — the browser sends dragend instead. So this
             * only ever sees a press that did not turn into a drag, which is
             * exactly the case that used to strand the state. A live drag is
             * untouched.
             */
            mouseup: (view) => {
              const stuck = blockDndKey.getState(view.state)?.sourcePos
              if (stuck == null) return false
              view.dispatch(view.state.tr.setMeta(blockDndKey, EMPTY_DND_STATE))
              return false
            },
          },
        },
      }),
    ]
  },
})

export default BlockDnd
