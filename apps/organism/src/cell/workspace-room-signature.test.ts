import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { workspaceRoomSignature } from './workspace-room-signature.js'

function room(): Y.Doc {
  const doc = new Y.Doc()
  doc.getMap('documents').set('first', { title: 'First', parentId: null, section: 'documents', order: 1, updatedAt: 1, readOnly: false })
  doc.getMap('folders').set('f1', { name: 'Notes', parentId: null, section: 'documents', order: 1 })
  return doc
}

describe('workspaceRoomSignature', () => {
  it('ignores what every content write moves: order and updatedAt', () => {
    const doc = room()
    const before = workspaceRoomSignature(doc)
    doc.getMap('documents').set('first', { title: 'First', parentId: null, section: 'documents', order: 99, updatedAt: 99, readOnly: false })
    expect(workspaceRoomSignature(doc)).toBe(before)
  })

  it('changes when a document or folder appears, is renamed, or moves folder', () => {
    const doc = room()
    const seen = new Set([workspaceRoomSignature(doc)])
    doc.getMap('documents').set('second', { title: 'Second', parentId: null, section: 'documents' })
    seen.add(workspaceRoomSignature(doc))
    doc.getMap('documents').set('second', { title: 'Second, renamed', parentId: null, section: 'documents' })
    seen.add(workspaceRoomSignature(doc))
    doc.getMap('documents').set('second', { title: 'Second, renamed', parentId: 'f1', section: 'documents' })
    seen.add(workspaceRoomSignature(doc))
    doc.getMap('folders').set('f2', { name: 'Projects', parentId: null, section: 'documents' })
    seen.add(workspaceRoomSignature(doc))
    expect(seen.size).toBe(5)
  })
})
