import { describe, expect, it } from 'vitest'
import { FilePaneController, type FilePaneStorageLike } from './file-pane-controller.js'

function memoryStorage(): FilePaneStorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
  }
}

describe('FilePaneController', () => {
  it('keeps preferences and navigation graph-scoped', () => {
    const storage = memoryStorage()
    const controller = new FilePaneController(storage)
    controller.setSort('alpha', { criterion: 'connectivity', direction: 'desc', foldersFirst: true })
    controller.setColumnPath('alpha', { sectionId: 'documents', folderIds: ['one', 'two'] })
    controller.setSelection('alpha', { ids: ['doc-a', 'doc-b'], nodes: [], anchorId: 'doc-a' })

    expect(controller.snapshot('alpha')).toMatchObject({
      sort: { criterion: 'connectivity', direction: 'desc' },
      selectedIds: ['doc-a', 'doc-b'],
      columnPaths: { documents: ['one', 'two'] },
    })
    expect(controller.snapshot('beta')).toMatchObject({
      sort: { criterion: 'manual', direction: 'asc' },
      selectedIds: [],
      columnPaths: {},
    })
  })

  it('restores only the v1 clean-state schema and normalizes corrupt values', () => {
    const storage = memoryStorage()
    const first = new FilePaneController(storage)
    first.setGrouping('graph', { showFolders: false })
    first.setSelection('graph', { ids: ['doc', 'doc'], nodes: [], anchorId: 'doc' })

    const restored = new FilePaneController(storage).snapshot('graph')
    expect(restored.grouping).toEqual({ showFolders: false, showWireCounts: false })
    expect(restored.selectedIds).toEqual(['doc'])

    storage.data.set('shrubbery:file-pane:v1:broken', '{not-json')
    expect(new FilePaneController(storage).snapshot('broken')).toMatchObject({
      sort: { criterion: 'manual', direction: 'asc', foldersFirst: true },
      grouping: { showFolders: true },
    })
  })

  it('keeps the wire count toggle, off unless it was turned on', () => {
    const storage = memoryStorage()
    const first = new FilePaneController(storage)
    expect(first.snapshot('graph').grouping.showWireCounts).toBe(false)
    first.setGrouping('graph', { showFolders: true, showWireCounts: true })
    expect(new FilePaneController(storage).snapshot('graph').grouping).toEqual({ showFolders: true, showWireCounts: true })
  })

  it('ignores a stored separateArtifacts from before files left the sidebar', () => {
    const storage = memoryStorage()
    storage.data.set('shrubbery:file-pane:v1:old', JSON.stringify({
      sort: { criterion: 'alphabetical', direction: 'asc', foldersFirst: true },
      grouping: { separateArtifacts: false, showFolders: false },
      selectedIds: ['doc-a'],
      selectionAnchorId: 'doc-a',
      columnPaths: { artifacts: ['folder-x'], documents: ['folder-a'] },
    }))
    const controller = new FilePaneController(storage)
    const restored = controller.snapshot('old')
    expect(restored.grouping).toEqual({ showFolders: false, showWireCounts: false })
    expect(restored.sort.criterion).toBe('alphabetical')
    controller.setSelection('old', { ids: ['doc-b'], nodes: [], anchorId: 'doc-b' })
    expect(JSON.parse(storage.data.get('shrubbery:file-pane:v1:old')!).grouping).toEqual({ showFolders: false, showWireCounts: false })
  })

  it('restores only sort from durable storage in a fresh session', () => {
    const durable = memoryStorage()
    const first = new FilePaneController(memoryStorage(), durable)
    const sort = { criterion: 'created', direction: 'desc', foldersFirst: false } as const
    first.setSort('alpha', sort)
    first.setGrouping('alpha', { showFolders: false })
    first.setSelection('alpha', { ids: ['doc-a'], nodes: [], anchorId: 'doc-a' })
    first.setColumnPath('alpha', { sectionId: 'documents', folderIds: ['folder-a'] })

    const restored = new FilePaneController(memoryStorage(), durable).snapshot('alpha')
    expect(restored).toEqual({
      sort,
      grouping: { showFolders: true, showWireCounts: false },
      selectedIds: [],
      selectionAnchorId: null,
      columnPaths: {},
    })
    expect(new FilePaneController(memoryStorage(), durable).snapshot('beta').sort)
      .toEqual({ criterion: 'manual', direction: 'asc', foldersFirst: true })
    expect(JSON.parse(durable.data.get('shrubbery:file-pane:v1:alpha:sort')!)).toEqual(sort)
  })

  it('prefers session state and tolerates corrupt durable sort data', () => {
    const session = memoryStorage()
    const durable = memoryStorage()
    const first = new FilePaneController(session, durable)
    first.setSort('graph', { criterion: 'connectivity', direction: 'desc', foldersFirst: true })
    session.data.set('shrubbery:file-pane:v1:graph', JSON.stringify({
      sort: { criterion: 'alphabetical', direction: 'asc', foldersFirst: true },
    }))

    expect(new FilePaneController(session, durable).snapshot('graph').sort)
      .toEqual({ criterion: 'alphabetical', direction: 'asc', foldersFirst: true })

    durable.data.set('shrubbery:file-pane:v1:broken:sort', '{not-json')
    expect(new FilePaneController(memoryStorage(), durable).snapshot('broken').sort)
      .toEqual({ criterion: 'manual', direction: 'asc', foldersFirst: true })
  })

  it('keeps the session sort when a durable write is denied', () => {
    const session = memoryStorage()
    const durable: FilePaneStorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded') },
    }
    const controller = new FilePaneController(session, durable)
    const sort = { criterion: 'created', direction: 'desc', foldersFirst: true } as const

    expect(controller.setSort('graph', sort).sort).toEqual(sort)
    expect(JSON.parse(session.data.get('shrubbery:file-pane:v1:graph')!).sort).toEqual(sort)
  })
})
