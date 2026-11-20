/**
 * The pinned cards of one graph, kept on this device so they come back after
 * a restart (Eschaton, 2026-11-18).
 *
 * One localStorage entry per graph. The host writes it on every change to the
 * pins (pin, close, move, resize, edit), never at quit: WebKit can drop a
 * localStorage write made while the window closes. Reading is defensive,
 * because the entry may come from an older build or be hand-edited: anything
 * that does not look like a pin is left out, never thrown.
 */
import type {
  PinnedWireBlock,
  PinnedWireDocument,
  PinnedWireNode,
} from '@shrubbery/runtime'

export const PINNED_BOARD_KEY_PREFIX = 'mycl.pins.v1:'

export interface PinnedBoard {
  readonly docs: readonly PinnedWireDocument[]
  readonly nodes: readonly PinnedWireNode[]
  readonly blocks: readonly PinnedWireBlock[]
}

export const EMPTY_PINNED_BOARD: PinnedBoard = { docs: [], nodes: [], blocks: [] }

type BoardStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function pinnedBoardKey(graphId: string): string {
  return `${PINNED_BOARD_KEY_PREFIX}${graphId}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const anyStr = (value: unknown): value is string => typeof value === 'string'
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const optNum = (value: unknown): boolean => value === undefined || num(value)
const optBlock = (value: unknown): boolean => value === undefined || value === null || anyStr(value)

function sized<T extends { width?: number; height?: number }>(raw: Record<string, unknown>, item: T): T {
  return {
    ...item,
    ...(num(raw.width) ? { width: raw.width } : {}),
    ...(num(raw.height) ? { height: raw.height } : {}),
  }
}

function readDoc(raw: unknown, graphId: string): PinnedWireDocument | null {
  if (!isRecord(raw)) return null
  if (!str(raw.id) || raw.graphId !== graphId || !str(raw.documentId) || !anyStr(raw.title)) return null
  if (!num(raw.x) || !num(raw.y) || !optNum(raw.width) || !optNum(raw.height)) return null
  return sized<PinnedWireDocument>(raw, { id: raw.id, graphId, documentId: raw.documentId, title: raw.title, x: raw.x, y: raw.y })
}

function readBlock(raw: unknown, graphId: string): PinnedWireBlock | null {
  if (!isRecord(raw)) return null
  if (!str(raw.id) || raw.graphId !== graphId || !str(raw.documentId) || !str(raw.blockId)) return null
  if (!anyStr(raw.text) || !anyStr(raw.documentTitle)) return null
  if (!num(raw.x) || !num(raw.y) || !optNum(raw.width) || !optNum(raw.height)) return null
  return sized<PinnedWireBlock>(raw, {
    id: raw.id,
    graphId,
    documentId: raw.documentId,
    blockId: raw.blockId,
    text: raw.text,
    documentTitle: raw.documentTitle,
    x: raw.x,
    y: raw.y,
  })
}

function readNode(raw: unknown, graphId: string): PinnedWireNode | null {
  if (!isRecord(raw)) return null
  if (!str(raw.id) || !str(raw.wireId) || raw.graphId !== graphId) return null
  if (!str(raw.predicate) || !anyStr(raw.predicateLabel) || typeof raw.bidirectional !== 'boolean') return null
  if (!str(raw.sourceGraphId) || !str(raw.sourceDocumentId) || !optBlock(raw.sourceBlockId)) return null
  if (!str(raw.targetGraphId) || !str(raw.targetDocumentId) || !optBlock(raw.targetBlockId)) return null
  if (!anyStr(raw.sourceTitle) || !anyStr(raw.sourceText) || !anyStr(raw.targetTitle) || !anyStr(raw.targetText)) return null
  if (!num(raw.x) || !num(raw.y) || !optNum(raw.width) || !optNum(raw.height)) return null
  if (raw.topIsSource !== undefined && typeof raw.topIsSource !== 'boolean') return null
  return sized<PinnedWireNode>(raw, {
    id: raw.id,
    wireId: raw.wireId,
    graphId,
    predicate: raw.predicate,
    predicateLabel: raw.predicateLabel,
    bidirectional: raw.bidirectional,
    sourceGraphId: raw.sourceGraphId,
    sourceDocumentId: raw.sourceDocumentId,
    sourceBlockId: (raw.sourceBlockId as string | null | undefined) ?? null,
    sourceTitle: raw.sourceTitle,
    sourceText: raw.sourceText,
    targetGraphId: raw.targetGraphId,
    targetDocumentId: raw.targetDocumentId,
    targetBlockId: (raw.targetBlockId as string | null | undefined) ?? null,
    targetTitle: raw.targetTitle,
    targetText: raw.targetText,
    x: raw.x,
    y: raw.y,
    ...(typeof raw.topIsSource === 'boolean' ? { topIsSource: raw.topIsSource } : {}),
  })
}

function readList<T>(raw: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const item of raw) {
    const value = read(item)
    if (value) out.push(value)
  }
  return out
}

/** The saved pins of `graphId`, or none. A pin saved for another graph is never returned. */
export function readPinnedBoard(storage: BoardStorage | null, graphId: string): PinnedBoard {
  if (!storage || !graphId) return EMPTY_PINNED_BOARD
  let text: string | null = null
  try {
    text = storage.getItem(pinnedBoardKey(graphId))
  } catch {
    return EMPTY_PINNED_BOARD
  }
  if (!text) return EMPTY_PINNED_BOARD
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return EMPTY_PINNED_BOARD
  }
  if (!isRecord(parsed)) return EMPTY_PINNED_BOARD
  return {
    docs: readList(parsed.docs, (item) => readDoc(item, graphId)),
    nodes: readList(parsed.nodes, (item) => readNode(item, graphId)),
    blocks: readList(parsed.blocks, (item) => readBlock(item, graphId)),
  }
}

/** Save the pins of `graphId`. No pins removes the entry. Best effort: a full or blocked store is ignored. */
export function writePinnedBoard(storage: BoardStorage | null, graphId: string, board: PinnedBoard): void {
  if (!storage || !graphId) return
  try {
    if (board.docs.length === 0 && board.nodes.length === 0 && board.blocks.length === 0) {
      storage.removeItem(pinnedBoardKey(graphId))
      return
    }
    storage.setItem(pinnedBoardKey(graphId), JSON.stringify({
      docs: board.docs,
      nodes: board.nodes,
      blocks: board.blocks,
    }))
  } catch {
    /* best effort */
  }
}
