/**
 * comment-active.ts — paints the active comment's marked text, as a decoration.
 *
 * The host used to set `data-active` on every `.comment-mark` element itself.
 * Those elements belong to ProseMirror: a redraw drops the attribute, and the
 * write itself wakes the DOMObserver, which re-reads the selection (see
 * focused-block.ts for what that does to a WebKit drag-selection).
 *
 * Here the host moves one id through a meta-only transaction, and ProseMirror
 * draws an inline decoration with the class `comment-active` over every range
 * that carries that comment's mark. Inline decorations render as a span inside
 * the mark's span, so the stylesheet selects `.comment-active` (and the mark
 * around it with `:has`), not an attribute on the mark.
 *
 * Meta-only transactions change no content, so they reach neither the Y.Doc
 * nor the shared undo stack (measured for wire-decorations.ts).
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

export const commentActiveKey = new PluginKey<string | null>('commentActive')

export const COMMENT_ACTIVE_CLASS = 'comment-active'

/** Every [from, to) range carrying the comment mark with this id, in order. */
export function commentMarkRanges(
  state: EditorState,
  commentId: string,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  state.doc.descendants((node, pos) => {
    if (!node.isInline) return true
    const marked = node.marks.some(
      mark => mark.type.name === 'commentMark' && mark.attrs.commentId === commentId,
    )
    if (!marked) return false
    const last = ranges[ranges.length - 1]
    if (last && last.to === pos) last.to = pos + node.nodeSize
    else ranges.push({ from: pos, to: pos + node.nodeSize })
    return false
  })
  return ranges
}

function buildDecorations(state: EditorState): DecorationSet {
  const activeId = commentActiveKey.getState(state)
  if (!activeId) return DecorationSet.empty
  const decorations = commentMarkRanges(state, activeId).map(range =>
    Decoration.inline(range.from, range.to, { class: COMMENT_ACTIVE_CLASS }),
  )
  return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty
}

/**
 * Make `commentId` the active comment, or clear it with null. Returns false
 * only when there is no view to dispatch into.
 */
export function setActiveCommentId(view: EditorView | null | undefined, commentId: string | null): boolean {
  if (!view) return false
  const next = commentId?.trim() || null
  if (commentActiveKey.getState(view.state) === next) return true
  view.dispatch(view.state.tr.setMeta(commentActiveKey, next))
  return true
}

export const CommentActive = Extension.create({
  name: 'commentActive',

  addProseMirrorPlugins() {
    return [
      new Plugin<string | null>({
        key: commentActiveKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(commentActiveKey) as string | null | undefined
            return meta === undefined ? value : meta
          },
        },
        props: {
          decorations: buildDecorations,
        },
      }),
    ]
  },
})

export default CommentActive
