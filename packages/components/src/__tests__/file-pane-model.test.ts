import { describe, expect, it } from 'vitest'
import {
  deriveFilePaneColumns,
  filterFilePaneNodes,
  groupFilePaneSections,
  sortFilePaneNodes,
  validFilePanePath,
  type FilePaneSection,
} from '../file-pane-model.js'

const sections: readonly FilePaneSection[] = [
  {
    id: 'documents',
    label: 'Documents',
    nodes: [
      {
        id: 'folder-research',
        label: 'Research',
        kind: 'folder',
        order: 2,
        children: [
          { id: 'doc-zeta', label: 'Zeta', kind: 'document', createdAt: 30, connectivity: 2 },
          { id: 'doc-alpha', label: 'Alpha', kind: 'document', createdAt: 10, connectivity: 8 },
        ],
      },
      { id: 'doc-root', label: 'Root note', kind: 'document', order: 1, createdAt: 20 },
    ],
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    nodes: [{ id: 'artifact-map', label: 'Map', kind: 'artifact', createdAt: 5 }],
  },
]

describe('controlled file-pane read model', () => {
  it('sorts recursively without mutating the host projection', () => {
    const sourceNodes = sections[0].nodes!
    const sorted = sortFilePaneNodes(sourceNodes, {
      criterion: 'alphabetical',
      direction: 'asc',
      foldersFirst: true,
    })
    expect(sorted.map(node => node.id)).toEqual(['folder-research', 'doc-root'])
    expect(sorted[0].children?.map(node => node.id)).toEqual(['doc-alpha', 'doc-zeta'])
    expect(sourceNodes[0].children?.map(node => node.id)).toEqual(['doc-zeta', 'doc-alpha'])
  })

  it('sorts by last updated, newest first, with unknown dates last', () => {
    const sorted = sortFilePaneNodes([
      { id: 'a', label: 'A', kind: 'document', updatedAt: 100 },
      { id: 'b', label: 'B', kind: 'document' },
      { id: 'c', label: 'C', kind: 'document', updatedAt: 300 },
    ], { criterion: 'updated', direction: 'desc', foldersFirst: true })
    expect(sorted.map(node => node.id)).toEqual(['c', 'a', 'b'])
  })

  it('derives only valid Miller columns and drops stale path suffixes', () => {
    const documentSection = sections[0]
    expect(validFilePanePath(documentSection, ['folder-research', 'missing'])).toEqual(['folder-research'])
    const columns = deriveFilePaneColumns(documentSection, ['folder-research', 'missing'])
    expect(columns.map(column => column.parentId)).toEqual([null, 'folder-research'])
    expect(columns[1].nodes.map(node => node.id)).toEqual(['doc-alpha', 'doc-zeta'])
  })

  it('drops a files section, flattens folders on request, and keeps search a separate projection', () => {
    const grouped = groupFilePaneSections(sections, { showFolders: true })
    expect(grouped.map(section => section.id)).toEqual(['documents'])
    expect(grouped[0].nodes?.map(node => node.id)).toEqual(['folder-research', 'doc-root'])
    // A stored grouping from before files left the sidebar still works.
    const flat = groupFilePaneSections(sections, { separateArtifacts: false, showFolders: false } as never)
    expect(flat.map(section => section.id)).toEqual(['documents'])
    expect(flat[0].nodes?.map(node => node.id)).toEqual([
      'doc-zeta',
      'doc-alpha',
      'doc-root',
    ])
    expect(filterFilePaneNodes(sections[0].nodes ?? [], 'alpha')).toMatchObject([
      { id: 'folder-research', expanded: true, children: [{ id: 'doc-alpha' }] },
    ])
  })
})

describe('generated pages', () => {
  const withGenerated: readonly FilePaneSection[] = [{
    id: 'documents',
    label: 'Documents',
    count: 4,
    nodes: [
      { id: 'folder-a', label: 'A', kind: 'folder', children: [
        { id: 'doc-in-a', label: 'Inside A', kind: 'document' },
        { id: 'geist-diary-agent-x', label: 'Diary — x', kind: 'document', generated: true },
      ] },
      { id: 'doc-plain', label: 'Plain', kind: 'document' },
      { id: 'geist-important-blocks', label: 'What Has Become Important', kind: 'document', generated: true },
    ],
  }]

  it('moves generated pages, even from inside folders, into their own section after Documents', () => {
    const grouped = groupFilePaneSections(withGenerated, { showFolders: true })
    expect(grouped.map(section => section.id)).toEqual(['documents', 'generated'])
    expect(grouped[0].count).toBe(2)
    expect(grouped[0].nodes?.map(node => node.id)).toEqual(['folder-a', 'doc-plain'])
    expect(grouped[0].nodes?.[0].children?.map(node => node.id)).toEqual(['doc-in-a'])
    expect(grouped[1]).toMatchObject({ label: 'Made by Mycl', count: 2 })
    expect(grouped[1].nodes?.map(node => node.id)).toEqual(['geist-diary-agent-x', 'geist-important-blocks'])
  })

  it('leaves them among the documents when the setting is off', () => {
    const grouped = groupFilePaneSections(withGenerated, { showFolders: true, separateGenerated: false })
    expect(grouped.map(section => section.id)).toEqual(['documents'])
    expect(grouped[0].count).toBe(4)
    expect(grouped[0].nodes?.[0].children?.map(node => node.id)).toEqual(['doc-in-a', 'geist-diary-agent-x'])
  })

  it('still splits them when folders are hidden, and adds no section when there are none', () => {
    const flat = groupFilePaneSections(withGenerated, { showFolders: false })
    expect(flat[0].nodes?.map(node => node.id)).toEqual(['doc-in-a', 'doc-plain'])
    expect(flat[1].nodes?.map(node => node.id)).toEqual(['geist-diary-agent-x', 'geist-important-blocks'])
    expect(groupFilePaneSections(sections, { showFolders: true }).map(section => section.id)).not.toContain('generated')
  })
})
