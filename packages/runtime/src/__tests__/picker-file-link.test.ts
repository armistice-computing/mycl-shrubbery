/**
 * The `[[path#L10-L20]]` file link: detection and region parsing, the plain words,
 * the popover's view of the cell's read, and the picker glue end to end (the file
 * row first, wire first with the path and region, a refusal reopening the picker
 * with its reason and inserting nothing).
 */

import { afterEach, describe, expect, it } from 'vitest'
import '../../../components/src/mn-wikilink-picker.js'
import '../../../components/src/mn-file-link-popover.js'
import { DEFAULT_WIRE_PREDICATE_URI, MNEMO_NS, type EditorScope, type FileLinkCreateRequest, type WireCreateRequest, type WireWriter } from '@shrubbery/nucleus'
import { OPEN_WIKILINK_PICKER_EVENT, type OpenWikiLinkPickerDetail } from '@shrubbery/editor-kernel'
import { WIKILINK_CHIP_INSERTED_EVENT, assembleEditorServices, installWikiLinkPickerGlue, mintWireId, type LiveWikiLinkAttrs, type WikiLinkChipInsertedDetail } from '../index.js'
import {
  detectFileLink,
  fileLinkCandidateLabel,
  fileLinkChipLabel,
  fileLinkPullOffer,
  fileLinkPulledMessage,
  fileLinkReadView,
  fileLinkRefusalMessage,
  parseFileLinkRegion,
} from '../picker/file-link.js'
import { closeFileLinkPopover, openFileLinkPopover } from '../picker/file-link-popover.js'
import { seedWorkspaceStore, makeOxigraphRestClient } from './named-graph-store.js'

const GRAPH_ID = 'g-files'
const DOC_ID = 'd-notes'

describe('file link detection and words', () => {
  it('reads a path with a line or page fragment, and leaves plain titles alone', () => {
    expect(detectFileLink('/Users/me/notes/plan.md#L10-L20')).toEqual({
      path: '/Users/me/notes/plan.md',
      fileName: 'plan.md',
      region: { kind: 'lines', start: 10, end: 20 },
      regionShort: 'L10-L20',
    })
    expect(detectFileLink('~/papers/paper.pdf#p12')?.regionShort).toBe('p12')
    expect(detectFileLink('src/lib.rs#L5-9')?.regionShort).toBe('L5-L9')
    expect(detectFileLink('notes.md#L4')?.regionShort).toBe('L4')
    expect(detectFileLink('/Users/me/notes/plan.md')?.region).toBeNull()
    expect(detectFileLink('/Users/me/notes/plan.md#L5-L8]]')?.regionShort).toBe('L5-L8')
    // Titles, bare words and folders are not files.
    expect(detectFileLink('Architecture')).toBeNull()
    expect(detectFileLink('On Wires')).toBeNull()
    expect(detectFileLink('notes/plan')).toBeNull()
    expect(detectFileLink('/Users/me/notes/')).toBeNull()
  })

  it('passes fragments it does not parse to the cell untouched', () => {
    expect(parseFileLinkRegion('b100-200')).toEqual({ kind: 'other', fragment: 'b100-200' })
    expect(detectFileLink('/data/export.zip#m:chats/1.json')?.regionShort).toBe('m:chats/1.json')
    expect(parseFileLinkRegion('L9-L3')).toEqual({ kind: 'other', fragment: 'L9-L3' })
  })

  it('names the row and the chip in plain words', () => {
    expect(fileLinkCandidateLabel(detectFileLink('/n/notes.md#L10-L20')!)).toBe('Link to lines 10–20 of notes.md')
    expect(fileLinkCandidateLabel(detectFileLink('/n/paper.pdf#p12')!)).toBe('Link to page 12 of paper.pdf')
    expect(fileLinkCandidateLabel(detectFileLink('/n/notes.md')!)).toBe('Link to notes.md')
    expect(fileLinkChipLabel('notes.md', 'L10-L20')).toBe('notes.md · lines 10–20')
    expect(fileLinkChipLabel('notes.md', 'L4')).toBe('notes.md · line 4')
    expect(fileLinkChipLabel('notes.md', null)).toBe('notes.md')
  })

  it('says the cell\'s refusals plainly', () => {
    expect(fileLinkRefusalMessage(new Error('wire 0: denied: /etc/hosts is outside the allowed roots; no wires were created')))
      .toBe('That file is outside the folders agents may link to. Add its folder in Settings → Files.')
    expect(fileLinkRefusalMessage(new Error('wire 0: lines 40-45 are out of range: the file has 30 lines; no wires were created')))
      .toBe('That file has only 30 lines.')
    expect(fileLinkRefusalMessage(new Error('missing: /x/gone.md')))
      .toBe("That file can't be found. Check the path.")
    expect(fileLinkRefusalMessage(new Error('something odd'))).toBe("Couldn't link that file: something odd")
  })
})

