import { describe, expect, it } from 'vitest'
import '../files-settings-editor.js'
import { FILES_OPEN_DOCUMENT_EVENT, type FilesOpenDocumentDetail, type FilesRootsChangeDetail, type MnFilesSettings } from '../files-settings-editor.js'
import {
  FileRootsNotOwnerError,
  GardendFilesSettingsApi,
  type FilesListing,
  type FilesSettingsApi,
} from '../files-settings-api.js'
import {
  fileKindLabel,
  fileModeLabel,
  fileRecordFromRoute,
  fileRecordFromRow,
  fileRootsFrom,
  fileStateLabel,
  fileStatusLabel,
  fileUseFromRow,
  fileUsesFromRoute,
  filesListRows,
  formatFileSize,
  liveDocumentTitles,
  rootsWith,
  rootsWithout,
  type FileRecord,
  type FileRoot,
  type FileRootsReport,
  type FilesListRow,
} from '../files-settings-model.js'

const G = 'fileslist'
const ART = (id: string) => `<urn:mnemosyne:local:graph:${G}:artifact:${id}>`
const DOC = (id: string) => `<urn:mnemosyne:local:document:${id}>`

// Rows as a real gardend cell answered the two queries, 2026-10-26.
const LIST_ROWS: Record<string, string>[] = [
  {
    artifact: ART('artifact-a98a'),
    label: '"scores.csv"',
    fileType: '"csv"',
    mimeType: '"text/csv"',
    kind: '"text"',
    mode: '"attached"',
    size: '"17"^^<http://www.w3.org/2001/XMLSchema#integer>',
    status: '"ready"',
  },
  // An older record: no mode, no size, still processing.
  { artifact: ART('artifact-old'), label: '"Old scan.pdf"', mimeType: '"application/pdf"', status: '"uploading"' },
]
const USE_ROWS: Record<string, string>[] = [
  { artifact: ART('artifact-a98a'), doc: DOC('doc-welcome') },
  { artifact: ART('artifact-a98a'), doc: DOC('doc-294b') },
  // The same document through a second path counts once.
  { artifact: ART('artifact-a98a'), doc: DOC('doc-294b') },
  // A PDF annotation companion is not a document a person sees.
  { artifact: ART('artifact-a98a'), doc: DOC('pdf-ann-x') },
]

// Records as gardend's Files route answers (artifact_storage.rs, 2026-10-26).
const ROUTE_ARTIFACTS = [
  {
    entityType: 'artifact', id: 'artifact-a98a', label: 'scores.csv', originalFilename: 'scores.csv',
    fileType: 'csv', mimeType: 'text/csv', sizeBytes: 17, mode: 'attached', storage: 'owned',
    status: 'ready', index: { kind: 'text' }, wireCount: 2, documentIds: ['doc-294b', 'doc-welcome', 'pdf-ann-x'],
  },
  {
    entityType: 'artifact', id: 'artifact-ref', label: 'recording.wav', fileType: 'wav', mode: 'referenced',
    storage: 'external', status: 'ready', index: { kind: 'audio', sizeBytes: 250000 }, wireCount: 0, documentIds: [],
  },
  // An older record the route backfilled: mode now present, size from the record.
  {
    entityType: 'artifact', id: 'artifact-old', label: 'Old scan', originalFilename: 'Old scan.pdf',
    fileType: 'pdf', sizeBytes: 298000, mode: 'digested', storage: 'borrowed', status: 'ready',
    ingestedDocId: 'doc-scan', wireCount: 0, documentIds: ['doc-scan'],
  },
]

function records(): FileRecord[] {
  return LIST_ROWS.map(fileRecordFromRow).filter((r): r is FileRecord => r !== null)
}

