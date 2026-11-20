/**
 * doc-level-wire-fan.test.ts — a wire that belongs to the DOCUMENT.
 *
 * THE GAP. Block-level wires announce themselves: the block grows a pulsing
 * accent dot in the left gutter, and hovering it fans the wires out. A wire
 * with no `localBlockId` belongs to the document as a whole, has no block to
 * sit beside, and appeared NOWHERE — measured in the running app against a real
 * cell, a document holding one of each rendered one gutter bubble and no trace
 * at all of the other.
 *
 * Two decisions, both of which were the bug:
 *
 *   1. WHICH wires are document-level. `_wiresForBlock` filtered
 *      `!!wire.localBlockId` unconditionally, so document-level wires were
 *      excluded from every surface in the app. The rule now lives once, beside
 *      the bundle (`documentLevelWires`), because the pane header draws its
 *      bubble from the same rule and a second copy would drift.
 *
 *   2. That a NULL overlay target means DOCUMENT LEVEL, not "closed". The
 *      render gate read `!this.wireOverlayBlockId` as "nothing to draw", which
 *      is exactly the reading that keeps a doc-level fan unreachable however
 *      much of the rest of it exists.
 *
 * WHERE THE BUBBLE IS: the pane header's status dot — cloud-1's info-bar
 * indicator, which was never retired. Its colour channel says which pane is
 * active; its ring channel was free, and this is what it was for.
 *
 * happy-dom applies no CSS and computes no layout, so nothing here proves the
 * dot is visible, ringed, or animated. That half is proved in real Chromium by
 * `apps/organism/scripts/punchlist-sidebar-and-doc-wire-browser.mts`. Keeping
 * the division explicit matters: a unit test that quietly claims the visual
 * half is how wire highlighting passed for months while showing nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { render, html } from 'lit'
import '../../../components/src/mn-editor-toolbar.js'
import '../../../components/src/mn-input-dialog.js'
import '../center-panes-host.js'
import type { ShCenterPanes } from '../center-panes-host.js'
import { createCenterPanesState, projectCenterPanes, openCenterPane } from '../center-panes-model.js'
import {
  NULL_EDITOR_HOST_STATE,
  type EditorHostBinding,
  type EditorHostState,
} from '../editor-host-binding.js'
import type { ShEditorHost } from '../editor-host.js'
import type { WireBundle } from '../editor-services/wire-bundle-service.js'
import { InProcessCrdtBackend } from './in-process-crdt-backend.js'

interface SettableBinding extends EditorHostBinding {
  set(next: EditorHostState): void
}

function makeBinding(initial: EditorHostState = NULL_EDITOR_HOST_STATE): SettableBinding {
  let value = initial
  const subs = new Set<(v: EditorHostState) => void>()
  return {
    get: () => value,
    subscribe(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    set(next) {
      value = next
      for (const cb of subs) cb(value)
    },
  }
}

let backends: InProcessCrdtBackend[] = []

afterEach(() => {
  for (const be of backends) be.destroyAll()
  backends = []
  document.body.replaceChildren()
})

/** One block-level wire and two document-level ones — the shape the browser
 *  harness seeds against a real cell, plus an incoming wire, because the
 *  original filter dropped document-level wires from both directions. */
function mixedBundle(): WireBundle {
  return {
    outgoingWires: [
      {
        id: 'wire-block',
        predicate: 'http://mnemosyne.ai/vocab#supports',
        predicateLabel: 'supports',
        otherDocumentId: 'doc-target',
        otherGraphId: 'g-docwire',
        localBlockId: 'block-alpha',
        otherTitle: 'Target document',
        bidirectional: false,
      },
      {
        id: 'wire-document',
        predicate: 'http://mnemosyne.ai/vocab#relatedTo',
        predicateLabel: 'relatedTo',
        otherDocumentId: 'doc-target',
        otherGraphId: 'g-docwire',
        otherTitle: 'Target document',
        bidirectional: false,
      },
    ],
    incomingWires: [
      {
        id: 'wire-document-incoming',
        predicate: 'http://mnemosyne.ai/vocab#qualifies',
        predicateLabel: 'qualifies',
        otherDocumentId: 'doc-source',
        otherGraphId: 'g-docwire',
        otherTitle: 'Source document',
        bidirectional: false,
      },
    ],
    wiredBlockIds: ['block-alpha'],
  } as WireBundle
}

function blockOnlyBundle(): WireBundle {
  return {
    outgoingWires: [
      {
        id: 'wire-block',
        predicate: 'http://mnemosyne.ai/vocab#supports',
        predicateLabel: 'supports',
        otherDocumentId: 'doc-target',
        otherGraphId: 'g-docwire',
        localBlockId: 'block-alpha',
        otherTitle: 'Target',
        bidirectional: false,
      },
    ],
    incomingWires: [],
    wiredBlockIds: ['block-alpha'],
  } as WireBundle
}