describe('the popover view of the cell\'s read', () => {
  it('says how the lines stand: as linked, changed, moved, gone', () => {
    const same = fileLinkReadView({ regionText: 'a\nb', stale: { file: false, region: false } })
    expect(same).toEqual({ text: 'a\nb', truncated: false, status: null, error: null, movedTo: null })
    expect(fileLinkReadView({ regionText: 'x', stale: { file: true, region: true } }).status)
      .toBe('Changed since it was linked.')
    expect(fileLinkReadView({ regionText: 'x', stale: { file: true, region: false } }).status)
      .toBe('The file changed since it was linked; these lines did not.')
    const moved = fileLinkReadView({ regionText: 'x', stale: { file: true, region: true }, reanchored: { start: 12, end: 15 } })
    expect(moved.status).toBe('Moved to lines 12–15.')
    expect(moved.movedTo).toEqual({ start: 12, end: 15 })
    // The cell says anchorLost for lines edited in place too: still there, so changed.
    expect(fileLinkReadView({ regionText: 'x', stale: { file: true, region: true }, anchorLost: true }).status)
      .toBe('Changed since it was linked.')
    // Lines the file no longer has are gone.
    const gone = fileLinkReadView({ regionError: 'lines 40-45: the file has 30 lines', stale: { file: true, region: true }, anchorLost: true })
    expect(gone.status).toBe("These lines can't be found any more.")
    expect(gone.error).toBeNull()
  })

  it('caps the text at forty lines', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
    const view = fileLinkReadView({ regionText: text })
    expect(view.text?.split('\n')).toHaveLength(40)
    expect(view.truncated).toBe(true)
  })

  it('reads a row-opened link first to learn its lines (the Wires panel knows only the wire)', async () => {
    const reads: Array<string | undefined> = []
    const popover = await openFileLinkPopover(
      { label: 'notes.md', filePath: null, region: null, regionUnknown: true, wireId: 'wire-9', targetArtifactId: 'artifact-notes' },
      {
        readFileLink: async (_wireId: string, region?: string) => {
          reads.push(region)
          return { regionShort: 'L2-L3', regionText: 'two\nthree' }
        },
      },
      null,
    ) as HTMLElement & { updateComplete: Promise<unknown>, wholeFile: boolean }
    await popover.updateComplete
    expect(reads).toEqual([undefined])
    expect(popover.wholeFile).toBe(false)
    expect(popover.shadowRoot?.querySelector('[data-file-link-text]')?.textContent).toBe('two\nthree')
    closeFileLinkPopover()
  })

  it('shows moved lines where they are now', async () => {
    const reads: Array<string | undefined> = []
    const popover = await openFileLinkPopover(
      { label: 'notes.md · lines 5–8', filePath: '/n/notes.md', region: 'L5-L8', wireId: 'wire-1' },
      {
        readFileLink: async (_wireId: string, region?: string) => {
          reads.push(region)
          return region
            ? { regionText: 'five\nsix\nseven\neight' }
            : { regionText: 'two\nthree\nfour\nfive', stale: { file: true, region: true }, reanchored: { start: 8, end: 11 } }
        },
      },
      null,
    ) as HTMLElement & { updateComplete: Promise<unknown> }
    await popover.updateComplete
    expect(reads).toEqual([undefined, 'L8-L11'])
    expect(popover.shadowRoot?.querySelector('[data-file-link-status]')?.textContent).toBe('Moved to lines 8–11.')
    expect(popover.shadowRoot?.querySelector('[data-file-link-text]')?.textContent).toBe('five\nsix\nseven\neight')
    closeFileLinkPopover()
  })

  it('fills the popover from the wire service and shows a refusal as an error', async () => {
    const anchor = document.createElement('span')
    document.body.append(anchor)
    const read = await openFileLinkPopover(
      { label: 'notes.md · lines 5–8', filePath: '/n/notes.md', region: 'L5-L8', wireId: 'wire-1' },
      { readFileLink: async () => ({ regionText: 'five\nsix', stale: { file: true, region: true } }) },
      anchor,
    ) as HTMLElement & { updateComplete: Promise<unknown> }
    await read.updateComplete
    expect(read.shadowRoot?.querySelector('[data-file-link-text]')?.textContent).toBe('five\nsix')
    expect(read.shadowRoot?.querySelector('[data-file-link-status]')?.textContent).toBe('Changed since it was linked.')

    const refused = await openFileLinkPopover(
      { label: 'gone.md · line 1', filePath: '/n/gone.md', region: 'L1', wireId: 'wire-2' },
      { readFileLink: async () => { throw new Error('missing: /n/gone.md') } },
      anchor,
    ) as HTMLElement & { updateComplete: Promise<unknown> }
    await refused.updateComplete
    expect(read.isConnected).toBe(false) // one popover at a time
    expect(refused.shadowRoot?.querySelector('[data-file-link-error]')?.textContent).toBe("That file can't be found. Check the path.")
    closeFileLinkPopover()
    expect(refused.isConnected).toBe(false)
  })
})

