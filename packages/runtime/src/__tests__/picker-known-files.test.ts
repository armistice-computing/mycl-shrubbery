/**
 * The graph's own files in the [[ picker (Eschaton, 2026-11-11): matched by name
 * under the document matches, with a region carried from `name#L2-L3`, and linked
 * by the file's id rather than a path. A failed read shows no file rows and no error.
 */
import { afterEach, describe, expect, it } from 'vitest'
import '../../../components/src/mn-wikilink-picker.js'
import type { EditorScope, FileLinkCreateRequest, WireCreateRequest, WireWriter } from '@shrubbery/nucleus'
import { OPEN_WIKILINK_PICKER_EVENT, type OpenWikiLinkPickerDetail } from '@shrubbery/editor-kernel'
import { assembleEditorServices, installWikiLinkPickerGlue, mintWireId, type KnownFile, type LiveWikiLinkAttrs } from '../index.js'
import {
  KNOWN_FILE_CANDIDATE_PREFIX,
  knownFileKindPhrase,
  knownFileRows,
  matchKnownFiles,
  parseKnownFileCandidateId,
  splitKnownFileQuery,
} from '../picker/file-link.js'
import { seedWorkspaceStore, makeOxigraphRestClient } from './named-graph-store.js'

const GRAPH_ID = 'g-known'
const DOC_ID = 'd-here'

const FILES: KnownFile[] = [
  { id: 'artifact-notes', name: 'notes.md', fileName: 'notes.md', fileType: 'md', mimeType: 'text/markdown' },
  { id: 'artifact-paper', name: 'Field notes on mycelium', fileName: 'field-notes.pdf', fileType: 'pdf', mimeType: 'application/pdf' },
  { id: 'artifact-scores', name: 'scores.csv', fileName: 'scores.csv', fileType: 'csv', mimeType: 'text/csv' },
  { id: 'artifact-poems', name: 'poems', fileName: 'poems(1).html', fileType: 'unknown', mimeType: 'text/html' },
  { id: 'artifact-notebook', name: 'Notebook export', fileName: 'export.ipynb', fileType: 'ipynb', mimeType: null },
]

describe('matching the graph\'s files by name', () => {
  it('matches by the start of the name or of a word, ignoring case, best first, at most three', () => {
    expect(matchKnownFiles(FILES, 'NOTES').map(f => f.id)).toEqual(['artifact-notes', 'artifact-paper'])
    expect(matchKnownFiles(FILES, 'myc').map(f => f.id)).toEqual(['artifact-paper'])
    expect(matchKnownFiles(FILES, 'export').map(f => f.id)).toEqual(['artifact-notebook']) // by its file name
    expect(matchKnownFiles(FILES, 'otes')).toEqual([]) // not inside a word
    expect(matchKnownFiles(FILES, '')).toEqual([])
    expect(matchKnownFiles([...FILES, ...FILES.map(f => ({ ...f, id: `${f.id}-2` }))], 'notes')).toHaveLength(3)
  })

  it('carries a region from name#L2-L3 or name#p4, and links the whole file without one', () => {
    expect(splitKnownFileQuery('notes#L2-L3')).toMatchObject({ name: 'notes', regionShort: 'L2-L3' })
    expect(splitKnownFileQuery('notes]]')).toMatchObject({ name: 'notes', regionShort: null })
    const [lines] = knownFileRows(FILES, 'notes#L2-L3')
    expect(lines).toEqual({ id: `${KNOWN_FILE_CANDIDATE_PREFIX}artifact-notes#L2-L3`, label: 'Link to lines 2–3 of notes.md', detail: 'Markdown file' })
    const [page] = knownFileRows(FILES, 'mycelium#p4')
    expect(page?.label).toBe('Link to page 4 of Field notes on mycelium')
    expect(knownFileRows(FILES, 'scores')[0]).toMatchObject({ label: 'scores.csv', detail: 'Spreadsheet' })
    expect(parseKnownFileCandidateId(lines!.id)).toEqual({ fileId: 'artifact-notes', regionShort: 'L2-L3' })
    expect(parseKnownFileCandidateId(`${KNOWN_FILE_CANDIDATE_PREFIX}artifact-scores`)).toEqual({ fileId: 'artifact-scores', regionShort: null })
    expect(parseKnownFileCandidateId('doc-1')).toBeNull()
  })

  it('names each kind quietly, and an older "unknown" type by its file name', () => {
    expect(knownFileKindPhrase(FILES[1]!)).toBe('PDF')
    expect(knownFileKindPhrase(FILES[3]!)).toBe('Web page')
    expect(knownFileKindPhrase(FILES[4]!)).toBe('Notebook')
    expect(knownFileKindPhrase({ fileType: 'rs', fileName: 'x.rs', name: 'x.rs', mimeType: null })).toBe('RS file')
    expect(knownFileKindPhrase({ fileType: null, fileName: null, name: 'blob', mimeType: 'application/octet-stream' })).toBe('File')
  })
})

interface FakeWriter extends WireWriter {
  creates: WireCreateRequest[]
  fileLinks: FileLinkCreateRequest[]
}

