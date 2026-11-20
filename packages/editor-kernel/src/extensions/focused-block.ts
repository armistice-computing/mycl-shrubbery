/**
 * focused-block.ts — marks the block the selection is in with
 * `data-block-focused`, as a decoration.
 *
 * The host used to toggle that attribute onto the block elements itself on
 * every selection change. Those elements belong to ProseMirror, whose
 * DOMObserver treats any foreign mutation as an edit to read back: it re-reads
 * the DOM selection on the spot. In WebKit, mid drag-selection, that read
 * comes back collapsed at the drag's start, so dragging a selection from one
 * block into the next dropped it the moment the pointer crossed the boundary.
 * Measured in the app harness: the selection reached 14..60, one mutation
 * later it was 14..14; with the host's writes disabled it ran to 14..74.
 *
 * As a decoration ProseMirror draws the attribute itself, inside its own
 * update, where the observer is paused. Same attribute, same stylesheet; see
 * wire-decorations.ts for the same lesson learned on wire highlights.
 *
 * The marked node is the innermost one carrying a block id around the
 * selection's start, or the selected node itself for a node selection.
 */
import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const focusedBlockKey = new PluginKey('focusedBlock')

function hasBlockId(attrs: Record<string, unknown> | undefined): boolean {
  const id = attrs?.['data-block-id']
  return typeof id === 'string' && id.length > 0
}

export function focusedBlockRange(state: EditorState): { from: number; to: number } | null {
  const { selection } = state
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if (hasBlockId($from.node(depth).attrs)) {
      const from = $from.before(depth)
      return { from, to: from + $from.node(depth).nodeSize }
    }
  }
  if (selection instanceof NodeSelection && hasBlockId(selection.node.attrs)) {
    return { from: selection.from, to: selection.to }
  }
  return null
}

export const FocusedBlock = Extension.create({
  name: 'focusedBlock',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: focusedBlockKey,
        props: {
          decorations(state) {
            const range = focusedBlockRange(state)
            if (!range) return DecorationSet.empty
            return DecorationSet.create(state.doc, [
              Decoration.node(range.from, range.to, { 'data-block-focused': '' }),
            ])
          },
        },
      }),
    ]
  },
})

export default FocusedBlock
