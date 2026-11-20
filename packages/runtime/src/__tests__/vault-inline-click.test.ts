/**
 * vault-inline-click.test.ts: clicking the inline links a vault import writes.
 *
 * The fixture is a document from garden's vault import (Door 1), round-tripped
 * through a Rust Y.Doc, with the two wires the import made for its links: one to
 * a document and one to a file. It is loaded into a real kernel editor wired with
 * the shipped buildKernelOptions. Only the outer sinks are replaced: the
 * navigation service and the file-link popover.
 *
 * What a click must carry:
 * - a document chip opens the target document in the target graph;
 * - a file chip opens through the file-link path with the artifact id;
 * - the wire id and the source block id reach the handler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureJson from './fixtures/vault-inline-click.json'
import type { Editor } from '@tiptap/core'
import { createKernelEditor, type WikiLinkAttrs } from '@shrubbery/editor-kernel'

const popover = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('../picker/file-link-popover.js', () => ({
  openFileLinkPopover: (...args: unknown[]) => {
    popover.calls.push(args)
    return Promise.resolve(null)
  },
}))

import { buildKernelOptions, type EditorServices } from '../editor-services/assemble.js'
import { DEFAULT_WIKILINK_PREDICATE } from '../editor-services/wire-service.js'

interface FixtureWire {
  id: string
  source_block_id: string
  target_graph: string
  target_id: string
  artifact: boolean
  predicate: string
}
interface Fixture {
  sourceDocumentId: string
  graphId: string
  document: Record<string, unknown>
  wires: FixtureWire[]
}

const fixture = fixtureJson as unknown as Fixture
const docWire = fixture.wires.find(w => !w.artifact)!
const fileWire = fixture.wires.find(w => w.artifact)!

const editors: Editor[] = []
afterEach(() => {
  while (editors.length) editors.pop()?.destroy()
  popover.calls.length = 0
  document.body.innerHTML = ''
})

function mount() {
  const openDocument = vi.fn()
  const clicks: WikiLinkAttrs[] = []
  const services = {
    navigation: { openDocument, openExternal: vi.fn(), openZoteroSource: vi.fn() },
    wire: {},
    queryBlocks: {},
  } as unknown as EditorServices
  const options = buildKernelOptions(services, {
    centerMode: 'document',
    graphId: fixture.graphId,
    documentId: fixture.sourceDocumentId,
  })
  const shipped = options.onWikiLinkClick!
  const el = document.createElement('div')
  document.body.appendChild(el)
  const editor = createKernelEditor(el, {
    ...options,
    onWikiLinkClick: (attrs, element) => {
      clicks.push(attrs)
      shipped(attrs, element)
    },
  })
  editors.push(editor)
  editor.commands.setContent(fixture.document)
  return { editor, openDocument, clicks }
}

function chip(editor: Editor, wireId: string): HTMLElement {
  const found = editor.view.dom.querySelector(`.wikilink[data-wire-id="${wireId}"]`)
  expect(found, `chip for ${wireId}`).not.toBeNull()
  return found as HTMLElement
}

function click(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('vault import inline links: a click reaches the right place', () => {
  it('the import gives every inline-link wire the same default predicate a typed wikilink gets', () => {
    expect(fixture.wires).toHaveLength(2)
    for (const wire of fixture.wires) expect(wire.predicate).toBe(DEFAULT_WIKILINK_PREDICATE)
  })

  it('the fixture loads with both chips inside the wires\' source block', () => {
    const { editor } = mount()
    const block = editor.view.dom.querySelector(`[data-block-id="${docWire.source_block_id}"]`)
    expect(block).not.toBeNull()
    expect(block!.contains(chip(editor, docWire.id))).toBe(true)
    expect(block!.contains(chip(editor, fileWire.id))).toBe(true)
    expect(fileWire.source_block_id).toBe(docWire.source_block_id)
  })

  it('a document chip opens the target document in the target graph', () => {
    const { editor, openDocument, clicks } = mount()
    click(chip(editor, docWire.id))
    expect(openDocument).toHaveBeenCalledTimes(1)
    expect(openDocument).toHaveBeenCalledWith(docWire.target_graph, docWire.target_id, undefined)
    expect(popover.calls).toHaveLength(0)
    // The kernel hands the wire id to the host's click handler.
    expect(clicks[0]).toMatchObject({ targetDocId: docWire.target_id, targetGraphId: docWire.target_graph, wireId: docWire.id })
  })

  it('a file chip opens through the file-link path with the artifact id, the wire id and the source block', () => {
    const { editor, openDocument } = mount()
    click(chip(editor, fileWire.id))
    expect(openDocument).not.toHaveBeenCalled()
    expect(popover.calls).toHaveLength(1)
    const [target] = popover.calls[0]! as [Record<string, unknown>]
    expect(target).toMatchObject({
      targetArtifactId: fileWire.target_id,
      wireId: fileWire.id,
      documentId: fixture.sourceDocumentId,
      anchorBlockId: fileWire.source_block_id,
    })
  })
})