describe('files list model', () => {
  it('names the live document a file is the original of, and drops documents that are gone', () => {
    const [scores, , old] = ROUTE_ARTIFACTS.map(fileRecordFromRoute).filter((r): r is FileRecord => r !== null)
    expect(old!.originOf).toBe('doc-scan')
    const uses = ROUTE_ARTIFACTS.flatMap(fileUsesFromRoute)
    // doc-welcome was deleted; its id lingers on the record.
    const live = liveDocumentTitles([
      { doc: '<urn:mnemosyne:local:document:doc-294b>', title: '"Scores"' },
      { doc: '<urn:mnemosyne:local:document:doc-scan>', title: '"The old scan"' },
    ])
    const rows = filesListRows([scores!, old!], uses, live)
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('artifact-a98a')).toMatchObject({ usedBy: 1, usedByLabel: 'Used by 1 document', origin: null })
    expect(byId.get('artifact-old')).toMatchObject({
      usedByLabel: 'Original of The old scan',
      origin: { documentId: 'doc-scan', title: 'The old scan' },
    })
  })

  it('says Not used for an original whose document was deleted', () => {
    const [, , old] = ROUTE_ARTIFACTS.map(fileRecordFromRoute).filter((r): r is FileRecord => r !== null)
    const rows = filesListRows([old!], ROUTE_ARTIFACTS.flatMap(fileUsesFromRoute), new Map())
    expect(rows[0]).toMatchObject({ usedBy: 0, usedByLabel: 'Not used', origin: null })
  })

  it('counts every use and names no original when the live documents could not be read', () => {
    const [, , old] = ROUTE_ARTIFACTS.map(fileRecordFromRoute).filter((r): r is FileRecord => r !== null)
    const rows = filesListRows([old!], ROUTE_ARTIFACTS.flatMap(fileUsesFromRoute), null)
    expect(rows[0]).toMatchObject({ usedBy: 1, usedByLabel: 'Used by 1 document', origin: null })
  })

  it('reads the projection rows, with a missing mode and size left empty', () => {
    const [scores, old] = records()
    expect(scores).toMatchObject({ id: 'artifact-a98a', label: 'scores.csv', mode: 'attached', sizeBytes: 17, fileType: 'csv' })
    expect(old).toMatchObject({ id: 'artifact-old', mode: null, sizeBytes: null, status: 'uploading' })
  })

  it('counts each document that points at a file once', () => {
    const uses = USE_ROWS.map(fileUseFromRow).filter(u => u !== null)
    const rows = filesListRows(records(), uses)
    expect(rows.map(r => r.name)).toEqual(['Old scan.pdf', 'scores.csv'])
    const scores = rows.find(r => r.id === 'artifact-a98a')!
    expect(scores.usedBy).toBe(2)
    expect(scores.usedByLabel).toBe('Used by 2 documents')
    expect(scores).toMatchObject({ kind: 'CSV', mode: 'Attached', size: '17 bytes', state: '' })
    const old = rows.find(r => r.id === 'artifact-old')!
    expect(old).toMatchObject({ usedBy: 0, usedByLabel: 'Not used', kind: 'PDF', mode: '—', size: '—', state: 'Uploading' })
  })

  it('formats sizes in decimal units', () => {
    expect(formatFileSize(0)).toBe('0 bytes')
    expect(formatFileSize(1)).toBe('1 byte')
    expect(formatFileSize(999)).toBe('999 bytes')
    expect(formatFileSize(1000)).toBe('1 KB')
    expect(formatFileSize(1530)).toBe('1.5 KB')
    expect(formatFileSize(400_000_000)).toBe('400 MB')
    expect(formatFileSize(2_500_000_000)).toBe('2.5 GB')
    expect(formatFileSize(null)).toBe('—')
    expect(formatFileSize(Number.NaN)).toBe('—')
  })

  it('reads the Files route records, with uses from documentIds', () => {
    const recs = ROUTE_ARTIFACTS.map(fileRecordFromRoute).filter((r): r is FileRecord => r !== null)
    expect(recs.map(r => [r.id, r.mode, r.sizeBytes, r.kind])).toEqual([
      ['artifact-a98a', 'attached', 17, 'text'],
      ['artifact-ref', 'referenced', 250000, 'audio'],
      ['artifact-old', 'digested', 298000, null],
    ])
    expect(fileRecordFromRoute({ label: 'no id' })).toBeNull()
    const uses = ROUTE_ARTIFACTS.flatMap(fileUsesFromRoute)
    const rows = filesListRows(recs, uses)
    expect(rows.map(r => [r.name, r.mode, r.size, r.usedByLabel])).toEqual([
      ['Old scan', 'Digested', '298 KB', 'Used by 1 document'],
      ['recording.wav', 'Referenced', '250 KB', 'Not used'],
      // The PDF annotation companion is not counted.
      ['scores.csv', 'Attached', '17 bytes', 'Used by 2 documents'],
    ])
  })

  it('says the status route\'s word plainly, and nothing for ok', () => {
    expect(fileStatusLabel('ok')).toBe('')
    expect(fileStatusLabel(null)).toBe('')
    expect(fileStatusLabel('stale')).toBe('Changed since it was added')
    expect(fileStatusLabel('missing')).toBe('Missing')
    expect(fileStatusLabel('denied')).toBe('Outside the allowed folders')
    expect(fileStatusLabel('mystery')).toBe('')
  })

  it('says the mode and state in plain words', () => {
    expect(fileModeLabel('referenced')).toBe('Referenced')
    expect(fileModeLabel('digested')).toBe('Digested')
    expect(fileModeLabel(null)).toBe('—')
    expect(fileStateLabel('ready')).toBe('')
    expect(fileStateLabel(null)).toBe('')
    expect(fileStateLabel('stale')).toBe('Changed since it was added')
    expect(fileStateLabel('needs_review')).toBe('Needs review')
  })

  it('names no kind for an older record that stored "unknown"', () => {
    expect(fileKindLabel({ fileType: 'unknown', mimeType: null, kind: null })).toBe('—')
    expect(fileKindLabel({ fileType: 'unknown', mimeType: 'application/pdf', kind: null })).toBe('PDF')
    expect(fileKindLabel({ fileType: 'csv', mimeType: null, kind: null })).toBe('CSV')
  })

  it('reads and edits the allowed folders', () => {
    const report = fileRootsFrom({
      graphId: G,
      version: 1,
      roots: [{ path: '/a', recursive: true, includeHidden: false, addedAt: 'x' }, { path: '  ' }, { path: '/b', recursive: false }],
      fileError: null,
    })
    expect(report).toEqual({
      roots: [
        { path: '/a', recursive: true, includeHidden: false },
        { path: '/b', recursive: false, includeHidden: false },
      ],
      fileError: null,
    })
    expect(rootsWith(report.roots, ' /c ').map(r => r.path)).toEqual(['/a', '/b', '/c'])
    expect(rootsWith(report.roots, '/a')).toHaveLength(2)
    expect(rootsWithout(report.roots, '/a').map(r => r.path)).toEqual(['/b'])
  })
})

