/**
 * inspector-projection.ts — shell-side pure projection for the right rail.
 *
 * Garden's inspector derives its model from the selected-object bus plus the
 * already-loaded active document data. This keeps the same no-extra-fetch rule:
 * if the selected object is not in the active document, relations are marked
 * inactive instead of faking a read.
 */

import type { SelectedObject } from '@shrubbery/nucleus'
import type { ChronicleActor, DocumentChronicle } from './document-chronicle.js'
import type {
  WireBundle,
  WireSummary,
  WorkspaceComment,
  WorkspaceInspectorAction,
  WorkspaceInspectorIdentityChip,
  WorkspaceInspectorModel,
  WorkspaceInspectorRelationGroup,
  WorkspaceInspectorRelationItem,
  WorkspaceInspectorRelations,
} from '@shrubbery/runtime'

export interface InspectorProjectionInput {
  readonly selection: SelectedObject | null
  readonly graphId: string | null
  readonly graphTitle?: string | null
  readonly activeDocumentId: string | null
  readonly activeDocumentTitle?: string | null
  readonly wireBundle?: WireBundle | null
  readonly comments?: readonly WorkspaceComment[]
  /**
   * The active document's authorship record, when the host has one. Same
   * no-extra-fetch rule as `wireBundle`: the shell loads it, the projection only
   * reads it, and a null means "not loaded / not a cell" rather than "nobody".
   */
  readonly chronicle?: DocumentChronicle | null
}

