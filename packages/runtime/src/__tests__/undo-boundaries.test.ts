import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Editor } from '@tiptap/core'
import { createLiveCollabEditor } from '../collab/live-editor.js'
import { createUndoBoundaryGate, isUndoBoundary, type UndoBoundaryTransaction } from '../collab/undo-boundaries.js'

const tr = (steps: unknown[], meta: Record<string, unknown> = {}, docChanged = true): UndoBoundaryTransaction => ({
  docChanged,
  steps: steps.map(json => ({ toJSON: () => json })),
  getMeta: (key: string) => meta[key],
})

describe('undo boundaries', () => {
  it('treats splits, marks and pastes as their own steps, and typing as one', () => {
    expect(isUndoBoundary(tr([{ stepType: 'replace', slice: { content: [{ type: 'text' }] } }]))).toBe(false)
    expect(isUndoBoundary(tr([{ stepType: 'replace', slice: { content: [{ type: 'paragraph' }, { type: 'paragraph' }], openStart: 1, openEnd: 1 } }]))).toBe(true)
    expect(isUndoBoundary(tr([{ stepType: 'addMark' }]))).toBe(true)
    expect(isUndoBoundary(tr([{ stepType: 'replace', slice: { content: [{ type: 'text' }] } }], { uiEvent: 'paste' }))).toBe(true)
    expect(isUndoBoundary(tr([{ stepType: 'addMark' }], {}, false))).toBe(false)
  })

  it('closes the step before a boundary and again before the next edit', () => {
    let stops = 0
    const gate = createUndoBoundaryGate({ stopCapturing: () => { stops += 1 } })
    gate(tr([{ stepType: 'replace', slice: { content: [{ type: 'text' }] } }]))
    expect(stops).toBe(0)
    gate(tr([{ stepType: 'addMark' }]))
    expect(stops).toBe(1)
    gate(tr([{ stepType: 'replace', slice: { content: [{ type: 'text' }] } }]))
    expect(stops).toBe(2)
    gate(tr([{ stepType: 'replace', slice: { content: [{ type: 'text' }] } }]))
    expect(stops).toBe(2)
  })
})

describe('her sequence through the room history (Eschaton, 2026-11-17)', () => {
  let editor: Editor | null = null
  afterEach(() => { editor?.destroy(); editor = null })

  it('three words, Enter, bold: each Cmd+Z takes back one of them, in order', () => {
    const doc = new Y.Doc()
    const element = document.createElement('div')
    document.body.appendChild(element)
    editor = createLiveCollabEditor({ element, doc })
    const text = () => editor!.getText({ blockSeparator: '|' })
    const html = () => editor!.getHTML()

    editor.commands.focus('end')
    editor.commands.insertContent('alpha ')
    editor.commands.insertContent('beta ')
    editor.commands.insertContent('gamma')
    editor.commands.splitBlock()
    // Toolbar Bold on the word "beta".
    const start = text().indexOf('beta') + 1
    editor.commands.setTextSelection({ from: start, to: start + 4 })
    editor.commands.toggleBold()
    expect(html()).toContain('<strong>beta</strong>')

    editor.commands.undo()
    expect(html()).not.toContain('<strong>')
    expect(text()).toBe('alpha beta gamma|')

    editor.commands.undo()
    expect(text()).toBe('alpha beta gamma')

    editor.commands.undo()
    expect(text()).toBe('')
  })
})
