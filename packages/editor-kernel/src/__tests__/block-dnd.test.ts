import { afterEach, describe, expect, it } from 'vitest'
import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { Editor } from '@tiptap/core'
import { createKernelEditor, kernelCoreExtensionOptions, kernelExtensions } from '../index'
import {
  BlockDnd,
  applyDrop,
  blockDndKey,
  dropModeFromGeometry,
  isDropTargetAllowedUnderZoom,
} from '../extensions/block-dnd'
import { applyZoomInto, createZoomPlugin } from '../extensions/outliner-zoom'
import { blockSelectionKey } from '../extensions/block-selection'
import { getOutlinerBlocks, planDrop, type DropMode } from '../outliner-tree'

const blockAttrs = {
  indent: { default: 0 },
  collapsed: { default: false },
  'data-block-id': { default: null },
}

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: blockAttrs,
      toDOM: () => ['p', 0],
    },
    listItem: {
      group: 'block',
      content: '(paragraph | codeBlock)+',
      attrs: {
        ...blockAttrs,
        listType: { default: 'bullet' },
        checked: { default: false },
      },
      toDOM: () => ['li', 0],
    },
    codeBlock: {
      group: 'block',
      content: 'text*',
      code: true,
      toDOM: () => ['pre', ['code', 0]],
    },
    text: { group: 'inline' },
  },
})

const mountedEditors: ReturnType<typeof createKernelEditor>[] = []

afterEach(() => {
  while (mountedEditors.length) mountedEditors.pop()?.destroy()
  document.body.innerHTML = ''
})

function paragraph(text: string, indent = 0, blockId?: string): ProseMirrorNode {
  return schema.node(
    'paragraph',
    { indent, collapsed: false, 'data-block-id': blockId ?? null },
    schema.text(text),
  )
}

function codeBlock(text: string): ProseMirrorNode {
  return schema.node('codeBlock', null, schema.text(text))
}

function listItem(
  text: string,
  indent = 0,
  blockId?: string,
  extraContent: ProseMirrorNode[] = [],
): ProseMirrorNode {
  return schema.node(
    'listItem',
    {
      indent,
      collapsed: false,
      'data-block-id': blockId ?? null,
      listType: 'task',
      checked: true,
    },
    [paragraph(text), ...extraContent],
  )
}

function makeState(blocks: ProseMirrorNode[], plugins: Parameters<typeof EditorState.create>[0]['plugins'] = []): EditorState {
  return EditorState.create({ schema, doc: schema.node('doc', null, blocks), plugins })
}

function labelOf(node: ProseMirrorNode): string {
  return node.type.name === 'listItem' ? node.child(0).textContent : node.textContent
}

function posOf(state: EditorState, label: string): number {
  const block = getOutlinerBlocks(state.doc).find((candidate) => labelOf(candidate.node) === label)
  if (!block) throw new Error(`block not found: ${label}`)
  return block.pos
}

function drop(state: EditorState, source: string, target: string, mode: DropMode): EditorState {
  const tr = applyDrop(state, posOf(state, source), posOf(state, target), mode)
  if (!tr) throw new Error('drop returned null')
  return state.apply(tr)
}

function order(state: EditorState): Array<[string, number, string]> {
  const out: Array<[string, number, string]> = []
  state.doc.forEach((node) => {
    out.push([labelOf(node), node.attrs.indent as number, node.type.name])
  })
  return out
}

function mountKernelEditor(): ReturnType<typeof createKernelEditor> {
  const element = document.createElement('div')
  document.body.appendChild(element)
  // The drag handle left the kernel roster on 2026-10-07 (move mode replaced
  // it); mount it explicitly to keep the module covered.
  const editor = new Editor({
    element,
    extensions: [...kernelExtensions({}), BlockDnd],
    coreExtensionOptions: kernelCoreExtensionOptions,
  })
  mountedEditors.push(editor)
  return editor
}

