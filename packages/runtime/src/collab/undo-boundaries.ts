/**
 * undo-boundaries.ts — where one undo step ends and the next begins.
 *
 * The room's Y.UndoManager merges every local change made within its capture
 * timeout (500ms) into one undo step. Typing should merge; structure should
 * not. Eschaton's case (2026-11-17): three words, Enter, then toolbar Bold,
 * and one Cmd+Z took back all of it. A split (Enter), a mark toggle, a paste,
 * a drop or a cut is its own step, and so is the first edit after it.
 *
 * The rule reads ProseMirror steps by their JSON stepType, so the runtime does
 * not need @tiptap/pm as a dependency.
 */

/** The parts of a ProseMirror Transaction this rule reads. */
export interface UndoBoundaryTransaction {
  readonly docChanged: boolean
  readonly steps: ReadonlyArray<{ toJSON(): unknown }>
  getMeta(key: string): unknown
}

const MARK_STEPS = new Set(['addMark', 'removeMark', 'addNodeMark', 'removeNodeMark', 'attr', 'docAttr'])
const UI_EVENT_BOUNDARIES = new Set(['paste', 'drop', 'cut'])

interface StepJson {
  readonly stepType?: string
  readonly slice?: {
    readonly openStart?: number
    readonly openEnd?: number
    readonly content?: ReadonlyArray<{ readonly type?: string }>
  }
}

/** Inline content types: anything else in a replaced slice is a block. */
const INLINE_TYPES = new Set(['text', 'hardBreak', 'wikilink', 'image', 'mention', 'hashtag', 'emoji'])

function stepIsStructural(json: StepJson): boolean {
  const type = json.stepType
  if (!type) return false
  if (MARK_STEPS.has(type)) return true
  if (type === 'replaceAround') return true
  if (type !== 'replace') return false
  const slice = json.slice
  if (!slice) return false
  if ((slice.openStart ?? 0) > 0 || (slice.openEnd ?? 0) > 0) return true
  return (slice.content ?? []).some(node => node.type !== undefined && !INLINE_TYPES.has(node.type))
}

/** True when this transaction should start (and end) its own undo step. */
export function isUndoBoundary(tr: UndoBoundaryTransaction): boolean {
  if (!tr.docChanged) return false
  const uiEvent = tr.getMeta('uiEvent')
  if (typeof uiEvent === 'string' && UI_EVENT_BOUNDARIES.has(uiEvent)) return true
  return tr.steps.some(step => stepIsStructural(step.toJSON() as StepJson))
}

/** The manager surface this needs (Y.UndoManager has it). */
export interface CapturingUndoManager {
  stopCapturing(): void
}

/**
 * Before each transaction reaches Yjs: a boundary transaction closes the
 * current step and asks the next edit to start a fresh one too.
 */
export function createUndoBoundaryGate(manager: CapturingUndoManager): (tr: UndoBoundaryTransaction) => void {
  let closeNext = false
  return (tr) => {
    if (!tr.docChanged) return
    if (isUndoBoundary(tr)) {
      manager.stopCapturing()
      closeNext = true
      return
    }
    if (closeNext) {
      manager.stopCapturing()
      closeNext = false
    }
  }
}