function valueOf(selection: SelectedObject, key: string): string | undefined {
  const value = selection[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function truncate(value: string, max: number): string {
  const text = value.trim()
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/**
 * An actor label as a person would say it.
 *
 * `human:owner` becomes "you" and not "owner": this is a one-owner local node,
 * so the only human in the record IS the reader — and the Chronicle's own
 * standing rule (document_chronicle.rs:31-33) is that agents and system
 * integrity get stamped while humans are "surfaced minimally". Naming the reader
 * back at herself on every row is the opposite of minimal.
 *
 * `system:*` drops the prefix and unhyphenates, because "archive-import" is the
 * name of a code path and "import" is the name of the thing that happened.
 */
export function chronicleActorLabel(actor: ChronicleActor | null | undefined): string | null {
  if (!actor) return null
  if (actor.kind === 'human') return actor.name === 'owner' ? 'you' : actor.name
  if (actor.kind === 'agent') return actor.name.charAt(0).toUpperCase() + actor.name.slice(1)
  if (actor.kind === 'system') return actor.name.replace(/-/g, ' ')
  return actor.label || null
}

/**
 * Provenance wants a DATE, not "yesterday". A relative string re-reads
 * differently every time you look at it and cannot be lined up against anything
 * else on screen, and this panel's job is to be a receipt. Absolute also keeps
 * the projection pure — no `now` to inject, so its tests stay deterministic.
 */
export function chronicleWhen(millis: number | null | undefined): string | null {
  if (millis == null || !Number.isFinite(millis)) return null
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function chronicleEvent(millis: number | null, actor: ChronicleActor | null): string | null {
  const when = chronicleWhen(millis)
  const who = chronicleActorLabel(actor)
  if (when && who) return `${when} \u00b7 ${who}`
  return when ?? who
}

/**
 * The chronicle chips, ordered by the questions they answer: how many times has
 * this been written, when was it last written and by whom, when did it start.
 *
 * Every chip is OMITTED rather than filled with a placeholder. A document
 * written before the Chronicle landed knows its clocks and not its authors, and
 * the cell's rule is that an unknown creator is never guessed — so a missing
 * author shows as a bare date, and a chronicle with nothing in it adds no rows
 * at all. An inspector reading "Created by unknown" on 1,075 imported documents
 * is noise wearing the clothes of information.
 */
function chronicleChips(
  chronicle: DocumentChronicle | null | undefined,
): WorkspaceInspectorIdentityChip[] {
  if (!chronicle) return []
  const chips: WorkspaceInspectorIdentityChip[] = []

  if (chronicle.revision != null) {
    chips.push({ label: 'Revision', value: String(chronicle.revision) })
  }

  const updated = chronicleEvent(chronicle.updatedAt, chronicle.updatedBy)
  if (updated) chips.push({ label: 'Updated', value: updated })

  // `createdAtSource: 'import'` means the clock IS the import instant — the
  // machine's guess, not a birthday. Every document carried out of the old house
  // reads this way (all 1,075 were "born" the afternoon of 2026-09-05), so the
  // label says Imported rather than lending that instant an authority it has not
  // got.
  const imported = chronicle.createdAtSource === 'import'
  const created = chronicleEvent(chronicle.createdAt, chronicle.createdBy)
  if (created) chips.push({ label: imported ? 'Imported' : 'Created', value: created })

  // The staleness-guard trail, and the reason this panel earns its space: a
  // forced write is someone writing past what they had last read. It is absent
  // on a clean document, so its PRESENCE is the whole signal — never render a
  // zero, or the one row that means something becomes furniture.
  if (chronicle.forcedWrites > 0) {
    const forcedBy = chronicleActorLabel(chronicle.lastForcedBy)
    const times = chronicle.forcedWrites === 1 ? 'once' : `${chronicle.forcedWrites}\u00d7`
    chips.push({
      label: 'Forced',
      value: forcedBy ? `${times} \u00b7 last by ${forcedBy}` : times,
    })
  }

  return chips
}

function documentTitle(input: InspectorProjectionInput, documentId: string): string {
  return documentId === input.activeDocumentId
    ? input.activeDocumentTitle || documentId
    : documentId
}

function allWires(bundle: WireBundle | null | undefined): readonly WireSummary[] {
  return bundle ? [...bundle.outgoingWires, ...bundle.incomingWires] : []
}

/**
 * The open document's wire count for its info page: every wire with an end in
 * this document, outgoing plus incoming. A wire between two of its own blocks
 * shows on both lists but counts once.
 */
export function wireCountChip(bundle: WireBundle | null | undefined): WorkspaceInspectorIdentityChip | null {
  if (!bundle) return null
  const outgoing = new Set(bundle.outgoingWires.map((wire) => wire.id))
  const incoming = new Set(bundle.incomingWires.map((wire) => wire.id))
  const total = new Set([...outgoing, ...incoming]).size
  if (total === 0) return { label: 'Wires', value: 'none yet' }
  return { label: 'Wires', value: `${total} \u00b7 ${outgoing.size} out, ${incoming.size} in` }
}

function changesLabel(writes: number): string {
  return writes === 1 ? '1 change' : `${writes} changes`
}

/**
 * Who has changed this document, most recent first (the chronicle's
 * recentAuthors, capped at 8 by the cell). This is how a person sees what
 * their agent did (Eschaton, 2026-11-17, triage T5): the panel used to repeat
 * the document's wires and comments, which have their own homes.
 */
export function documentHistory(chronicle: DocumentChronicle | null | undefined): WorkspaceInspectorRelations {
  const items: WorkspaceInspectorRelationItem[] = (chronicle?.recentAuthors ?? [])
    .map((entry, index): WorkspaceInspectorRelationItem | null => {
      const who = chronicleActorLabel(entry.actor)
      if (!who) return null
      const when = chronicleWhen(entry.lastAt)
      return {
        id: `change-${index}-${entry.actor.label}`,
        primary: who.charAt(0).toUpperCase() + who.slice(1),
        secondary: [changesLabel(entry.writes), when ? `last ${when}` : null].filter(Boolean).join(' \u00b7 '),
        icon: entry.actor.kind === 'agent' ? 'bot' : 'user',
      }
    })
    .filter((item): item is WorkspaceInspectorRelationItem => item !== null)
  const groups: WorkspaceInspectorRelationGroup[] = items.length > 0
    ? [{ key: 'changes', label: '', icon: 'history', items, static: true }]
    : []
  return {
    scope: 'active',
    label: 'Recent changes',
    icon: 'history',
    emptyText: chronicle ? 'No changes recorded yet.' : 'History is not available for this document.',
    groups,
  }
}

function selectedDocumentId(selection: SelectedObject | null): string | null {
  if (!selection) return null
  if (selection.kind === 'document' || selection.kind === 'block' || selection.kind === 'comment') {
    return valueOf(selection, 'documentId') ?? null
  }
  return null
}

export function projectInspectorModel(input: InspectorProjectionInput): WorkspaceInspectorModel | null {
  const selection = input.selection
  if (!selection) return null

  if (selection.kind === 'document') {
    const documentId = valueOf(selection, 'documentId') ?? input.activeDocumentId ?? 'unknown-document'
    const active = documentId === input.activeDocumentId
    return {
      identity: {
        kind: 'document',
        icon: 'file-text',
        title: documentTitle(input, documentId),
        typeLabel: 'Document',
        // Provenance first, addressing last. The two ULIDs are for copying into
        // a tool; the chronicle is for reading. They were the only two rows here
        // before, which made the panel a nameplate rather than an inspector.
        //
        // Chronicle rows only for the ACTIVE document: the host loads one
        // chronicle, for the document that is open. Showing another document's
        // selection with the open document's authorship would be a lie that
        // looks like data.
        chips: [
          ...(active ? chronicleChips(input.chronicle) : []),
          ...(active ? [wireCountChip(input.wireBundle)].filter((chip): chip is WorkspaceInspectorIdentityChip => chip !== null) : []),
          { label: 'Graph', value: valueOf(selection, 'graphId') ?? input.graphId ?? '', mono: true },
          { label: 'Document', value: documentId, mono: true },
        ],
      },
      relations: active
        ? documentHistory(input.chronicle)
        : { scope: 'inactive', label: 'Recent changes', icon: 'history', inactiveText: 'Open this document to see its history.', groups: [] },
    }
  }

  if (selection.kind === 'comment') {
    const commentId = valueOf(selection, 'commentId') ?? 'unknown-comment'
    const comment = (input.comments ?? []).find((item) => item.id === commentId)
    const documentId = valueOf(selection, 'documentId') ?? input.activeDocumentId ?? 'unknown-document'
    return {
      identity: {
        kind: 'comment',
        icon: 'message-square',
        title: truncate(comment?.text || 'Comment', 60),
        typeLabel: comment?.author ? `Comment by ${comment.author}` : 'Comment',
        chips: [
          { label: 'Graph', value: valueOf(selection, 'graphId') ?? input.graphId ?? '', mono: true },
          { label: 'Document', value: documentId, mono: true },
          { label: 'Comment', value: commentId, mono: true },
          ...(comment ? [{ label: 'Status', value: comment.resolved ? 'resolved' : 'open' }] : []),
        ],
      },
      relations: { scope: 'none', groups: [] },
    }
  }

  if (selection.kind === 'block') {
    const documentId = valueOf(selection, 'documentId') ?? input.activeDocumentId ?? 'unknown-document'
    const blockId = valueOf(selection, 'blockId') ?? 'unknown-block'
    return {
      identity: {
        kind: 'block',
        icon: 'hash',
        title: `Block in ${documentTitle(input, documentId)}`,
        typeLabel: 'Block',
        chips: [
          { label: 'Graph', value: valueOf(selection, 'graphId') ?? input.graphId ?? '', mono: true },
          { label: 'Document', value: documentId, mono: true },
          { label: 'Block', value: blockId, mono: true },
        ],
      },
      relations: { scope: 'none', groups: [] },
    }
  }

  if (selection.kind === 'wire') {
    const wireId = valueOf(selection, 'wireId') ?? 'unknown-wire'
    const wire = allWires(input.wireBundle).find((item) => item.id === wireId)
    return {
      identity: {
        kind: 'wire',
        icon: 'wire',
        title: wire ? `${wire.predicateLabel} -> ${wire.otherTitle || wire.otherDocumentId}` : 'Wire',
        typeLabel: 'Wire',
        chips: [
          { label: 'Graph', value: valueOf(selection, 'graphId') ?? input.graphId ?? '', mono: true },
          { label: 'Wire', value: wireId, mono: true },
          ...(wire?.bidirectional ? [{ label: 'Direction', value: 'bidirectional' }] : []),
        ],
      },
      relations: { scope: 'none', groups: [] },
    }
  }

  if (selection.kind === 'graph') {
    const graphId = valueOf(selection, 'graphId') ?? input.graphId ?? 'unknown-graph'
    return {
      identity: {
        kind: 'graph',
        icon: 'graph-star',
        title: input.graphTitle || graphId,
        typeLabel: 'Graph',
        chips: [{ label: 'Graph', value: graphId, mono: true }],
      },
      relations: { scope: 'none', groups: [] },
    }
  }

  if (selection.kind === 'folder') {
    const graphId = valueOf(selection, 'graphId') ?? input.graphId ?? 'unknown-graph'
    const folderId = valueOf(selection, 'folderId') ?? 'unknown-folder'
    return {
      identity: {
        kind: 'folder',
        icon: 'folder',
        title: valueOf(selection, 'label') ?? folderId,
        typeLabel: 'Folder',
        chips: [
          { label: 'Graph', value: graphId, mono: true },
          { label: 'Folder', value: folderId, mono: true },
        ],
      },
      relations: { scope: 'none', groups: [] },
    }
  }

  if (selection.kind === 'artifact') {
    const graphId = valueOf(selection, 'graphId') ?? input.graphId ?? 'unknown-graph'
    const artifactId = valueOf(selection, 'artifactId') ?? 'unknown-artifact'
    const mimeType = valueOf(selection, 'mimeType')
    const status = valueOf(selection, 'status')
    const ingestedDocumentId = valueOf(selection, 'ingestedDocumentId')
    return {
      identity: {
        kind: 'artifact',
        icon: 'diamond',
        title: valueOf(selection, 'label') ?? artifactId,
        typeLabel: 'File',
        chips: [
          { label: 'Graph', value: graphId, mono: true },
          { label: 'Artifact', value: artifactId, mono: true },
          ...(mimeType ? [{ label: 'MIME', value: mimeType }] : []),
          ...(status ? [{ label: 'Status', value: status }] : []),
          ...(ingestedDocumentId ? [{ label: 'Ingested doc', value: ingestedDocumentId, mono: true }] : []),
        ],
      },
      relations: { scope: 'none', groups: [] },
    }
  }

  const graphId = valueOf(selection, 'graphId') ?? input.graphId ?? 'unknown-graph'
  return {
    identity: {
      kind: selection.kind,
      icon: 'info',
      title: selection.kind,
      typeLabel: 'Object',
      chips: [{ label: 'Graph', value: graphId, mono: true }],
    },
    relations: { scope: 'none', groups: [] },
  }
}

export function projectInspectorActions(input: InspectorProjectionInput): readonly WorkspaceInspectorAction[] {
  const selection = input.selection
  if (!selection || selection.kind !== 'comment') return []
  const commentId = valueOf(selection, 'commentId')
  const comment = commentId ? (input.comments ?? []).find((item) => item.id === commentId) : null
  if (!comment) return []
  return [
    { type: 'header', content: 'Comment' },
    {
      id: 'comment.resolve',
      label: comment.resolved ? 'Reopen comment' : 'Resolve comment',
      icon: comment.resolved ? 'undo' : 'check',
    },
    {
      id: 'comment.delete',
      label: 'Delete comment',
      icon: 'trash',
      variant: 'danger',
    },
  ]
}

export function activeDocumentSelection(
  graphId: string | null,
  documentId: string | null,
): SelectedObject | null {
  return graphId && documentId ? { kind: 'document', graphId, documentId } : null
}

export function selectionDocumentId(selection: SelectedObject | null): string | null {
  return selectedDocumentId(selection)
}