describe('dropModeFromGeometry', () => {
  const rect = { top: 100, height: 40 }

  it('splits the block at its midpoint — above is before, below is after', () => {
    expect(dropModeFromGeometry(rect, 101)).toBe('before')
    expect(dropModeFromGeometry(rect, 119)).toBe('before')
    expect(dropModeFromGeometry(rect, 121)).toBe('after')
    expect(dropModeFromGeometry(rect, 139)).toBe('after')
  })

  it('leaves NO dead zone — every pixel of the block resolves to a drop', () => {
    // The point of the 2026-09-10 change. The old three-band reading gave the
    // middle 50% to a 'child' mode that owned most of the target, so the two
    // useful outcomes lived in 10-pixel strips at the edges of a 40px block.
    const modes = new Set<string>()
    for (let y = rect.top; y < rect.top + rect.height; y += 1) {
      modes.add(dropModeFromGeometry(rect, y))
    }
    expect([...modes].sort()).toEqual(['after', 'before'])
  })

  it('a very tall block splits at ITS midpoint, not at a fixed offset', () => {
    // A table measured 217px in the app; the old bands put a 109-pixel 'child'
    // zone in the middle of it.
    const tall = { top: 0, height: 217 }
    expect(dropModeFromGeometry(tall, 107)).toBe('before')
    expect(dropModeFromGeometry(tall, 110)).toBe('after')
  })
})

describe('planDrop validity and indent math', () => {
  const blocks = getOutlinerBlocks(
    makeState([paragraph('A'), paragraph('B', 1), paragraph('C', 2), paragraph('D')]).doc,
  )

  it('rejects dropping a block into itself or its own descendant', () => {
    expect(planDrop(blocks, 0, 0, 'after')).toBeNull()
    expect(planDrop(blocks, 0, 2, 'after')).toBeNull()
  })

  it('a drop adopts the target indent — it never adds one', () => {
    // Was: 'child' produced target+1. That mode is gone; a drop reorders and
    // leaves nesting to Tab.
    expect(planDrop(blocks, 3, 1, 'after')?.indentDelta).toBe(1)
    expect(planDrop(blocks, 3, 1, 'before')?.indentDelta).toBe(1)
    expect(planDrop(blocks, 3, 0, 'after')?.indentDelta).toBe(0)
  })

  it('still rejects drops that would exceed the maximum indent', () => {
    // Reachable without 'child': dragging a subtree that is already deep onto a
    // deeper target still overflows.
    const deep = getOutlinerBlocks(
      makeState([paragraph('X', 6), paragraph('Y'), paragraph('Z', 1)]).doc,
    )
    expect(planDrop(deep, 0, 2, 'after')?.indentDelta).toBe(-5)
    // A source subtree with its own depth, dropped onto a deep target: the
    // ROOT would fit at 6 but its child would land at 7.
    const overflow = getOutlinerBlocks(
      makeState([paragraph('P'), paragraph('P2', 1), paragraph('R', 6)]).doc,
    )
    expect(planDrop(overflow, 0, 2, 'after')).toBeNull()
  })
})

describe('zoom-aware drop guard', () => {
  it('allows only descendants of the zoomed root as targets', () => {
    const blocks = getOutlinerBlocks(
      makeState([
        paragraph('A', 0, 'block-a'),
        paragraph('B', 1, 'block-b'),
        paragraph('C', 1, 'block-c'),
        paragraph('D', 0, 'block-d'),
      ]).doc,
    )

    expect(isDropTargetAllowedUnderZoom(blocks, 0, 'block-a')).toBe(false)
    expect(isDropTargetAllowedUnderZoom(blocks, 1, 'block-a')).toBe(true)
    expect(isDropTargetAllowedUnderZoom(blocks, 2, 'block-a')).toBe(true)
    expect(isDropTargetAllowedUnderZoom(blocks, 3, 'block-a')).toBe(false)
    expect(isDropTargetAllowedUnderZoom(blocks, 3, null)).toBe(true)
    expect(isDropTargetAllowedUnderZoom(blocks, 3, 'block-missing')).toBe(true)
  })
})

