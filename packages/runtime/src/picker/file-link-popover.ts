/**
 * file-link-popover.ts — open the popover for a clicked file link.
 *
 * One `mn-file-link-popover` per document, placed under the chip, filled from the
 * cell's read of the region (read_artifact by wire id) through the wire service. Its
 * one write is the pull button: insert_blocks with the file as the source, after the
 * chip's block, with a minted operation id so a second click cannot pull twice.
 * A click outside, Escape or Close removes it. The element is
 * registered by @shrubbery/components; this module only names its tag, as the picker
 * glue does with mn-wikilink-picker.
 */

import type { WireService } from '../editor-services/wire-service.js'
import { fileLinkPullOffer, fileLinkPulledMessage, fileLinkReadView, fileLinkRefusalMessage } from './file-link.js'

export interface FileLinkPopoverTarget {
  readonly label: string
  readonly filePath: string | null
  readonly region: string | null
  readonly wireId: string | null
  /** The file's record id from the chip; preferred over the path for a pull. */
  readonly targetArtifactId?: string | null
  /** The open document, which the pull writes into; absent offers no pull. */
  readonly documentId?: string | null
  /** The block holding the chip; the pulled blocks go right after it. */
  readonly anchorBlockId?: string | null
  /**
   * The caller knows the wire but not its lines (a Wires panel row: the region
   * lives in the cell's side store, not in RDF). The popover reads first and
   * takes the region from the answer's regionShort.
   */
  readonly regionUnknown?: boolean
}

interface ToastElement extends HTMLElement {
  type: string
  position: string
  message: string
  duration: number
}

interface PopoverElement extends HTMLElement {
  label: string
  path: string
  loading: boolean
  text: string | null
  truncated: boolean
  status: string
  error: string
  wholeFile: boolean
  pullLabel: string
  pulling: boolean
  pullError: string
  x: number
  y: number
}

const POPOVER_TAG = 'mn-file-link-popover'
const MARGIN = 8

let current: { element: PopoverElement; dispose: () => void } | null = null

export function closeFileLinkPopover(): void {
  current?.dispose()
  current = null
}

function place(anchor: HTMLElement | null, doc: Document): { x: number; y: number } {
  const view = doc.defaultView
  const width = Math.min(520, (view?.innerWidth ?? 1024) - 32)
  if (!anchor) return { x: MARGIN * 2, y: MARGIN * 2 }
  const rect = anchor.getBoundingClientRect()
  const maxX = (view?.innerWidth ?? 1024) - width - MARGIN
  const x = Math.max(MARGIN, Math.min(rect.left, maxX))
  const below = rect.bottom + 6
  const fitsBelow = below + 200 < (view?.innerHeight ?? 768)
  const y = fitsBelow ? below : Math.max(MARGIN, rect.top - 260)
  return { x, y }
}

