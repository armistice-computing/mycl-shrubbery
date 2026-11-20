/**
 * block-controls.ts — a row of small buttons at the end of chosen blocks,
 * drawn as widget decorations.
 *
 * The host says which blocks carry controls and what each button looks like
 * (`setBlockControls`); a click calls the extension's `onAction` with the block
 * id and the button's action. The kernel knows nothing about what the buttons
 * mean. The importance view uses it to show the value controls on every quoted
 * block at once, where the usual value gutter shows one block on hover.
 *
 * Widgets, not DOM writes: ProseMirror owns the editor's DOM, so anything the
 * host wrote into it would vanish on the next redraw and wake the DOM
 * observer. The controls arrive through a meta-only transaction, which reaches
 * neither the Y.Doc nor the undo stack.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

export interface BlockControlButton {
  /** Passed back to `onAction` on click. */
  readonly action: string
  readonly label: string
  /** Inline SVG markup for the icon. Built by the host from fixed glyphs. */
  readonly iconSvg: string
  readonly active?: boolean
  readonly disabled?: boolean
}

export interface BlockControlsOptions {
  onAction: ((blockId: string, action: string) => void) | null
}

export type BlockControlsMap = ReadonlyMap<string, readonly BlockControlButton[]>

export const blockControlsKey = new PluginKey<BlockControlsMap>('blockControls')

export const BLOCK_CONTROLS_CLASS = 'block-controls'

const EMPTY: BlockControlsMap = new Map()

function controlsDom(
  blockId: string,
  buttons: readonly BlockControlButton[],
  onAction: BlockControlsOptions['onAction'],
): HTMLElement {
  const row = document.createElement('span')
  row.className = BLOCK_CONTROLS_CLASS
  row.setAttribute('contenteditable', 'false')
  row.dataset.blockControlsFor = blockId
  for (const button of buttons) {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'block-controls-button'
    element.dataset.action = button.action
    element.title = button.label
    element.setAttribute('aria-label', button.label)
    if (button.active) element.classList.add('block-controls-button--active')
    element.disabled = button.disabled === true
    element.innerHTML = button.iconSvg
    // mousedown would move the selection into the read-only text first.
    element.addEventListener('mousedown', event => event.preventDefault())
    element.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      if (!element.disabled) onAction?.(blockId, button.action)
    })
    row.append(element)
  }
  return row
}

/** A key that changes whenever a block's buttons change, so the widget redraws. */
function widgetKey(blockId: string, buttons: readonly BlockControlButton[]): string {
  const state = buttons
    .map(b => `${b.action}:${b.active ? 1 : 0}${b.disabled ? 1 : 0}:${b.label}:${b.iconSvg.length}`)
    .join('|')
  return `block-controls:${blockId}:${state}`
}

function buildDecorations(state: EditorState, onAction: BlockControlsOptions['onAction']): DecorationSet {
  const controls = blockControlsKey.getState(state) ?? EMPTY
  if (controls.size === 0) return DecorationSet.empty
  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.isBlock) return false
    const blockId = node.attrs['data-block-id'] as string | null | undefined
    const buttons = blockId ? controls.get(blockId) : undefined
    if (blockId && buttons && buttons.length > 0 && node.isTextblock) {
      decorations.push(
        Decoration.widget(pos + node.nodeSize - 1, () => controlsDom(blockId, buttons, onAction), {
          side: 1,
          ignoreSelection: true,
          key: widgetKey(blockId, buttons),
        }),
      )
      return false
    }
    return true
  })
  return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty
}

/** Replace the controls. An empty map removes them all. */
export function setBlockControls(view: EditorView | null | undefined, controls: BlockControlsMap): boolean {
  if (!view) return false
  view.dispatch(view.state.tr.setMeta(blockControlsKey, controls))
  return true
}

export const BlockControls = Extension.create<BlockControlsOptions>({
  name: 'blockControls',

  addOptions() {
    return { onAction: null }
  },

  addProseMirrorPlugins() {
    const onAction = (blockId: string, action: string): void => this.options.onAction?.(blockId, action)
    return [
      new Plugin<BlockControlsMap>({
        key: blockControlsKey,
        state: {
          init: () => EMPTY,
          apply(tr, value) {
            const meta = tr.getMeta(blockControlsKey) as BlockControlsMap | undefined
            return meta === undefined ? value : meta
          },
        },
        props: {
          decorations: state => buildDecorations(state, onAction),
        },
      }),
    ]
  },
})

export default BlockControls