function writer(): FakeWriter {
  const w: FakeWriter = {
    creates: [],
    fileLinks: [],
    async create(_graphId, params) {
      w.creates.push(params)
      return { wireId: params.wireId ?? mintWireId() }
    },
    async delete() {},
    async createFileLink(_graphId, params) {
      w.fileLinks.push(params)
      return { wireId: params.wireId, targetArtifactId: null }
    },
    async readFileLink() {
      return { regionText: '' }
    },
  }
  return w
}

const teardowns: Array<() => void> = []
afterEach(() => {
  for (const t of teardowns.splice(0)) t()
  document.body.innerHTML = ''
})

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  for (let i = 0; i < n; i++) await Promise.resolve()
}

async function key(k: string): Promise<void> {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k }))
  await flush()
}

async function pickerRoot(mount: HTMLElement): Promise<ShadowRoot | null> {
  const picker = mount.querySelector('mn-wikilink-picker') as (HTMLElement & { updateComplete?: Promise<unknown> }) | null
  if (!picker) return null
  await picker.updateComplete
  return picker.shadowRoot
}

function install(w: FakeWriter, list: () => Promise<readonly KnownFile[]>) {
  const store = seedWorkspaceStore(GRAPH_ID, [{ id: DOC_ID, title: 'Here' }, { id: 'doc-notes', title: 'Notes from the field' }])
  const getScope = (): EditorScope => ({ app: undefined, centerMode: 'document', graphId: GRAPH_ID, documentId: DOC_ID })
  const services = assembleEditorServices(makeOxigraphRestClient(store), w, getScope, undefined, { knownFiles: { list } })
  const inserted: Array<{ range: { from: number; to: number }; attrs: LiveWikiLinkAttrs }> = []
  const mount = document.createElement('div')
  document.body.append(mount)
  teardowns.push(installWikiLinkPickerGlue({
    getEditor: () => ({
      getActiveBlockId: () => 'block-3',
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

function rowTexts(root: ShadowRoot | null): string[] {
  return Array.from(root?.querySelectorAll('[data-wikilink-candidate]') ?? []).map(row => row.textContent?.replace(/\s+/g, ' ').trim() ?? '')
}

describe('the [[ picker with the graph\'s files', () => {
  it('lists matching files under the documents, and links one by id with its lines', async () => {
    const w = writer()
    const { mount, inserted } = install(w, async () => FILES)
    openWith('notes#L2-L3')
    await flush()
    const rows = rowTexts(await pickerRoot(mount))
    const fileRow = rows.findIndex(text => text.startsWith('Link to lines 2–3 of notes.md'))
    expect(fileRow).toBeGreaterThan(-1)
    expect(rows[fileRow]).toContain('Markdown file')
    // No path row for a bare name a known file answers.
    expect(rows.some(text => /^Link to lines 2–3 of notes$/.test(text))).toBe(false)

    for (let i = 0; i < fileRow; i++) await key('ArrowDown')
    await key('Enter') // the file goes straight to the drum
    expect((await pickerRoot(mount))?.querySelector('[data-wire-sentence]')).not.toBeNull()
    await key('Enter')

    expect(w.creates).toEqual([])
    expect(w.fileLinks).toHaveLength(1)
    const sent = w.fileLinks[0]!
    expect(sent).toMatchObject({ sourceDocumentId: DOC_ID, sourceBlockId: 'block-3', targetArtifactId: 'artifact-notes', region: 'L2-L3' })
    expect(sent.artifactPath).toBeUndefined()
    expect(inserted).toHaveLength(1)
    expect(inserted[0]!.attrs).toMatchObject({
      label: 'notes.md · lines 2–3',
      targetArtifactId: 'artifact-notes',
      filePath: null,
      region: 'L2-L3',
      wireId: sent.wireId,
    })
  })

  it('shows no file rows and no error when the read fails', async () => {
    const w = writer()
    const { mount } = install(w, async () => { throw new Error('HTTP 500') })
    openWith('notes')
    await flush()
    const root = await pickerRoot(mount)
    expect(rowTexts(root).some(text => text.includes('Markdown file'))).toBe(false)
    expect(root?.textContent ?? '').not.toMatch(/500|couldn|error/i)
  })

  it('reads the files once per open, not per keystroke, and keeps documents above files', async () => {
    const w = writer()
    let reads = 0
    const { mount } = install(w, async () => { reads += 1; return FILES })
    openWith('no')
    await flush()
    const picker = mount.querySelector('mn-wikilink-picker') as (HTMLElement & { query?: string }) | null
    const input = picker?.shadowRoot?.querySelector('input')
    expect(input).toBeTruthy()
    input!.value = 'not'
    input!.dispatchEvent(new Event('input'))
    await flush()
    const rows = rowTexts(await pickerRoot(mount))
    // A document that matches stays above every file row.
    const documentRow = rows.findIndex(text => text.startsWith('Notes from the field'))
    const fileRow = rows.findIndex(text => text.startsWith('notes.md'))
    expect(documentRow).toBeGreaterThan(-1)
    expect(fileRow).toBeGreaterThan(documentRow)
    expect(reads).toBe(1)
  })
})
