/**
 * caret-boundary.ts — plain arrow keys cross block edges through ProseMirror.
 *
 * Every block that carries a `contenteditable=false` widget in front of its
 * first character traps WebKit's native caret: the value-marks row (on every
 * block while the gutter shows), the outliner's fold button, margin-gloss
 * notes. Measured in WebKit (the packaged app is WKWebView): from the start of
 * such a block, Left and Up left the caret where it was, and from an empty
 * block no arrow key moved it at all. Chromium steps over the widget.
 *
 * The handler is `crossBlockBoundary` in block-dnd.ts. It rode in on BlockDnd,
 * and when the drag handle left the roster (2026-10-07) the handler left with
 * it; the trap came back when value marks put a widget in every block. The
 * check is the arrow harness, in WebKit:
 *
 *   SHRUBBERY_BROWSER_ENGINE=webkit pnpm -C apps/organism run test:editor-arrow-across-blocks
 *
 * The same widget breaks WebKit's Option-Backspace on a block's first word,
 * so this plugin also deletes that word itself (word-delete.ts), and its
 * Shift/Option/Command moves at a block edge (modified-boundary.ts).
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { crossBlockBoundary, nextTextblockStart, previousTextblockEnd, verticalTarget } from './block-dnd'
import { modifiedBoundary } from './modified-boundary'
import { isWordBackspace, wordBackwardRange } from './word-delete'

export const caretBoundaryKey = new PluginKey('caretBoundary')

export const CaretBoundary = Extension.create({
  name: 'caretBoundary',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: caretBoundaryKey,
        props: {
          handleKeyDown: (view, event) => {
            if (isWordBackspace(event)) {
              const range = wordBackwardRange(view.state)
              if (!range || range.from === range.to) return false
              view.dispatch(view.state.tr.delete(range.from, range.to).scrollIntoView())
              return true
            }
            if (event.shiftKey || event.altKey || event.metaKey) {
              return modifiedBoundary(view, event, (direction) => {
                const $head = view.state.selection.$head
                const edge = direction === 'up'
                  ? previousTextblockEnd(view.state, $head.before())
                  : nextTextblockStart(view.state, $head.after())
                return verticalTarget(view, edge, direction, $head.pos)
              })
            }
            return crossBlockBoundary(view, event)
          },
        },
      }),
    ]
  },
})
