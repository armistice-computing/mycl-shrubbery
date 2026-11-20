/**
 * TipTap math nodes, ported from Garden with the KaTeX coupling severed.
 *
 * Garden's extension imports KaTeX directly. Shrubbery keeps the schema,
 * commands, input rule, and edit-on-click NodeView in the pure kernel, but
 * renders through an optional host callback. The default renderer is stable raw
 * LaTeX text, so this package keeps its minimal dependency closure.
 */

import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import type { NodeViewRendererProps } from '@tiptap/core'

export interface MathRenderRequest {
  readonly src: string
  readonly displayMode: boolean
}

/**
 * True while this render is still the one the node wants. An async renderer
 * must check it after every await and before touching `target`: the node's
 * source can change, or the node view be destroyed, while a render is in
 * flight, and a stale render finishing last would overwrite the newer one.
 * The same contract as MermaidRenderCurrentCheck.
 */
export type MathRenderCurrentCheck = () => boolean

export type MathRenderer = (
  target: HTMLElement,
  request: MathRenderRequest,
  isCurrent: MathRenderCurrentCheck,
) => void | Promise<void>

export interface MathOptions {
  readonly renderMath?: MathRenderer
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathInline: {
      /** Insert an inline math node at the current selection. */
      insertInlineMath: (src: string) => ReturnType
    }
    mathBlock: {
      /** Insert a block math node at the current selection. */
      insertBlockMath: (src: string) => ReturnType
    }
  }
}

const MATH_CSS = `
  .math-node {
    cursor: pointer;
    position: relative;
    user-select: none;
  }
  .math-node .math-rendered {
    display: inline;
  }
  .math-node.math-block {
    display: block;
    text-align: center;
    margin: 0.75em 0;
    padding: 0.5em 0;
  }
  .math-node.math-block .math-rendered {
    display: block;
  }
  .math-node.math-block .katex-display {
    margin: 0;
  }
  .math-edit-bar {
    position: absolute;
    left: 0;
    top: calc(100% + 4px);
    z-index: 100;
    min-width: 220px;
    max-width: min(480px, 90vw);
    padding: 5px 10px;
    border: 1px solid var(--mn-color-border-default, rgba(15, 23, 42, 0.14));
    border-radius: var(--mn-radius-md, 6px);
    background: var(--mn-color-surface-raised, #fff);
    box-shadow: var(--mn-shadow-popover, 0 12px 32px rgba(15, 23, 42, 0.18));
    white-space: nowrap;
  }
  .math-edit-input {
    width: 100%;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--mn-color-text-primary, #1f2933);
    caret-color: var(--mn-color-text-accent, #3d7f5f);
    font: 500 var(--mn-type-ui-size, 0.875rem)/1.5 var(--mn-font-mono, ui-monospace, monospace);
  }
  .math-node[data-math-error] .math-rendered {
    color: var(--mn-color-danger, #b42318);
    font-family: var(--mn-font-mono, ui-monospace, monospace);
    font-size: 0.875em;
  }
  .ProseMirror:not([contenteditable='false']) .math-node:hover,
  .ProseMirror-selectednode .math-node,
  .math-node.ProseMirror-selectednode {
    outline: 2px solid var(--mn-color-border-accent, #3d7f5f);
    outline-offset: 2px;
    border-radius: 2px;
  }
`

let mathSheet: CSSStyleSheet | null = null

/**
 * Adopt the math styles into the root the editor lives in: its shadow root
 * in the app, where a sheet on the document never reaches. A constructable
 * sheet, not a <style> element: the packaged app's CSP refuses runtime
 * <style> elements (see adoptStyleSheet in nucleus, which this package
 * cannot import).
 */