/** Show the popover for one file link; resolves once the cell's read is in. */
export async function openFileLinkPopover(
  given: FileLinkPopoverTarget,
  wire: Pick<WireService, 'readFileLink' | 'pullFileLines'>,
  anchor: HTMLElement | null,
  doc: Document = anchor?.ownerDocument ?? document,
): Promise<HTMLElement> {
  closeFileLinkPopover()
  let target = given
  const element = doc.createElement(POPOVER_TAG) as PopoverElement
  const { x, y } = place(anchor, doc)
  element.label = target.label
  element.path = target.filePath ?? ''
  element.x = x
  element.y = y
  element.wholeFile = !target.region
  element.loading = Boolean((target.region || target.regionUnknown) && target.wireId && wire.readFileLink)
  doc.body.append(element)

  const onPointer = (event: Event) => {
    if (!event.composedPath().includes(element)) closeFileLinkPopover()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeFileLinkPopover()
  }
  // The click that opened the popover is still bubbling; listen from the next turn.
  const timer = setTimeout(() => {
    doc.addEventListener('mousedown', onPointer, true)
    doc.addEventListener('keydown', onKey, true)
  }, 0)
  element.addEventListener('mn-close', () => closeFileLinkPopover())
  current = {
    element,
    dispose: () => {
      clearTimeout(timer)
      doc.removeEventListener('mousedown', onPointer, true)
      doc.removeEventListener('keydown', onKey, true)
      element.remove()
    },
  }

  // The pull: offered once the read says what can be pulled (below), or at once
  // for a whole-file link, which reads nothing first.
  const operationId = mintOperationId()
  let pullRegion: string | null = null
  const offer = (view: { error: string | null; status: string | null; movedTo: { start: number; end: number } | null }) => {
    const pull = canPull(target, wire)
      ? fileLinkPullOffer({
          region: target.region,
          filePath: target.filePath,
          // A link made by name has no path; its label starts with the file's name.
          fileName: target.label.split(' · ')[0] ?? null,
          readError: view.error,
          status: view.status,
          movedTo: view.movedTo,
        })
      : null
    element.pullLabel = pull?.label ?? ''
    pullRegion = pull?.region ?? null
  }
  element.addEventListener('mn-file-link-pull', () => {
    void runPull(target, wire, element, pullRegion, operationId, doc)
  })

  if (!element.loading) {
    offer({ error: null, status: null, movedTo: null })
    return element
  }
  const mine = current
  try {
    const payload = await wire.readFileLink!(target.wireId!)
    if (current !== mine) return element
    if (target.regionUnknown) {
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      const region = typeof record.regionShort === 'string' && record.regionShort ? record.regionShort : null
      target = { ...target, region, regionUnknown: false }
      element.wholeFile = !region
      if (!region) {
        element.loading = false
        offer({ error: null, status: null, movedTo: null })
        return element
      }
    }
    let view = fileLinkReadView(payload)
    // Lines that moved: show them where they are now, under the "Moved to" line.
    if (view.movedTo) {
      const { start, end } = view.movedTo
      const moved = await wire.readFileLink!(target.wireId!, start === end ? `L${start}` : `L${start}-L${end}`)
      if (current !== mine) return element
      const now = fileLinkReadView(moved)
      view = { ...view, text: now.text, truncated: now.truncated }
    }
    element.text = view.text
    element.truncated = view.truncated
    element.status = view.status ?? ''
    element.error = view.error ?? ''
    offer(view)
  } catch (error) {
    if (current !== mine) return element
    element.error = fileLinkRefusalMessage(error)
    offer({ error: element.error, status: null, movedTo: null })
  }
  element.loading = false
  return element
}

function canPull(target: FileLinkPopoverTarget, wire: Pick<WireService, 'pullFileLines'>): boolean {
  return Boolean(wire.pullFileLines && target.documentId && (target.targetArtifactId || target.filePath))
}

function mintOperationId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `pull-${random}`
}

async function runPull(
  target: FileLinkPopoverTarget,
  wire: Pick<WireService, 'pullFileLines'>,
  element: PopoverElement,
  region: string | null,
  operationId: string,
  doc: Document,
): Promise<void> {
  if (!wire.pullFileLines || !target.documentId || element.pulling) return
  element.pulling = true
  element.pullError = ''
  try {
    const pulled = await wire.pullFileLines({
      documentId: target.documentId,
      ...(target.targetArtifactId ? { artifactId: target.targetArtifactId } : target.filePath ? { artifactPath: target.filePath } : {}),
      ...(region ? { region } : {}),
      ...(target.anchorBlockId ? { afterBlockId: target.anchorBlockId } : {}),
      operationId,
    })
    if (current?.element === element) closeFileLinkPopover()
    showToast(doc, fileLinkPulledMessage(region, pulled.blockIds.length))
  } catch (error) {
    element.pulling = false
    element.pullError = fileLinkRefusalMessage(error)
  }
}

function showToast(doc: Document, message: string): void {
  const toast = doc.createElement('mn-toast') as ToastElement
  toast.type = 'success'
  toast.position = 'bottom-center'
  toast.message = message
  toast.duration = 3000
  doc.body.appendChild(toast)
}
