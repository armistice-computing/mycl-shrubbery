import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createKernelEditor, isFileLink, type KernelOptions, type WikiLinkAttrs } from '../index'

const editors: Editor[] = []

afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
  document.body.innerHTML = ''
})

function mount(options: KernelOptions = {}): Editor {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createKernelEditor(el, options)
  editors.push(editor)
  return editor
}

const FILE_LINK: WikiLinkAttrs = {
  targetDocId: '',
  label: 'plan.md · lines 5–8',
  wireId: 'wire-file-1',
  targetArtifactId: 'artifact-plan',
  filePath: '/Users/me/notes/plan.md',
  region: 'L5-L8',
}

describe('a file link in the wikilink node', () => {
  it('keeps the file, renders as a chip, and writes [[path#region]] as text', () => {
    const editor = mount()
    editor.commands.setContent('<p>See </p>')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertWikiLink(FILE_LINK)

    const node = editor.state.doc.firstChild!.lastChild!
    expect(node.type.name).toBe('wikilink')
    expect(node.attrs).toMatchObject({
      targetArtifactId: 'artifact-plan',
      filePath: '/Users/me/notes/plan.md',
      region: 'L5-L8',
      wireId: 'wire-file-1',
    })
    const chip = editor.view.dom.querySelector('.wikilink-file')
    expect(chip?.textContent).toBe('plan.md · lines 5–8')
    expect(chip?.getAttribute('data-file-path')).toBe('/Users/me/notes/plan.md')
    expect(editor.getText()).toContain('[[/Users/me/notes/plan.md#L5-L8]]')

    // The HTML round trip keeps the file attributes.
    const again = mount()
    again.commands.setContent(editor.getHTML())
    const copy = again.state.doc.firstChild!.lastChild!
    expect(copy.attrs).toMatchObject({ filePath: '/Users/me/notes/plan.md', region: 'L5-L8', targetArtifactId: 'artifact-plan' })
  })

  it('takes a file picked by name, with an id and no path, and writes [[name#region]] as text', () => {
    const editor = mount()
    editor.commands.setContent('<p>See </p>')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertWikiLink({ targetDocId: '', label: 'notes.md · lines 2–3', wireId: 'wire-known-1', targetArtifactId: 'artifact-notes', filePath: null, region: 'L2-L3' })
    const chip = editor.view.dom.querySelector('.wikilink-file')
    expect(chip?.textContent).toBe('notes.md · lines 2–3')
    expect(chip?.getAttribute('data-target-artifact-id')).toBe('artifact-notes')
    expect(editor.getText()).toContain('[[notes.md#L2-L3]]')
    expect(isFileLink({ filePath: null, targetArtifactId: 'artifact-notes' })).toBe(true)
  })

  it('hands the click to the host with the file and the chip element', () => {
    const clicks: Array<{ attrs: WikiLinkAttrs; element?: HTMLElement }> = []
    const editor = mount({ onWikiLinkClick: (attrs, element) => clicks.push({ attrs, element }) })
    editor.commands.setContent('<p>x</p>')
    editor.commands.setTextSelection(2)
    editor.commands.insertWikiLink(FILE_LINK)
    const chip = editor.view.dom.querySelector('.wikilink-file') as HTMLElement
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(clicks).toHaveLength(1)
    expect(isFileLink(clicks[0]!.attrs)).toBe(true)
    expect(clicks[0]!.attrs.region).toBe('L5-L8')
    expect(clicks[0]!.element).toBe(chip)
  })

  it('leaves a document link as it was', () => {
    const editor = mount()
    editor.commands.setContent('<p>x</p>')
    editor.commands.setTextSelection(2)
    editor.commands.insertWikiLink({ targetDocId: 'doc-plan', label: 'Plan', wireId: 'w' })
    expect(editor.view.dom.querySelector('.wikilink-file')).toBeNull()
    expect(editor.getText()).toContain('[[Plan]]')
    expect(isFileLink({ filePath: null, targetArtifactId: null })).toBe(false)
  })
})