describe('pulling a link\'s lines into the document', () => {
  const base = { readError: null, status: null, movedTo: null } as const

  it('offers a pull for lines and whole files, none for a PDF or a failed read', () => {
    expect(fileLinkPullOffer({ ...base, region: 'L3-L6', filePath: '/n/notes.md' })).toEqual({ label: 'Pull these lines into the document', region: 'L3-L6' })
    expect(fileLinkPullOffer({ ...base, region: null, filePath: '/n/notes.md' })).toEqual({ label: 'Pull this file into the document', region: null })
    expect(fileLinkPullOffer({ ...base, region: 'p12', filePath: '/n/paper.pdf' })).toBeNull()
    expect(fileLinkPullOffer({ ...base, region: 'page=2&start=1&end=4', filePath: '/n/paper.pdf' })).toBeNull()
    expect(fileLinkPullOffer({ ...base, region: null, filePath: '/n/paper.pdf' })).toBeNull()
    expect(fileLinkPullOffer({ ...base, region: 'L3', filePath: '/n/notes.md', readError: "That file can't be found. Check the path." })).toBeNull()
  })

  it('pulls changed lines as they are now, and moved lines from where they are', () => {
    expect(fileLinkPullOffer({ ...base, region: 'L3-L6', filePath: '/n/notes.md', status: 'Changed since it was linked.' }))
      .toEqual({ label: 'Pull the lines as they are now', region: 'L3-L6' })
    expect(fileLinkPullOffer({ ...base, region: 'L3-L6', filePath: '/n/notes.md', status: 'Moved to lines 8–11.', movedTo: { start: 8, end: 11 } }))
      .toEqual({ label: 'Pull these lines into the document', region: 'L8-L11' })
  })

  it('counts lines for a line region and blocks otherwise', () => {
    expect(fileLinkPulledMessage('L3-L6', 2)).toBe('Pulled 4 lines')
    expect(fileLinkPulledMessage('L7', 1)).toBe('Pulled 1 line')
    expect(fileLinkPulledMessage(null, 3)).toBe('Pulled 3 blocks')
  })

  it('pulls after the chip\'s block, once per popover, then closes and says so', async () => {
    const requests: unknown[] = []
    let release: (() => void) | null = null
    const popover = await openFileLinkPopover(
      { label: 'notes.md · lines 3–6', filePath: '/n/notes.md', region: 'L3-L6', wireId: 'wire-1', targetArtifactId: 'artifact-notes', documentId: 'doc-1', anchorBlockId: 'block-9' },
      {
        readFileLink: async () => ({ regionText: 'three\nfour\nfive\nsix' }),
        pullFileLines: async (params) => {
          requests.push(params)
          await new Promise<void>((resolve) => { release = resolve })
          return { blockIds: ['b-1', 'b-2'] }
        },
      },
      null,
    ) as HTMLElement & { updateComplete: Promise<unknown> }
    await popover.updateComplete
    const button = popover.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="pull"]')
    expect(button?.textContent?.trim()).toBe('Pull these lines into the document')
    button!.click()
    button!.click() // a double click pulls once
    await popover.updateComplete
    expect(popover.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="pull"]')?.disabled).toBe(true)
    expect(requests).toHaveLength(1)
    const sent = requests[0] as Record<string, unknown>
    expect(sent).toMatchObject({ documentId: 'doc-1', artifactId: 'artifact-notes', region: 'L3-L6', afterBlockId: 'block-9' })
    expect(sent.artifactPath).toBeUndefined()
    expect(String(sent.operationId)).toMatch(/^pull-/)
    release!()
    await new Promise(r => setTimeout(r, 0))
    expect(popover.isConnected).toBe(false)
    const toast = [...document.querySelectorAll('mn-toast')].pop() as (HTMLElement & { message: string }) | undefined
    expect(toast?.message).toBe('Pulled 4 lines')
    toast?.remove()
  })

  it('shows the cell\'s refusal in the popover and keeps it open', async () => {
    const popover = await openFileLinkPopover(
      { label: 'notes.md · line 3', filePath: '/n/notes.md', region: 'L3', wireId: 'wire-1', documentId: 'doc-1' },
      {
        readFileLink: async () => ({ regionText: 'three' }),
        pullFileLines: async () => { throw new Error('outside the allowed roots: /n/notes.md') },
      },
      null,
    ) as HTMLElement & { updateComplete: Promise<unknown> }
    await popover.updateComplete
    popover.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="pull"]')!.click()
    await new Promise(r => setTimeout(r, 0))
    await popover.updateComplete
    expect(popover.isConnected).toBe(true)
    expect(popover.shadowRoot?.querySelector('[data-file-link-pull-error]')?.textContent).toMatch(/outside the folders/)
    closeFileLinkPopover()
  })

  it('offers no pull without a document or a pull service', async () => {
    const popover = await openFileLinkPopover(
      { label: 'notes.md · line 3', filePath: '/n/notes.md', region: 'L3', wireId: 'wire-1' },
      { readFileLink: async () => ({ regionText: 'three' }), pullFileLines: async () => ({ blockIds: [] }) },
      null,
    ) as HTMLElement & { updateComplete: Promise<unknown> }
    await popover.updateComplete
    expect(popover.shadowRoot?.querySelector('[data-action="pull"]')).toBeNull()
    closeFileLinkPopover()
  })
})