function injectMathCss(editorDom: HTMLElement): void {
  const rootNode = editorDom.getRootNode()
  const root: Document | ShadowRoot = rootNode instanceof ShadowRoot ? rootNode : editorDom.ownerDocument
  mathSheet ??= new CSSStyleSheet()
  if (mathSheet.cssRules.length === 0) mathSheet.replaceSync(MATH_CSS)
  if (!root.adoptedStyleSheets.includes(mathSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, mathSheet]
}

function defaultRenderMath(target: HTMLElement, request: MathRenderRequest): void {
  const fallback = request.displayMode ? 'LaTeX expression' : 'math'
  target.textContent = request.src.trim() || fallback
  target.parentElement?.removeAttribute('data-math-error')
}

function renderIntoElement(
  target: HTMLElement,
  request: MathRenderRequest,
  renderMath: MathRenderer | undefined,
  isCurrent: MathRenderCurrentCheck,
): void {
  // An empty formula always shows the kernel's placeholder; a host renderer
  // only ever sees real source.
  const renderer = request.src.trim() ? (renderMath ?? defaultRenderMath) : defaultRenderMath
  target.replaceChildren()
  const result = renderer(target, request, isCurrent)
  if (result && typeof (result as Promise<void>).then === 'function') {
    void (result as Promise<void>).catch(() => {
      if (!isCurrent()) return
      target.textContent = request.src
      target.parentElement?.setAttribute('data-math-error', '')
    })
  }
}

function createMathNodeView(displayMode: boolean, renderMath: MathRenderer | undefined) {
  return ({ node: initNode, getPos, editor }: NodeViewRendererProps) => {
    let currentNode = initNode
    const tag = displayMode ? 'div' : 'span'
    const doc = editor.view.dom.ownerDocument
    injectMathCss(editor.view.dom)

    const dom = doc.createElement(tag)
    dom.className = `math-node ${displayMode ? 'math-block' : 'math-inline'}`
    dom.contentEditable = 'false'

    const rendered = doc.createElement(tag)
    rendered.className = 'math-rendered'
    // Each render takes a generation; only the latest may write. Destroying
    // the view ends every render still in flight.
    let generation = 0
    let destroyed = false
    const render = (src: string): void => {
      const mine = ++generation
      renderIntoElement(rendered, { src, displayMode }, renderMath, () => !destroyed && mine === generation)
    }
    render(String(currentNode.attrs.src ?? ''))
    dom.appendChild(rendered)

    let editBar: HTMLDivElement | null = null

    function hideEditBar(): void {
      editBar?.remove()
      editBar = null
    }

    function showEditBar(): void {
      if (editBar) {
        editBar.querySelector('input')?.focus()
        return
      }

      editBar = doc.createElement('div')
      editBar.className = 'math-edit-bar'

      const input = doc.createElement('input')
      input.type = 'text'
      input.className = 'math-edit-input'
      input.value = String(currentNode.attrs.src ?? '')
      input.placeholder = 'LaTeX expression'
      input.spellcheck = false
      input.autocomplete = 'off'

      // Escape sets this before tearing down so the synthetic blur fired by
      // removing the focused input does not silently commit the typed value.
      let canceled = false

      const apply = (): void => {
        if (canceled) return
        const newSrc = input.value
        const oldSrc = String(currentNode.attrs.src ?? '')
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos === 'number' && newSrc !== oldSrc) {
          editor
            .chain()
            .setNodeSelection(pos)
            .updateAttributes(displayMode ? 'mathBlock' : 'mathInline', { src: newSrc })
            .run()
        }
        // No render here: the attribute change re-renders through update().
        hideEditBar()
      }

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          apply()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          canceled = true
          hideEditBar()
        }
        event.stopPropagation()
      })
      input.addEventListener('blur', apply)

      editBar.appendChild(input)
      dom.appendChild(editBar)
      doc.defaultView?.requestAnimationFrame(() => input.focus())
    }

    dom.addEventListener('click', (event) => {
      if (!editor.isEditable) return
      event.stopPropagation()
      showEditBar()
    })

    return {
      dom,
      update(newNode: typeof initNode): boolean {
        if (newNode.type !== currentNode.type) return false
        if (newNode.attrs.src !== currentNode.attrs.src) {
          render(String(newNode.attrs.src ?? ''))
        }
        currentNode = newNode
        return true
      },
      destroy(): void {
        destroyed = true
        hideEditBar()
      },
    }
  }
}

export const InlineMath = Node.create<MathOptions>({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return {}
  },

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-math-inline') ?? '',
        renderHTML: (attributes) => ({ 'data-math-inline': attributes.src }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-math-inline]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'math-inline' }, HTMLAttributes)]
  },

  addCommands() {
    return {
      insertInlineMath:
        (src: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { src } }),
    }
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(?<!\$)\$\$([^\$\n]+)\$\$(?!\$)/,
        handler({ range, match, commands }) {
          const src = match[1]?.trim()
          if (!src) return
          commands.insertContentAt({ from: range.from, to: range.to }, { type: 'mathInline', attrs: { src } })
        },
      }),
    ]
  },

  addNodeView() {
    return createMathNodeView(false, this.options.renderMath)
  },
})

export const BlockMath = Node.create<MathOptions>({
  name: 'mathBlock',
  group: 'block',
  atom: true,

  addOptions() {
    return {}
  },

  addAttributes() {
    return {
      src: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-math-block') ?? '',
        renderHTML: (attributes) => ({ 'data-math-block': attributes.src }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-math-block]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'math-block' }, HTMLAttributes)]
  },

  addCommands() {
    return {
      insertBlockMath:
        (src: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { src } }),
    }
  },

  addNodeView() {
    return createMathNodeView(true, this.options.renderMath)
  },
})

export default [InlineMath, BlockMath]
