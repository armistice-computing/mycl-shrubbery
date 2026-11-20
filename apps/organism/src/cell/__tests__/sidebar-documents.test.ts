import { TAGS_ENABLED } from '@shrubbery/nucleus'
import { describe, expect, it } from 'vitest'
import {
  isGeneratedDocument,
  loadSidebarSections,
  sidebarDocumentFromRow,
  sidebarDocumentListSparql,
  sidebarDocumentTree,
  sidebarFolderMoveExcludeIds,
  sidebarFolderOptionsFromSections,
  sidebarFolderFromRow,
  sidebarFolderListSparql,
  sidebarSectionsFromDocuments,
  sidebarTagFromRow,
  tagListSparql,
  sidebarWireCountSparql,
  sidebarSectionsWithOpenedTimes,
  type SidebarDocumentRest,
} from '../sidebar-documents.js'

describe('sidebar document projection', () => {
  it('parses workspace projection rows into document labels and placement', () => {
    expect(
      sidebarDocumentFromRow({
        doc: '<urn:mnemosyne:local:document:doc-a>',
        label: '"Garden plan"',
        parent: '<urn:mnemosyne:local:graph:graph-a:folder:folder-a>',
        order: '"2.5"^^<http://www.w3.org/2001/XMLSchema#double>',
      }),
    ).toEqual({ id: 'doc-a', label: 'Garden plan', parentId: 'folder-a', order: 2.5, readOnly: false, sourceFile: null })

    expect(
      sidebarDocumentFromRow({
        doc: '<urn:mnemosyne:local:document:doc-b>',
        label: '"Line\\nBreak"',
      }),
    ).toEqual({ id: 'doc-b', label: 'Line\nBreak', parentId: null, order: 0, readOnly: false, sourceFile: null })

    expect(sidebarDocumentFromRow({ doc: '<urn:other:doc>' })).toBeNull()
  })

  it('projects ISO or numeric createdAt and falls back only to epoch-valued order', () => {
    expect(sidebarDocumentFromRow({
      doc: '<urn:mnemosyne:local:document:iso-doc>',
      createdAt: '"2026-07-10T12:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
      order: '"2"^^<http://www.w3.org/2001/XMLSchema#double>',
    })?.createdAt).toBe(Date.parse('2026-07-10T12:00:00.000Z'))
    expect(sidebarDocumentFromRow({
      doc: '<urn:mnemosyne:local:document:numeric-doc>',
      createdAt: '"1783684800000"^^<http://www.w3.org/2001/XMLSchema#long>',
    })?.createdAt).toBe(1_783_684_800_000)
    expect(sidebarDocumentFromRow({
      doc: '<urn:mnemosyne:local:document:order-doc>',
      order: '"1783684800001"^^<http://www.w3.org/2001/XMLSchema#double>',
    })?.createdAt).toBe(1_783_684_800_001)
    expect(sidebarDocumentFromRow({
      doc: '<urn:mnemosyne:local:document:manual-order>',
      order: '"3"^^<http://www.w3.org/2001/XMLSchema#double>',
    })?.createdAt).toBeUndefined()
    expect(sidebarDocumentListSparql('graph-a')).toContain('doc:createdAt')
  })

  it('projects authoritative imported-document access and source metadata', () => {
    expect(sidebarDocumentFromRow({
      doc: '<urn:mnemosyne:local:document:imported-pdf>',
      label: '"Imported PDF"',
      readOnly: '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>',
      sourceStorageKey: '"local://artifacts/a/original/paper.pdf"',
      sourceOriginalFilename: '"paper.pdf"',
      sourceMimeType: '"application/pdf"',
      sourceContentSize: '"321"^^<http://www.w3.org/2001/XMLSchema#integer>',
      sourceFileType: '"pdf"',
    })).toEqual({
      id: 'imported-pdf',
      label: 'Imported PDF',
      parentId: null,
      order: 0,
      readOnly: true,
      sourceFile: {
        storageKey: 'local://artifacts/a/original/paper.pdf',
        originalFilename: 'paper.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 321,
        fileType: 'pdf',
      },
    })
    expect(sidebarDocumentListSparql('graph-a')).toContain('doc:sourceOriginalFilename')
  })

  it('parses workspace projection rows into folder metadata', () => {
    expect(
      sidebarFolderFromRow({
        folder: '<urn:mnemosyne:local:graph:graph-a:folder:folder-a>',
        label: '"Research"',
        parent: '<urn:mnemosyne:local:graph:graph-a:folder:folder-root>',
        order: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>',
        section: '"documents"',
      }),
    ).toEqual({
      id: 'folder-a',
      label: 'Research',
      parentId: 'folder-root',
      order: 3,
      section: 'documents',
    })

    expect(
      sidebarFolderFromRow({
        folder: '<urn:mnemosyne:local:graph:graph-a:folder:folder-imports>',
        section: '"artifacts"',
      }),
    ).toEqual({
      id: 'folder-imports',
      label: 'Untitled Folder',
      parentId: null,
      order: 0,
      section: 'artifacts',
    })
  })

  it('parses workspace projection tag aggregate rows', () => {
    expect(
      sidebarTagFromRow({
        tag: '"Pragma"',
        count: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>',
      }),
    ).toEqual({ name: 'pragma', count: 3 })

    expect(sidebarTagFromRow({ tag: '"bad tag"', count: '"1"' })).toBeNull()
  })

  it('projects folders, documents, and tags to controlled sidebar sections', () => {
    const sections = sidebarSectionsFromDocuments(
      [
        { id: 'doc-a', label: 'A', parentId: 'folder-child', order: 1, readOnly: true, sourceFile: { originalFilename: 'a.pdf' } },
        { id: 'doc-b', label: 'B', parentId: null, order: 2, readOnly: false, sourceFile: null },
      ],
      'doc-a',
      [
        { name: 'pragma', count: 4 },
        { name: 'shrubbery', count: 2 },
      ],
      [
        { id: 'folder-root', label: 'Root', parentId: null, order: 1, section: 'documents' },
        { id: 'folder-child', label: 'Child', parentId: 'folder-root', order: 1, section: 'documents' },
        { id: 'folder-artifacts', label: 'Artifacts', parentId: null, order: 1, section: 'artifacts' },
      ],
      new Set(['folder-root']),
      true, // tags are held back for the release (TAGS_ENABLED); the projection still works for their rework
    )

    // Files are not listed: no files section, and a folder of files stays out of the tree.
    expect(sections.map((section) => section.id)).toEqual(['documents', 'tags'])
    expect(sections[0].count).toBe(2)
    expect(sections[0].nodes?.map((node) => [node.id, node.kind, node.expanded])).toEqual([
      ['folder-root', 'folder', true],
      ['doc-b', 'document', undefined],
    ])
    const root = sections[0].nodes?.[0]
    expect(root?.children?.[0]).toMatchObject({ id: 'folder-child', kind: 'folder', expanded: true })
    expect(root?.children?.[0].children?.[0]).toMatchObject({
      id: 'doc-a',
      active: true,
      selected: true,
      readOnly: true,
      icon: 'book-open',
      sourceFile: { originalFilename: 'a.pdf' },
    })
    expect(sections[1].count).toBe(6)
    expect(sections[1].nodes?.map((node) => [node.id, node.label, node.kind, node.count])).toEqual([
      ['tag:event', 'event', 'tag', undefined],
      ['tag:todo', 'todo', 'tag', undefined],
      ['tag:decision', 'decision', 'tag', undefined],
      ['tag:tension', 'tension', 'tag', undefined],
      ['tag:pragma', 'pragma', 'tag', 4],
      ['tag:shrubbery', 'shrubbery', 'tag', 2],
    ])
  })

  it('holds tags back for the release: no Tags section, and no tag query', async () => {
    expect(TAGS_ENABLED).toBe(false)
    const sections = sidebarSectionsFromDocuments(
      [{ id: 'doc-a', label: 'A', parentId: null, order: 1, readOnly: false, sourceFile: null }],
      null,
      [{ name: 'pragma', count: 4 }],
    )
    expect(sections.map((section) => section.id)).toEqual(['documents'])
    const asked: string[] = []
    const rest = { query: async (_graphId: string, sparql: string) => { asked.push(sparql); return { rows: [] } } }
    await loadSidebarSections(rest as never, 'graph-a', null)
    expect(asked).not.toContain(tagListSparql('graph-a'))
  })

  it('hides PDF annotation companion documents from sidebar document surfaces', () => {
    const sections = sidebarSectionsFromDocuments(
      [
        { id: 'doc-a', label: 'Ordinary', parentId: 'folder-a', order: 1, readOnly: false, sourceFile: null },
        { id: 'pdf-ann-artifact-a', label: 'PDF annotations', parentId: 'folder-a', order: 2, readOnly: false, sourceFile: null },
        { id: 'pdf-ann-artifact-b', label: 'More annotations', parentId: null, order: 3, readOnly: false, sourceFile: null },
        { id: 'doc-pdf-ann-notes', label: 'Notes mentioning pdf-ann', parentId: null, order: 4, readOnly: false, sourceFile: null },
      ],
      'pdf-ann-artifact-b',
      [],
      [{ id: 'folder-a', label: 'Folder A', parentId: null, order: 1, section: 'documents' }],
      new Set(),
      true,
    )

    expect(sections[0].count).toBe(2)
    expect(sections[0].nodes?.map((node) => node.id)).toEqual(['folder-a', 'doc-pdf-ann-notes'])
    expect(sections[0].nodes?.[0].children?.map((node) => node.id)).toEqual(['doc-a'])
    expect(sections.map((section) => section.id)).toEqual(['documents', 'tags'])

    const tree = sidebarDocumentTree(
      [
        { id: 'doc-a', label: 'Ordinary', parentId: null, order: 1, readOnly: false, sourceFile: null },
        { id: 'pdf-ann-artifact-a', label: 'PDF annotations', parentId: null, order: 2, readOnly: false, sourceFile: null },
      ],
      [],
      null,
    )
    expect(tree.map((node) => node.id)).toEqual(['doc-a'])
  })

  it('leaves an empty Documents section when only PDF annotation companions exist', () => {
    const sections = sidebarSectionsFromDocuments(
      [
        { id: 'pdf-ann-artifact-a', label: 'PDF annotations', parentId: null, order: 1, readOnly: false, sourceFile: null },
      ],
      null,
    )

    expect(sections[0]).toMatchObject({
      id: 'documents',
      count: 0,
      emptyLabel: 'No documents in this graph',
    })
    expect(sections[0].nodes).toEqual([])
  })

  it('builds document trees with folders first and invalid parents at root', () => {
    const nodes = sidebarDocumentTree(
      [
        { id: 'doc-root', label: 'Root doc', parentId: null, order: 1, readOnly: false, sourceFile: null },
        { id: 'doc-child', label: 'Child doc', parentId: 'folder-child', order: 1, readOnly: false, sourceFile: null },
        { id: 'doc-orphan', label: 'Orphan doc', parentId: 'missing-folder', order: 0, readOnly: false, sourceFile: null },
      ],
      [
        { id: 'folder-root', label: 'Root folder', parentId: null, order: 2, section: 'documents' },
        { id: 'folder-child', label: 'Child folder', parentId: 'folder-root', order: 1, section: 'documents' },
      ],
      'doc-child',
    )

    expect(nodes.map((node) => [node.id, node.kind])).toEqual([
      ['folder-root', 'folder'],
      ['doc-orphan', 'document'],
      ['doc-root', 'document'],
    ])
    expect(nodes[0]).toMatchObject({ id: 'folder-root', expanded: true })
    expect(nodes[0].children?.[0]).toMatchObject({ id: 'folder-child', expanded: true })
    expect(nodes[0].children?.[0].children?.[0]).toMatchObject({ id: 'doc-child', active: true })
  })

  it('derives move dialog folder options and descendant exclusions from sidebar sections', () => {
    const sections = sidebarSectionsFromDocuments(
      [{ id: 'doc-a', label: 'A', parentId: 'folder-child', order: 1, readOnly: false, sourceFile: null }],
      null,
      [],
      [
        { id: 'folder-root', label: 'Root', parentId: null, order: 1, section: 'documents' },
        { id: 'folder-child', label: 'Child', parentId: 'folder-root', order: 2, section: 'documents' },
        { id: 'folder-artifacts', label: 'Media', parentId: null, order: 1, section: 'artifacts' },
      ],
      new Set(['folder-root', 'folder-artifacts']),
    )

    expect(sidebarFolderOptionsFromSections(sections)).toEqual([
      { id: 'folder-child', name: 'Child', parentId: 'folder-root', section: 'documents' },
      { id: 'folder-root', name: 'Root', parentId: null, section: 'documents' },
    ])
    expect(sidebarFolderMoveExcludeIds(sections, 'folder-root')).toEqual(['folder-root', 'folder-child'])
  })

  it('filters PDF annotation companions out of loaded sidebar sections', async () => {
    const rest: SidebarDocumentRest = {
      async query(graphId, sparql) {
        if (sparql === sidebarDocumentListSparql(graphId)) {
          return {
            rows: [
              { doc: '<urn:mnemosyne:local:document:doc-a>', label: '"A"' },
              { doc: '<urn:mnemosyne:local:document:pdf-ann-artifact-a>', label: '"PDF annotations"' },
            ],
          }
        }
        return { rows: [] }
      },
    }

    const sections = await loadSidebarSections(rest, 'graph-a', 'pdf-ann-artifact-a')
    expect(sections[0].count).toBe(1)
    expect(sections[0].nodes?.map((node) => node.id)).toEqual(['doc-a'])
  })

  it('loads folders, documents, and tags using GRAPH-scoped projection helpers', async () => {
    const calls: Array<{ graphId: string; sparql: string }> = []
    const rest: SidebarDocumentRest = {
      async query(graphId, sparql) {
        calls.push({ graphId, sparql })
        if (sparql === sidebarWireCountSparql('graph-a')) {
          return { rows: [{ doc: '<urn:mnemosyne:local:document:doc-a>', wires: '"3"^^<http://www.w3.org/2001/XMLSchema#integer>' }] }
        }
        if (sparql === tagListSparql('graph-a')) {
          return {
            rows: [
              {
                tag: '"pragma"',
                count: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
              },
            ],
          }
        }
        if (sparql === sidebarFolderListSparql('graph-a')) {
          return {
            rows: [
              {
                folder: '<urn:mnemosyne:local:graph:graph-a:folder:folder-a>',
                label: '"Folder A"',
                order: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
                section: '"documents"',
              },
            ],
          }
        }
        return {
          rows: [
            {
              doc: '<urn:mnemosyne:local:document:doc-a>',
              label: '"A"',
              parent: '<urn:mnemosyne:local:graph:graph-a:folder:folder-a>',
              order: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
            },
          ],
        }
      },
    }

    const sections = await loadSidebarSections(rest, 'graph-a', 'doc-a', new Set(), true)
    expect(calls).toEqual([
      { graphId: 'graph-a', sparql: sidebarDocumentListSparql('graph-a') },
      { graphId: 'graph-a', sparql: sidebarFolderListSparql('graph-a') },
      { graphId: 'graph-a', sparql: tagListSparql('graph-a') },
      { graphId: 'graph-a', sparql: sidebarWireCountSparql('graph-a') },
    ])
    expect(sections[0].nodes?.[0]).toMatchObject({
      id: 'folder-a',
      label: 'Folder A',
      kind: 'folder',
      expanded: true,
    })
    expect(sections[0].nodes?.[0].children?.[0]).toMatchObject({
      id: 'doc-a',
      label: 'A',
      active: true,
      selected: true,
      connectivity: 3,
    })
    expect(sections.map((section) => section.id)).toEqual(['documents', 'tags'])
    expect(sections[1].nodes?.find((node) => node.id === 'tag:pragma')).toMatchObject({
      label: 'pragma',
      count: 2,
    })
  })

  it('gives an unwired document 0 wires, and leaves counts out when the count read fails', async () => {
    const docRow = { doc: '<urn:mnemosyne:local:document:doc-b>', label: '"B"' }
    const ok: SidebarDocumentRest = {
      async query(_graphId, sparql) {
        if (sparql === sidebarWireCountSparql('g')) return { rows: [] }
        return { rows: sparql === sidebarDocumentListSparql('g') ? [docRow] : [] }
      },
    }
    const counted = await loadSidebarSections(ok, 'g', null)
    expect(counted[0].nodes?.[0]).toMatchObject({ id: 'doc-b', connectivity: 0 })
    const failing: SidebarDocumentRest = {
      async query(_graphId, sparql) {
        if (sparql === sidebarWireCountSparql('g')) throw new Error('down')
        return { rows: sparql === sidebarDocumentListSparql('g') ? [docRow] : [] }
      },
    }
    const uncounted = await loadSidebarSections(failing, 'g', null)
    expect(uncounted[0].nodes?.[0]?.id).toBe('doc-b')
    expect(uncounted[0].nodes?.[0]).not.toHaveProperty('connectivity')
  })

  it('copies last-opened times onto documents, nested ones too, and not onto folders', () => {
    const sections = sidebarSectionsWithOpenedTimes([
      { id: 'documents', label: 'Documents', nodes: [
        { id: 'f', label: 'F', kind: 'folder', children: [{ id: 'a', label: 'A', kind: 'document' }] },
        { id: 'b', label: 'B', kind: 'document' },
      ] },
    ], new Map([['a', 20], ['f', 99]]))
    expect(sections[0].nodes?.[0]).not.toHaveProperty('lastAccessedAt')
    expect(sections[0].nodes?.[0].children?.[0]).toMatchObject({ id: 'a', lastAccessedAt: 20 })
    expect(sections[0].nodes?.[1]).not.toHaveProperty('lastAccessedAt')
  })
})