async function mountPanes(bundle: WireBundle | null): Promise<ShCenterPanes> {
  const be = new InProcessCrdtBackend()
  backends.push(be)
  const provider = be.open({ kind: 'doc', graphId: 'g-docwire', docId: 'd-docwire' })
  const binding = makeBinding({
    centerMode: 'document',
    graphId: 'g-docwire',
    documentId: 'd-docwire',
    status: 'ready',
    error: null,
    provider,
  })
  const state = openCenterPane(createCenterPanesState(), {
    paneId: 'center-primary',
    placement: 'active',
    location: {
      kind: 'document',
      graphId: 'g-docwire',
      documentId: 'd-docwire',
      title: 'Wire source',
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  render(
    html`<sh-center-panes
      .projection=${projectCenterPanes(state)}
      .editorHosts=${new Map([['center-primary', { binding, wireBundle: bundle }]])}
    ></sh-center-panes>`,
    container,
  )
  const panes = container.querySelector('sh-center-panes') as ShCenterPanes
  await panes.updateComplete
  await Promise.resolve()
  await panes.updateComplete
  return panes
}

function bubble(panes: ShCenterPanes): HTMLElement | null {
  return panes.renderRoot.querySelector('[data-pane-wire-bubble]') as HTMLElement | null
}

function plainDot(panes: ShCenterPanes): HTMLElement | null {
  return panes.renderRoot.querySelector('.pane-header > .pane-position') as HTMLElement | null
}

describe('the pane status dot becomes a bubble only when the document is wired', () => {
  it('counts the wires with no local block, in BOTH directions', async () => {
    const panes = await mountPanes(mixedBundle())
    const el = bubble(panes)
    expect(el).not.toBeNull()
    // Three wires; one names a block. Two belong to the document.
    expect(el!.getAttribute('data-doc-wire-count')).toBe('2')
    expect(el!.getAttribute('aria-label')).toContain('2 document wires')
    expect(el!.querySelector('.pane-position')?.getAttribute('data-doc-wired')).toBe('true')
  })

  it('a document whose wires ALL name blocks keeps the plain dot', async () => {
    const panes = await mountPanes(blockOnlyBundle())
    expect(bubble(panes)).toBeNull()
    // Not merely un-ringed — not interactive at all, so it cannot offer an
    // empty fan.
    expect(plainDot(panes)).not.toBeNull()
  })

  it('no bundle at all keeps the plain dot and does not throw', async () => {
    const panes = await mountPanes(null)
    expect(bubble(panes)).toBeNull()
    expect(plainDot(panes)).not.toBeNull()
  })

  it('one wire reads singular — this label is spoken aloud', async () => {
    const panes = await mountPanes({
      outgoingWires: [],
      incomingWires: [
        {
          id: 'only',
          predicate: 'http://mnemosyne.ai/vocab#relatedTo',
          predicateLabel: 'relatedTo',
          otherDocumentId: 'doc-source',
          otherGraphId: 'g-docwire',
          otherTitle: 'Source',
          bidirectional: false,
        },
      ],
      wiredBlockIds: [],
    } as WireBundle)
    expect(bubble(panes)!.getAttribute('aria-label')).toContain('1 document wire —')
  })
})

describe('a null overlay target is the DOCUMENT level, not closed', () => {
  it('hovering the bubble opens a fan holding exactly the document-level wires', async () => {
    const panes = await mountPanes(mixedBundle())
    const host = panes.renderRoot.querySelector('sh-editor-host') as ShEditorHost
    await host.updateComplete
    expect(host.shadowRoot!.querySelector('mn-wire-radial-overlay')).toBeNull()

    bubble(panes)!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    await host.updateComplete

    const overlay = host.shadowRoot!.querySelector('mn-wire-radial-overlay') as
      | (HTMLElement & { wires: ReadonlyArray<{ id: string }> })
      | null
    expect(overlay).not.toBeNull()
    // NOT the block-level wire. A fan showing everything would make the two
    // treatments indistinguishable, which is the state this change exists to
    // leave behind.
    expect(overlay!.wires.map((wire) => wire.id).sort()).toEqual([
      'wire-document',
      'wire-document-incoming',
    ])
  })

  it('the fan opens on keyboard focus too, not only on hover', async () => {
    const panes = await mountPanes(mixedBundle())
    const host = panes.renderRoot.querySelector('sh-editor-host') as ShEditorHost
    await host.updateComplete
    bubble(panes)!.dispatchEvent(new FocusEvent('focus', { bubbles: false }))
    await host.updateComplete
    expect(host.shadowRoot!.querySelector('mn-wire-radial-overlay')).not.toBeNull()
  })

  it('the editor host refuses to open an empty fan', async () => {
    const panes = await mountPanes(blockOnlyBundle())
    const host = panes.renderRoot.querySelector('sh-editor-host') as ShEditorHost
    await host.updateComplete
    expect(host.openDocumentWireFan(10, 10)).toBe(false)
    await host.updateComplete
    expect(host.shadowRoot!.querySelector('mn-wire-radial-overlay')).toBeNull()
  })
})