// ── the glue, end to end ───────────────────────────────────────────────────────

interface FileWriter extends WireWriter {
  refuseCreateWith: string | null
  readonly creates: WireCreateRequest[]
  readonly fileLinks: FileLinkCreateRequest[]
  refuseWith: string | null
}

function fileWriter(): FileWriter {
  const writer: FileWriter = {
    creates: [],
    fileLinks: [],
    refuseWith: null,
    refuseCreateWith: null,
    async create(_graphId, params) {
      if (writer.refuseCreateWith) throw new Error(writer.refuseCreateWith)
      writer.creates.push(params)
      return { wireId: params.wireId ?? mintWireId() }
    },
    async delete() {},
    async createFileLink(_graphId, params) {
      if (writer.refuseWith) throw new Error(writer.refuseWith)
      writer.fileLinks.push(params)
      return { wireId: params.wireId, targetArtifactId: 'artifact-notes' }
    },
    async readFileLink() {
      return { regionText: '' }
    },
  }
  return writer
}

const teardowns: Array<() => void> = []
afterEach(() => {
  for (const t of teardowns.splice(0)) t()
  document.body.innerHTML = ''
})

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

async function key(k: string, n = 6): Promise<void> {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k }))
  await flush(n)
}

async function pickerRoot(mount: HTMLElement): Promise<ShadowRoot | null> {
  const picker = mount.querySelector('mn-wikilink-picker') as (HTMLElement & { updateComplete?: Promise<unknown> }) | null
  if (!picker) return null
  await picker.updateComplete
  return picker.shadowRoot
}

