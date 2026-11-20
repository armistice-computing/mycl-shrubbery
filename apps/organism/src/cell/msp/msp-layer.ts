/**
 * msp-layer.ts — installs the meta-spread stage into the organism shell.
 *
 * Owns: the <msp-live-stage> element, the adapter that feeds it real data
 * (wire bundles + block text + search + candidates + wire creation, all over
 * the injected contract), and the keyboard entry Cmd+Opt+; → traversal on the
 * current document. (The craft entry is out of 1.0 by Eschaton's ruling.)
 *
 * Reads: SPARQL over the workspace projection (rest.query) for wires (the
 * runtime's makeWireBundleService) and block text (doc:textContent); the
 * source mirror for semantic candidates. Writes: contract.wire.create — the
 * cell's create_wires path; materialization syncs the panels and bubbles.
 */

import {
  makeWireBundleService,
  wikilinkBlockListSparql,
  wikilinkBlockTreeSparql,
  wikilinkBlocksInTreeOrder,
} from '@shrubbery/runtime'
import type { WireBundle, WireSummary } from '@shrubbery/runtime'
import type { ShrubberyContract } from '@shrubbery/nucleus'
import { loadDocumentSwitcherBlocks } from '../document-switcher.js'
import {
  type MspAdapter,
  type MspBlock,
  type MspLaneData,
  type MspSearchHit,
  type MspWire,
  type MspWireCommit,
} from './msp-stage.js'
import './msp-stage.js'
import type { MspLiveStage } from './msp-stage.js'

export interface MspLayerDeps {
  readonly doc: Document
  readonly getContract: () => ShrubberyContract | null
  readonly getGraphId: () => string
  readonly getDocumentId: () => string | null
  /** Sidebar documents for the finding column's browse list. */
  readonly listDocs: () => readonly { readonly id: string; readonly title: string }[]
  /** Open a document in the editor (optionally at a block). */
  readonly openDocument: (docId: string, blockId?: string) => void
  /** Restore focus to the editor after the veil closes (typing must not stay
   * trapped in the stage). */
  readonly restoreFocus?: () => void
  readonly log?: (line: string) => void
}

function escapeSparql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

function wireToMsp(w: WireSummary, direction: 'out' | 'in'): MspWire {
  return {
    id: w.id,
    predicate: w.predicate,
    predicateLabel: w.predicateLabel || w.predicate,
    direction,
    otherDocId: w.otherDocumentId,
    otherBlockId: w.otherBlockId ?? null,
    otherSnippet: (w.otherSnippet ?? '').trim(),
    otherTitle: (w.otherTitle ?? '').trim() || 'Untitled',
    bidirectional: w.bidirectional,
  }
}

function bundleToLane(documentId: string, title: string, bundle: WireBundle, blocks: readonly MspBlock[]): MspLaneData {
  const docWires: MspWire[] = []
  const blockWires = new Map<string, MspWire[]>()
  const attach = (w: MspWire, localBlockId: string | null) => {
    if (!localBlockId) docWires.push(w)
    else {
      const list = blockWires.get(localBlockId) ?? []
      blockWires.set(localBlockId, [...list, w])
    }
  }
  for (const w of bundle.outgoingWires) if (!w.otherArtifactId) attach(wireToMsp(w, 'out'), w.localBlockId ?? null)
  for (const w of bundle.incomingWires) attach(wireToMsp(w, 'in'), w.localBlockId ?? null)
  const wiredSet = new Set(blockWires.keys())
  const primaries = bundle.wiredBlockIds.filter(id => wiredSet.has(id))
  // Blocks wired only on the other side of the id-form divide still count.
  for (const id of wiredSet) if (!primaries.includes(id)) primaries.push(id)
  return { docId: documentId, title, blocks, docWires, blockWires, primaries }
}

/** Row values from the doc projection come literal-quoted ("\"block-xyz\"",
 * "\"some text\""); typed literals carry a ^^ suffix. Unwrap to the plain value. */
function plainLiteral(term: string | undefined): string {
  if (!term) return ''
  if (term.startsWith('"')) {
    const end = term.indexOf('"', 1)
    if (end > 0) return term.slice(1, end).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  return term
}

/** 'doc#Paragraph' IRI term → 'Paragraph'; '' stays ''. */
function localName(term: string | undefined): string {
  let t = plainLiteral(term)
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1)
  const cut = Math.max(t.lastIndexOf('#'), t.lastIndexOf('/'))
  return cut >= 0 ? t.slice(cut + 1) : t
}

