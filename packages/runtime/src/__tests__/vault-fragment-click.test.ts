/**
 * vault-fragment-click.test.ts: clicking a vault link to a heading or a ^block.
 *
 * The fixture comes from garden's vault import (Door 1), exported by the ignored
 * test export_fragment_click_fixture and round-tripped through a Rust Y.Doc.
 * Document A holds two chips: "the heading" and "the passage". Each points at a
 * different block of document B, and its wire carries the same target_block_id.
 * A click must open B at that block, and the block must exist in B.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureJson from './fixtures/vault-fragment-click.json'
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
  predicate: string
  source_block_id: string
  target_graph: string
  target_id: string
  target_block_id: string
  artifact: boolean
}
interface Fixture {
  sourceDocumentId: string
  targetDocumentId: string
  graphId: string
  document: Record<string, unknown>
  targetBlocks: { id: string; type: string; content: string }[]
  wires: FixtureWire[]
}

const fixture = fixtureJson as unknown as Fixture

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

describe('vault import fragment links: a click opens the target block', () => {
  it('the fixture pairs two chips with two different blocks of the target document', () => {
    expect(fixture.wires).toHaveLength(2)
    const targets = fixture.wires.map(w => w.target_block_id)
    expect(new Set(targets).size).toBe(2)
    for (const wire of fixture.wires) {
      expect(wire.artifact).toBe(false)
      expect(wire.predicate).toBe(DEFAULT_WIKILINK_PREDICATE)
      expect(wire.target_id).toBe(fixture.targetDocumentId)
      expect(fixture.targetBlocks.map(b => b.id)).toContain(wire.target_block_id)
    }
  })

  for (const index of [0, 1]) {
    it(`chip ${index + 1} opens the target document at its wire's target block`, () => {
      const wire = fixture.wires[index]!
      const { editor, openDocument, clicks } = mount()
      click(chip(editor, wire.id))
      expect(openDocument).toHaveBeenCalledTimes(1)
      expect(openDocument).toHaveBeenCalledWith(wire.target_graph, wire.target_id, wire.target_block_id)
      expect(popover.calls).toHaveLength(0)
      expect(clicks[0]).toMatchObject({ targetDocId: wire.target_id, targetBlockId: wire.target_block_id, wireId: wire.id })
    })
  }
})