function install(writer: FileWriter) {
  const store = seedWorkspaceStore(GRAPH_ID, [{ id: DOC_ID, title: 'Notes' }, { id: 'doc-plan', title: 'Plan' }])
  const getScope = (): EditorScope => ({ app: undefined, centerMode: 'document', graphId: GRAPH_ID, documentId: DOC_ID })
  const services = assembleEditorServices(makeOxigraphRestClient(store), writer, getScope)
  const inserted: Array<{ range: { from: number; to: number }; attrs: LiveWikiLinkAttrs }> = []
  const mount = document.createElement('div')
  document.body.append(mount)
  teardowns.push(installWikiLinkPickerGlue({
    getEditor: () => ({
      getActiveBlockId: () => 'block-7',
      insertWikiLink: () => true,
      insertWikiLinkAt: (range, attrs) => {
        inserted.push({ range, attrs })
        return true
      },
    }),
    services,
    getScope,
    document,
    mountInto: mount,
  }))
  return { mount, inserted }
}

function openWith(query: string): void {
  const detail: OpenWikiLinkPickerDetail = { query, matchedText: `[[${query}`, range: { from: 3, to: 3 + query.length + 2 } }
  document.dispatchEvent(new CustomEvent<OpenWikiLinkPickerDetail>(OPEN_WIKILINK_PICKER_EVENT, { detail }))
}