export function installMspLayer(deps: MspLayerDeps): { element: MspLiveStage } {
  const el = document.createElement('msp-live-stage') as MspLiveStage

  const titles = new Map<string, string>()
  const refreshTitles = () => {
    for (const d of deps.listDocs()) titles.set(d.id, d.title || 'Untitled')
  }

  const adapter: MspAdapter = {
    async loadBlocks(docId) {
      const contract = deps.getContract()
      if (!contract) return []
      const graphId = deps.getGraphId()
      // The runtime's own readers: the per-doc tree walk gives each block once
      // and in true reading order (the old single-siblingOrder query rendered
      // list items twice and scrambled nested lists — Delta's blocker 3a).
      const [blockRows, treeRows] = await Promise.all([
        contract.rest.query(graphId, wikilinkBlockListSparql(graphId, docId)) as Promise<{ rows?: Record<string, string>[] }>,
        (contract.rest.query(graphId, wikilinkBlockTreeSparql(graphId, docId)) as Promise<{ rows?: Record<string, string>[] }>)
          .catch(() => ({ rows: [] })),
      ])
      const items = wikilinkBlocksInTreeOrder(blockRows.rows ?? [], treeRows.rows ?? [])
      return items.map(item => ({
        id: item.id,
        text: item.text,
        // msp's role band uses the TipTap-style capitalized type; the runtime
        // emits lowercase 'heading'.
        type: item.type === 'heading' ? 'Heading' : item.type[0]?.toUpperCase() + item.type.slice(1),
        level: item.type === 'heading' ? item.level : undefined,
      })) as MspBlock[]
    },

    async loadLane(docId) {
      const contract = deps.getContract()
      if (!contract) throw new Error('no contract')
      const graphId = deps.getGraphId()
      const bundles = makeWireBundleService(contract.rest)
      const [bundle, blocks] = await Promise.all([
        bundles.loadBundle(graphId, docId),
        this.loadBlocks(docId),
      ])
      return bundleToLane(docId, this.docTitle(docId), bundle, blocks)
    },

    async searchBlocks(query) {
      const contract = deps.getContract()
      if (!contract) return []
      const graphId = deps.getGraphId()
      const items = await loadDocumentSwitcherBlocks(contract.rest, graphId, query, 'smart')
      return items.map(item => ({
        docId: item.documentId,
        docTitle: item.label,
        blockId: item.blockId,
        text: item.snippet ?? '',
        kind: 'lexical' as const,
      }))
    },

    async loadCandidates(originDocId, originText) {
      const contract = deps.getContract()
      // sourceMirror lives on the concrete GardendContract, off the interface.
      const mirror = (contract as unknown as { sourceMirror?: {
        semanticSearch(graphId: string, query: string, limit: number): readonly {
          documentId: string; documentTitle: string; blockId: string; content: string
        }[] | undefined
      } } | null)?.sourceMirror
      if (!mirror || !originText.trim()) return []
      const graphId = deps.getGraphId()
      const hits = mirror.semanticSearch(graphId, originText, 12) ?? []
      return hits
        .filter(h => h.documentId !== originDocId)
        .slice(0, 4)
        .map(h => ({
          docId: h.documentId,
          docTitle: h.documentTitle || 'Untitled',
          blockId: h.blockId,
          text: h.content.slice(0, 240),
          kind: 'candidate' as const,
        }))
    },

    async createWire(input: MspWireCommit) {
      const contract = deps.getContract()
      if (!contract) throw new Error('no contract')
      const graphId = deps.getGraphId()
      await contract.wire.create(graphId, {
        sourceDocumentId: input.sourceDocId,
        sourceBlockId: input.sourceBlockId ?? undefined,
        targetDocumentId: input.targetDocId,
        targetBlockId: input.targetBlockId ?? undefined,
        predicate: input.predicate,
        bidirectional: false,
      })
    },

    listDocs() {
      refreshTitles()
      return deps.listDocs()
    },

    docTitle(docId) {
      if (!titles.size) refreshTitles()
      return titles.get(docId) ?? 'Untitled'
    },
  }

  el.adapter = adapter
  el.style.display = 'none'
  deps.doc.body.appendChild(el)

  const syncVisibility = () => {
    el.style.display = ''
  }

  el.addEventListener('msp-open', syncVisibility)
  el.addEventListener('msp-open-document', ((event: CustomEvent<{ docId: string; blockId: string | null }>) => {
    deps.openDocument(event.detail.docId, event.detail.blockId ?? undefined)
  }) as EventListener)
  el.addEventListener('msp-close', () => {
    deps.restoreFocus?.()
  })
  el.addEventListener('msp-created', () => {
    deps.log?.('msp: wire created')
  })
  el.addEventListener('msp-write-failed', () => {
    deps.log?.('msp: wire write FAILED')
  })

  // Cmd+Opt+; — traversal on the current document. event.code (physical key)
  // rather than event.key: Opt+; on a US Mac layout produces '…', not ';'.
  deps.doc.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.repeat) return
    if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) return
    if (event.code !== 'Semicolon') return
    const docId = deps.getDocumentId()
    if (!docId) return
    event.preventDefault()
    event.stopPropagation()
    syncVisibility()
    el.openTraverse(docId)
  }, true)

  // The craft entry (Cmd+Shift+;) is OUT of 1.0 (Eschaton's ruling): the
  // craft code stays for the visual-wire-mode follow-up, but no entry point
  // ships, and the advanced wire menu is NOT shadowed.

  return { element: el }
}