class FakeFilesApi implements FilesSettingsApi {
  readonly saved: FileRoot[][] = []
  readonly downloads: string[] = []
  ownerOnly = false
  readonly stateCalls: string[] = []
  states: Record<string, string | null> = {}
  constructor(public listing: FilesListing, public roots: FileRoot[]) {}
  async listFiles(): Promise<FilesListing> { return this.listing }
  async fileState(id: string): Promise<string | null> {
    this.stateCalls.push(id)
    return this.states[id] ?? null
  }
  async getRoots(): Promise<FileRootsReport> {
    if (this.ownerOnly) throw new FileRootsNotOwnerError()
    return { roots: this.roots, fileError: null }
  }
  async setRoots(roots: readonly FileRoot[]): Promise<FileRootsReport> {
    this.saved.push([...roots])
    this.roots = [...roots]
    return { roots: this.roots, fileError: null }
  }
  async download(row: Pick<FilesListRow, 'id' | 'filename'>): Promise<void> { this.downloads.push(row.filename) }
  readonly removed: string[] = []
  async remove(row: Pick<FilesListRow, 'id' | 'name'>): Promise<void> {
    this.removed.push(row.id)
    this.listing = { ...this.listing, records: this.listing.records.filter(record => record.id !== row.id) }
  }
}

async function settle(el: MnFilesSettings): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise(r => setTimeout(r, 0))
    await el.updateComplete
  }
}

