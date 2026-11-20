import { describe, expect, it } from 'vitest'
import {
  pinnedBoardKey,
  readPinnedBoard,
  writePinnedBoard,
  type PinnedBoard,
} from '../pinned-board.js'

function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

const board: PinnedBoard = {
  docs: [{ id: 'pindoc-g-d', graphId: 'g', documentId: 'd', title: 'Doc', x: 10, y: 20 }],
  blocks: [{
    id: 'pinblock-g-d-b', graphId: 'g', documentId: 'd', blockId: 'b', text: 'Block', documentTitle: 'Doc',
    x: 30, y: 40, width: 360, height: 240,
  }],
  nodes: [{
    id: 'pinwire-g-w', wireId: 'w', graphId: 'g', predicate: 'http://mnemosyne.ai/vocab#supports', predicateLabel: 'supports',
    bidirectional: false, sourceGraphId: 'g', sourceDocumentId: 'd', sourceBlockId: 'b', sourceTitle: 'Doc', sourceText: 'Block',
    targetGraphId: 'g', targetDocumentId: 'e', targetBlockId: null, targetTitle: 'Other', targetText: '',
    x: 50, y: 60, topIsSource: false,
  }],
}

describe('pinned board', () => {
  it('saves a graph\'s pins and reads them back, sizes and orientation included', () => {
    const storage = memoryStorage()
    writePinnedBoard(storage, 'g', board)
    expect(readPinnedBoard(storage, 'g')).toEqual(board)
  })

  it('keeps graphs apart', () => {
    const storage = memoryStorage()
    writePinnedBoard(storage, 'g', board)
    expect(readPinnedBoard(storage, 'other')).toEqual({ docs: [], nodes: [], blocks: [] })
    // A pin naming another graph inside this graph's entry is left out.
    storage.setItem(pinnedBoardKey('h'), storage.getItem(pinnedBoardKey('g'))!)
    expect(readPinnedBoard(storage, 'h')).toEqual({ docs: [], nodes: [], blocks: [] })
  })

  it('removes the entry when the last pin closes', () => {
    const storage = memoryStorage()
    writePinnedBoard(storage, 'g', board)
    writePinnedBoard(storage, 'g', { docs: [], nodes: [], blocks: [] })
    expect(storage.map.has(pinnedBoardKey('g'))).toBe(false)
  })

  it('leaves out what does not look like a pin, and never throws', () => {
    const storage = memoryStorage()
    storage.setItem(pinnedBoardKey('g'), JSON.stringify({
      docs: [{ id: 'x' }, board.docs[0], 7],
      blocks: [{ ...board.blocks[0], x: 'left' }],
      nodes: 'nope',
    }))
    expect(readPinnedBoard(storage, 'g')).toEqual({ docs: board.docs, nodes: [], blocks: [] })
    storage.setItem(pinnedBoardKey('g'), '{not json')
    expect(readPinnedBoard(storage, 'g')).toEqual({ docs: [], nodes: [], blocks: [] })
    const broken = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('full') },
      removeItem: () => { throw new Error('blocked') },
    }
    expect(readPinnedBoard(broken, 'g')).toEqual({ docs: [], nodes: [], blocks: [] })
    expect(() => writePinnedBoard(broken, 'g', board)).not.toThrow()
    expect(readPinnedBoard(null, 'g')).toEqual({ docs: [], nodes: [], blocks: [] })
  })
})