describe('generated pages', () => {
  it('needs both a node-owned id and read-only', () => {
    expect(isGeneratedDocument('geist-important-blocks', true)).toBe(true)
    expect(isGeneratedDocument('geist-diary-agent-mu', true)).toBe(true)
    expect(isGeneratedDocument('default_x1-dream-journal', true)).toBe(true)
    // A person's own document named geist-…, and an imported read-only PDF.
    expect(isGeneratedDocument('geist-2-1-spec', false)).toBe(false)
    expect(isGeneratedDocument('doc-imported-pdf', true)).toBe(false)
  })

  it('marks the row and carries the mark onto the tree node', () => {
    const doc = sidebarDocumentFromRow({
      doc: '<urn:mnemosyne:local:document:geist-diary-agent-mu>',
      label: '"Diary — mu"',
      readOnly: '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>',
    })
    expect(doc).toMatchObject({ id: 'geist-diary-agent-mu', generated: true })
    const plain = sidebarDocumentFromRow({ doc: '<urn:mnemosyne:local:document:doc-a>', label: '"A"' })
    expect(plain).not.toHaveProperty('generated')
    const [node] = sidebarDocumentTree([doc!], [], null)
    expect(node).toMatchObject({ id: 'geist-diary-agent-mu', generated: true })
  })
})