async function mount(api: FakeFilesApi): Promise<MnFilesSettings> {
  const el = document.createElement('mn-files-settings')
  el.api = api
  el.graphId = G
  document.body.appendChild(el)
  await settle(el)
  return el
}

const q = <T extends Element>(el: MnFilesSettings, selector: string) => el.shadowRoot!.querySelector<T>(selector)
const qa = <T extends Element>(el: MnFilesSettings, selector: string) => [...el.shadowRoot!.querySelectorAll<T>(selector)]

describe('mn-files-settings', () => {
  it('shows the empty state in plain words', async () => {
    const el = await mount(new FakeFilesApi({ records: [], uses: [] }, []))
    expect(q(el, '.empty')?.textContent).toBe('No files yet. Files you drop in, and files your agents attach, appear here.')
    expect(el.shadowRoot!.textContent?.toLowerCase()).not.toContain('artifact')
    el.remove()
  })

  it('links an original to its document and asks the app to open it', async () => {
    const recs = ROUTE_ARTIFACTS.map(fileRecordFromRoute).filter((r): r is FileRecord => r !== null)
    const live = new Map([['doc-scan', 'The old scan']])
    const api = new FakeFilesApi({ records: recs, uses: ROUTE_ARTIFACTS.flatMap(fileUsesFromRoute), live }, [])
    const el = await mount(api)
    const opened: string[] = []
    const onOpen = (event: Event) => opened.push((event as CustomEvent<FilesOpenDocumentDetail>).detail.documentId)
    document.addEventListener(FILES_OPEN_DOCUMENT_EVENT, onOpen)
    const row = qa(el, 'tbody tr').find(r => r.getAttribute('data-file-id') === 'artifact-old')!
    expect(row.querySelector('.used-by')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Original of The old scan')
    row.querySelector<HTMLButtonElement>('[data-action="open-document"]')!.click()
    document.removeEventListener(FILES_OPEN_DOCUMENT_EVENT, onOpen)
    expect(opened).toEqual(['doc-scan'])
    el.remove()
  })

  it('lists files and downloads one', async () => {
    const uses = USE_ROWS.map(fileUseFromRow).filter(u => u !== null)
    const api = new FakeFilesApi({ records: records(), uses }, [])
    const el = await mount(api)
    const rows = qa(el, 'tbody tr')
    expect(rows.map(r => r.querySelector('.name')?.textContent)).toEqual(['Old scan.pdf', 'scores.csv'])
    expect(rows[1]!.querySelector('.used-by')?.textContent).toBe('Used by 2 documents')
    expect(rows[0]!.querySelector('.mode')?.textContent).toBe('—')
    rows[1]!.querySelector<HTMLButtonElement>('[data-action="download"]')!.click()
    await settle(el)
    expect(api.downloads).toEqual(['scores.csv'])
    el.remove()
  })

  it('removes a file only after a second click, and says an original\'s document stays', async () => {
    const recs = ROUTE_ARTIFACTS.map(fileRecordFromRoute).filter((r): r is FileRecord => r !== null)
    const live = new Map([['doc-scan', 'The old scan']])
    const api = new FakeFilesApi({ records: recs, uses: ROUTE_ARTIFACTS.flatMap(fileUsesFromRoute), live }, [])
    const el = await mount(api)
    const rowFor = (id: string) => qa(el, 'tbody tr').find(r => r.getAttribute('data-file-id') === id)
    rowFor('artifact-old')!.querySelector<HTMLButtonElement>('[data-action="remove"]')!.click()
    await settle(el)
    expect(api.removed).toEqual([])
    expect(rowFor('artifact-old')!.querySelector('.confirm-text')?.textContent).toContain('The document stays')
    rowFor('artifact-old')!.querySelector<HTMLButtonElement>('[data-action="remove-cancel"]')!.click()
    await settle(el)
    expect(rowFor('artifact-old')!.querySelector('[data-action="remove-confirm"]')).toBeNull()
    rowFor('artifact-old')!.querySelector<HTMLButtonElement>('[data-action="remove"]')!.click()
    await settle(el)
    rowFor('artifact-old')!.querySelector<HTMLButtonElement>('[data-action="remove-confirm"]')!.click()
    await settle(el)
    expect(api.removed).toEqual(['artifact-old'])
    expect(rowFor('artifact-old')).toBeUndefined()
    el.remove()
  })

  it('fills in each row\'s state after a route listing, without holding the list', async () => {
    const recs = ROUTE_ARTIFACTS.map(fileRecordFromRoute).filter((r): r is FileRecord => r !== null)
    const api = new FakeFilesApi({ records: recs, uses: ROUTE_ARTIFACTS.flatMap(fileUsesFromRoute), source: 'route' }, [])
    api.states = { 'artifact-ref': 'denied', 'artifact-old': 'stale', 'artifact-a98a': 'ok' }
    const el = await mount(api)
    const state = (id: string) => q(el, `tr[data-file-id="${id}"] .state`)?.textContent
    expect(state('artifact-ref')).toBe('Outside the allowed folders')
    expect(state('artifact-old')).toBe('Changed since it was added')
    expect(state('artifact-a98a')).toBe('')
    expect([...api.stateCalls].sort()).toEqual(['artifact-a98a', 'artifact-old', 'artifact-ref'])
    el.remove()
  })

  it('asks for no states when the list came from the projection', async () => {
    const api = new FakeFilesApi({ records: records(), uses: [], source: 'projection' }, [])
    const el = await mount(api)
    expect(qa(el, 'tbody tr')).toHaveLength(2)
    expect(api.stateCalls).toEqual([])
    el.remove()
  })

  it('adds and removes a folder, and announces each saved list', async () => {
    const api = new FakeFilesApi({ records: [], uses: [] }, [{ path: '/papers', recursive: true, includeHidden: false }])
    const el = await mount(api)
    const events: FilesRootsChangeDetail[] = []
    el.addEventListener('mn-files-roots-change', (event) => events.push((event as CustomEvent<FilesRootsChangeDetail>).detail))

    const input = q<HTMLInputElement>(el, 'input[name="path"]')!
    input.value = '/music'
    input.dispatchEvent(new Event('input'))
    await settle(el)
    q<HTMLFormElement>(el, 'form.add')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle(el)
    expect(api.saved.at(-1)!.map(r => r.path)).toEqual(['/papers', '/music'])
    expect(qa(el, 'ul.roots li').map(li => li.getAttribute('data-root'))).toEqual(['/papers', '/music'])
    expect(q<HTMLInputElement>(el, 'input[name="path"]')!.value).toBe('')

    q<HTMLButtonElement>(el, 'li[data-root="/papers"] [data-action="remove-root"]')!.click()
    await settle(el)
    expect(api.saved.at(-1)!.map(r => r.path)).toEqual(['/music'])
    expect(events.map(e => e.roots.map(r => r.path))).toEqual([['/papers', '/music'], ['/music']])
    expect(events.every(e => e.graphId === G)).toBe(true)
    el.remove()
  })

  it('does not save a folder already on the list', async () => {
    const api = new FakeFilesApi({ records: [], uses: [] }, [{ path: '/papers', recursive: true, includeHidden: false }])
    const el = await mount(api)
    const input = q<HTMLInputElement>(el, 'input[name="path"]')!
    input.value = '/papers'
    input.dispatchEvent(new Event('input'))
    await settle(el)
    q<HTMLFormElement>(el, 'form.add')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle(el)
    expect(api.saved).toEqual([])
    expect(q(el, '.roots-section .error')?.textContent).toBe('That folder is already on the list.')
    el.remove()
  })

  it('tells a viewer who is not the owner, and offers no editor', async () => {
    const api = new FakeFilesApi({ records: [], uses: [] }, [])
    api.ownerOnly = true
    const el = await mount(api)
    expect(q(el, '.not-owner')?.textContent).toBe('Only the owner of this graph can see and change these folders.')
    expect(q(el, 'form.add')).toBeNull()
    el.remove()
  })
})

describe('GardendFilesSettingsApi', () => {
  function api(answer: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const saved: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({ url, init })
      return answer(url, init)
    }) as typeof fetch
    const client = new GardendFilesSettingsApi({
      graphId: G,
      rest: {
        async query(_graphId: string, sparql: string) {
          return { rows: sparql.includes('SELECT DISTINCT') ? USE_ROWS : LIST_ROWS }
        },
      },
      contract: {
        auth: { token: () => 'tok', userId: () => 'owner', whenReady: async () => undefined } as never,
        runtime: { graphBaseUrl: () => 'http://127.0.0.1:9/' } as never,
      },
      fetch: fetchImpl,
      save: (_blob, filename) => { saved.push(filename) },
    })
    return { client, calls, saved }
  }

  it('reads the Files route first, with the bearer token', async () => {
    const { client, calls } = api(() => new Response(JSON.stringify({ graphId: G, artifacts: ROUTE_ARTIFACTS })))
    const listing = await client.listFiles()
    expect(listing.source).toBe('route')
    expect(listing.records.map(r => r.id)).toEqual(['artifact-a98a', 'artifact-ref', 'artifact-old'])
    expect(listing.uses).toHaveLength(4)
    expect(calls[0]!.url).toBe(`http://127.0.0.1:9/artifacts/${G}`)
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('falls back to the projection when an older gardend has no Files route', async () => {
    for (const status of [404, 405]) {
      const { client } = api(() => new Response('not found', { status }))
      const listing = await client.listFiles()
      expect(listing.source).toBe('projection')
      expect(listing.records.map(r => r.id)).toEqual(['artifact-a98a', 'artifact-old'])
      expect(listing.uses).toHaveLength(4)
    }
  })

  it('says a failing Files route plainly instead of falling back', async () => {
    const { client } = api(() => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
    await expect(client.listFiles()).rejects.toThrow()
  })

  it('reads one file\'s state from the status route, and null when it cannot', async () => {
    const { client, calls } = api((url) => url.endsWith('/artifact-ref/status')
      ? new Response(JSON.stringify({ artifactId: 'artifact-ref', state: 'denied' }))
      : new Response('gone', { status: 404 }))
    expect(await client.fileState('artifact-ref')).toBe('denied')
    expect(calls[0]!.url).toBe(`http://127.0.0.1:9/artifacts/${G}/artifact-ref/status`)
    expect(await client.fileState('artifact-gone')).toBeNull()
  })

  it('puts the roots to the owner route with the bearer token', async () => {
    const { client, calls } = api((_url, init) => new Response(JSON.stringify({
      roots: JSON.parse(String(init.body ?? '{"roots":[]}')).roots,
      fileError: null,
    })))
    const report = await client.setRoots([{ path: '/a', recursive: true, includeHidden: false }])
    expect(report.roots).toEqual([{ path: '/a', recursive: true, includeHidden: false }])
    expect(calls[0]!.url).toBe(`http://127.0.0.1:9/owner/graphs/${G}/artifact-roots`)
    expect(calls[0]!.init.method).toBe('PUT')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('turns a refused owner route into the not-owner error', async () => {
    const { client } = api(() => new Response(JSON.stringify({ error: 'owner bearer token required' }), { status: 401 }))
    await expect(client.getRoots()).rejects.toBeInstanceOf(FileRootsNotOwnerError)
  })

  it('removes a file through the node\'s artifact delete route', async () => {
    const { client, calls } = api(() => new Response('{}'))
    await client.remove({ id: 'artifact-a98a', name: 'scores.csv' })
    expect(calls[0]!.url).toBe(`http://127.0.0.1:9/navigation/${G}/artifacts/artifact-a98a`)
    expect(calls[0]!.init.method).toBe('DELETE')
  })

  it('downloads through the file download route', async () => {
    const { client, calls, saved } = api(() => new Response('name,score\n'))
    await client.download({ id: 'artifact-a98a', filename: 'scores.csv' })
    expect(calls[0]!.url).toBe(`http://127.0.0.1:9/artifacts/${G}/artifact-a98a/download`)
    expect(saved).toEqual(['scores.csv'])
  })
})