describe('applyDrop', () => {
  it("a drop below a block clears the block's whole subtree", () => {
    // This case used to assert `drop(..., 'child')` put D between A and B at
    // indent 1. That mode is gone (2026-09-10).
    //
    // NOTE THE REAL DIFFERENCE, which is not only the indent: 'child' inserted
    // at `target.end` — immediately after A, ABOVE its descendants — while
    // 'after' walks forward past every deeper block. So dropping below A now
    // lands past C, not between A and B.
    let state = makeState([paragraph('A'), paragraph('B', 1), paragraph('C', 2), paragraph('D')])
    state = drop(state, 'D', 'A', 'after')

    expect(order(state)).toEqual([
      ['A', 0, 'paragraph'],
      ['B', 1, 'paragraph'],
      ['C', 2, 'paragraph'],
      ['D', 0, 'paragraph'],
    ])
  })

  it('the slot between a parent and its first child is still reachable', () => {
    // The position 'child' used to occupy. Removing that mode must not make it
    // unreachable — it is simply spelled differently now: drop BEFORE the first
    // descendant rather than below the parent.
    let state = makeState([paragraph('A'), paragraph('B', 1), paragraph('C', 2), paragraph('D')])
    state = drop(state, 'D', 'B', 'before')

    expect(order(state)).toEqual([
      ['A', 0, 'paragraph'],
      ['D', 1, 'paragraph'],
      ['B', 1, 'paragraph'],
      ['C', 2, 'paragraph'],
    ])
  })

  it('drops a subtree after a sibling and shifts descendant indents', () => {
    let state = makeState([paragraph('A'), paragraph('B', 1), paragraph('C', 2), paragraph('D')])
    state = drop(state, 'B', 'D', 'after')

    expect(order(state)).toEqual([
      ['A', 0, 'paragraph'],
      ['D', 0, 'paragraph'],
      ['B', 0, 'paragraph'],
      ['C', 1, 'paragraph'],
    ])
  })

  it('drops before a target using the target sibling indent', () => {
    let state = makeState([paragraph('A'), paragraph('B', 1), paragraph('C', 2), paragraph('D')])
    state = drop(state, 'D', 'B', 'before')

    expect(order(state)).toEqual([
      ['A', 0, 'paragraph'],
      ['D', 1, 'paragraph'],
      ['B', 1, 'paragraph'],
      ['C', 2, 'paragraph'],
    ])
  })

  it('preserves block ids through a drop', () => {
    let state = makeState([
      paragraph('A', 0, 'block-a'),
      paragraph('B', 1, 'block-b'),
      paragraph('C', 2, 'block-c'),
      paragraph('D', 0, 'block-d'),
    ])

    state = drop(state, 'B', 'D', 'after')

    const ids: string[] = []
    state.doc.descendants((node) => {
      if (node.type.name === 'paragraph') ids.push(node.attrs['data-block-id'] as string)
    })

    expect(ids).toEqual(['block-a', 'block-d', 'block-b', 'block-c'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('preserves list-item attrs and nested block content while moving a subtree', () => {
    let state = makeState([
      paragraph('A'),
      listItem('Task', 1, 'block-task', [codeBlock('code()')]),
      paragraph('Child', 2, 'block-child'),
      paragraph('D'),
    ])

    state = drop(state, 'Task', 'D', 'after')

    expect(order(state)).toEqual([
      ['A', 0, 'paragraph'],
      ['D', 0, 'paragraph'],
      ['Task', 0, 'listItem'],
      ['Child', 1, 'paragraph'],
    ])

    const moved = state.doc.child(2)
    expect(moved.type.name).toBe('listItem')
    expect(moved.attrs['data-block-id']).toBe('block-task')
    expect(moved.attrs.listType).toBe('task')
    expect(moved.attrs.checked).toBe(true)
    expect(moved.childCount).toBe(2)
    expect(moved.child(0).textContent).toBe('Task')
    expect(moved.child(1).type.name).toBe('codeBlock')
    expect(moved.child(1).textContent).toBe('code()')
  })

  it('returns null for an invalid drop into the source subtree', () => {
    const state = makeState([paragraph('A'), paragraph('B', 1), paragraph('C', 2), paragraph('D')])
    expect(applyDrop(state, posOf(state, 'A'), posOf(state, 'C'), 'after')).toBeNull()
  })

  it('rejects a drop target outside the active zoom subtree', () => {
    let state = makeState(
      [
        paragraph('A', 0, 'block-a'),
        paragraph('B', 1, 'block-b'),
        paragraph('C', 1, 'block-c'),
        paragraph('D', 0, 'block-d'),
      ],
      [createZoomPlugin()],
    )
    const zoom = applyZoomInto(state, 'block-a')
    if (zoom === false) throw new Error('zoom setup failed')
    state = state.apply(zoom)

    expect(applyDrop(state, posOf(state, 'B'), posOf(state, 'D'), 'after')).toBeNull()

    const allowed = applyDrop(state, posOf(state, 'B'), posOf(state, 'C'), 'after')
    expect(allowed).not.toBeNull()
  })
})

describe('BlockDnd DOM affordances from Garden PR #4', () => {
  it('renders ONE accessible drag handle beside the document, never inside its text', () => {
    // The handle used to be a contenteditable=false widget inside every block,
    // in front of its first character. WebKit's caret, drag selection and
    // select-all highlight all walked into it. Nothing may sit in the text flow.
    const editor = mountKernelEditor()
    editor.commands.setContent('<p data-block-id="block-a">A</p><p data-block-id="block-b">B</p>')

    expect(editor.view.dom.querySelectorAll('.block-drag-handle')).toHaveLength(0)
    expect(editor.view.dom.querySelectorAll('[contenteditable="false"]')).toHaveLength(0)

    const handles = Array.from(
      editor.view.dom.parentElement!.querySelectorAll<HTMLElement>('.block-drag-handle'),
    )
    expect(handles).toHaveLength(1)
    expect(handles[0].getAttribute('draggable')).toBe('true')
    expect(handles[0].getAttribute('aria-label')).toBe('Drag to move block')
    expect(handles[0].hasAttribute('data-visible')).toBe(false)
  })

  it('shows the handle for the hovered block and hides it when the pointer leaves', () => {
    const editor = mountKernelEditor()
    editor.commands.setContent('<p data-block-id="block-a">A</p><p data-block-id="block-b">B</p>')
    const handle = editor.view.dom.parentElement!.querySelector<HTMLElement>('.block-drag-handle')!

    editor.view.dom.querySelector('[data-block-id="block-b"]')!
      .dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(handle.hasAttribute('data-visible')).toBe(true)

    editor.view.dom.parentElement!.dispatchEvent(new MouseEvent('mouseleave'))
    expect(handle.hasAttribute('data-visible')).toBe(false)
  })

  it('a click on the handle selects the hovered block, and Shift-click extends', () => {
    const editor = mountKernelEditor()
    editor.commands.setContent(
      '<p data-block-id="block-a">A</p><p data-block-id="block-b">B</p><p data-block-id="block-c">C</p>',
    )
    const handle = editor.view.dom.parentElement!.querySelector<HTMLElement>('.block-drag-handle')!
    const hover = (id: string): void => {
      editor.view.dom.querySelector(`[data-block-id="${id}"]`)!
        .dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    }
    const posOfText = (text: string): number =>
      getOutlinerBlocks(editor.state.doc).find(block => block.node.textContent === text)!.pos

    hover('block-a')
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(blockSelectionKey.getState(editor.state)).toEqual({ anchor: posOfText('A'), head: posOfText('A') })

    hover('block-c')
    handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))
    expect(blockSelectionKey.getState(editor.state)).toEqual({ anchor: posOfText('A'), head: posOfText('C') })
  })

  it('renders the drop indicator as a dedicated widget, not a block pseudo-element', () => {
    const editor = mountKernelEditor()
    editor.commands.setContent('<p data-block-id="block-a">A</p><p data-block-id="block-b">B</p>')
    const blocks = getOutlinerBlocks(editor.state.doc)
    const source = blocks.find((block) => block.node.textContent === 'A')
    const target = blocks.find((block) => block.node.textContent === 'B')
    if (!source || !target) throw new Error('test blocks did not render')

    editor.view.dispatch(
      editor.state.tr.setMeta(blockDndKey, {
        sourcePos: source.pos,
        indicator: { pos: target.pos, end: target.end, mode: 'after' },
      }),
    )

    const indicators = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.block-drop-indicator'))

    expect(indicators).toHaveLength(1)
    expect(indicators[0].getAttribute('data-mode')).toBe('after')
    expect(indicators[0].getAttribute('contenteditable')).toBe('false')
  })
})