describe('the [[ picker with a file path', () => {
  it('offers the file first, wires the block to its lines, then inserts the chip with the same wire id', async () => {
    const writer = fileWriter()
    const { mount, inserted } = install(writer)
    const announced: string[] = []
    const onChip = (event: Event) => announced.push((event as CustomEvent<WikiLinkChipInsertedDetail>).detail.wireId)
    document.addEventListener(WIKILINK_CHIP_INSERTED_EVENT, onChip)
    openWith('/Users/me/notes/plan.md#L5-L8')
    await flush()
    const root = await pickerRoot(mount)
    const rows = Array.from(root?.querySelectorAll('[data-wikilink-candidate]') ?? [])
    expect(rows[0]?.textContent?.trim()).toBe('Link to lines 5–8 of plan.md')

    // The wire flow, as for a document; a file has no blocks, so its row goes
    // straight to the drum, which opens on "is related to".
    await key('Enter')
    expect(writer.fileLinks).toEqual([])
    expect((await pickerRoot(mount))?.querySelector('[data-wire-sentence]')).not.toBeNull()
    await key('Enter')

    expect(writer.creates).toEqual([]) // no document wire
    expect(writer.fileLinks).toHaveLength(1)
    const sent = writer.fileLinks[0]!
    expect(sent).toMatchObject({
      sourceDocumentId: DOC_ID,
      sourceBlockId: 'block-7',
      artifactPath: '/Users/me/notes/plan.md',
      region: 'L5-L8',
      predicate: DEFAULT_WIRE_PREDICATE_URI,
    })
    expect(inserted).toEqual([{
      range: { from: 3, to: 3 + '/Users/me/notes/plan.md#L5-L8'.length + 2 },
      attrs: {
        targetDocId: '',
        label: 'plan.md · lines 5–8',
        targetGraphId: GRAPH_ID,
        wireId: sent.wireId,
        targetArtifactId: 'artifact-notes',
        filePath: '/Users/me/notes/plan.md',
        region: 'L5-L8',
      },
    }])
    // The host refreshes the wire's snippet after the chip replaces the typed "[[...".
    document.removeEventListener(WIKILINK_CHIP_INSERTED_EVENT, onChip)
    expect(announced).toEqual([sent.wireId])
  })

  it('reopens with the reason and inserts nothing when the cell refuses', async () => {
    const writer = fileWriter()
    writer.refuseWith = 'wire 0: denied: /etc/hosts is outside the allowed roots; no wires were created'
    const { mount, inserted } = install(writer)
    openWith('/etc/hosts#L1')
    await flush()
    await key('Enter')
    await key('Enter', 10)
    expect(inserted).toEqual([])
    const root = await pickerRoot(mount)
    expect(root?.querySelector('[data-wikilink-notice]')?.textContent)
      .toBe('That file is outside the folders agents may link to. Add its folder in Settings → Files.')
  })

  it('takes a typed predicate for a file, and offers no direction: the wire starts in the document', async () => {
    const writer = fileWriter()
    const { mount, inserted } = install(writer)
    openWith('/Users/me/notes/plan.md#L5-L8')
    await flush()
    await key('Enter')
    const root = await pickerRoot(mount)
    expect(root?.querySelector('[data-wire-direction]')).toBeNull()
    // ←→ would set the direction on a document; on a file they change nothing.
    await key('ArrowRight')
    const input = root?.querySelector('input') as HTMLInputElement
    input.value = 'sup'
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    await flush()
    await key('Enter')
    expect(writer.fileLinks).toHaveLength(1)
    expect(writer.fileLinks[0]).toMatchObject({ artifactPath: '/Users/me/notes/plan.md', predicate: `${MNEMO_NS}supports` })
    expect(inserted).toHaveLength(1)
  })

  it('goes back from a file\'s drum to the list, not to blocks it does not have', async () => {
    const writer = fileWriter()
    const { mount } = install(writer)
    openWith('/Users/me/notes/plan.md#L5-L8')
    await flush()
    await key('Enter')
    await key('Escape')
    const root = await pickerRoot(mount)
    const rows = Array.from(root?.querySelectorAll('[data-wikilink-candidate]') ?? [])
    expect(rows[0]?.textContent?.trim()).toBe('Link to lines 5–8 of plan.md')
    expect(root?.querySelector('[data-wikilink-whole-document]')).toBeNull()
    expect(writer.fileLinks).toEqual([])
  })

  it('says "Nothing found" for a query with no match, and stays open to keep searching', async () => {
    const writer = fileWriter()
    const { mount } = install(writer)
    openWith('zzzz-no-such-title')
    await flush()
    const root = await pickerRoot(mount)
    expect(root?.querySelector('.empty')?.textContent?.trim()).toBe('Nothing found')
    expect(root?.querySelector('[data-wikilink-search]')).not.toBeNull()
  })

  it('reopens with the reason, and inserts nothing, when the cell refuses the wire', async () => {
    const writer = fileWriter()
    writer.refuseCreateWith = 'Error: graph is read-only\n    at create (wire.js:1:1)'
    const { mount, inserted } = install(writer)
    openWith('Plan')
    await flush()
    await key('Enter') // the document
    await key('Enter') // the whole document
    await key('Enter') // the drum: is related to
    await flush(12)
    const root = await pickerRoot(mount)
    expect(root?.querySelector('[data-wikilink-notice]')?.textContent?.trim()).toBe("Couldn't make the wire: graph is read-only")
    expect(inserted).toEqual([])
  })

  it('offers no file row for a plain title', async () => {
    const writer = fileWriter()
    const { mount } = install(writer)
    openWith('Plan')
    await flush()
    const root = await pickerRoot(mount)
    const labels = Array.from(root?.querySelectorAll('[data-wikilink-candidate]') ?? []).map(row => row.textContent?.trim())
    expect(labels).toEqual(['Plan'])
  })
})
