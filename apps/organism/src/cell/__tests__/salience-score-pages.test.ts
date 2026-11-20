import { describe, expect, it } from 'vitest'
import { readSalienceScorePages } from '../salience-score-pages.js'

describe('salience page traversal', () => {
  it.each([undefined, null, -1, 0, 0.5, NaN, Infinity, '1000', 1001])(
    'stops safely on absent or malformed nextOffset %s', async (nextOffset) => {
      let calls = 0
      const blocks = await readSalienceScorePages(async () => {
        calls++
        return { blocks: [{ blockId: 'b' }], page: { nextOffset } }
      }, 'g', 'd')
      expect(calls).toBe(1)
      expect(blocks).toHaveLength(1)
    },
  )

  it('stops on a repeated offset or an empty page even with continuation metadata', async () => {
    for (const empty of [false, true]) {
      const paths: string[] = []
      const blocks = await readSalienceScorePages(async (path) => {
        paths.push(path)
        return { blocks: empty ? [] : [{ blockId: paths.length }], page: { nextOffset: 1 } }
      }, 'g', 'd')
      expect(paths).toHaveLength(empty ? 1 : 2)
      expect(blocks).toHaveLength(empty ? 0 : 2)
    }
  })

  it('stops at one legacy response without page metadata', async () => {
    let calls = 0
    const result = await readSalienceScorePages(async () => {
      calls++
      return { blocks: Array.from({ length: 1000 }, (_, i) => i) }
    }, 'g', 'd')
    expect(calls).toBe(1)
    expect(result).toHaveLength(1000)
  })

  it('keeps small candidate reads to one page even if continuation metadata is malformed', async () => {
    let calls = 0
    await readSalienceScorePages(async (path) => {
      calls++
      expect(new URL(path, 'http://local').searchParams.get('limit')).toBe('40')
      return { blocks: [], page: { nextOffset: 40 } }
    }, 'g', 'd', Array.from({ length: 40 }, (_, i) => String(i)))
    expect(calls).toBe(1)
  })

  it('caps large filtered reads at 1000 per page and retains the filter across pages', async () => {
    const paths: URL[] = []
    const result = await readSalienceScorePages(async (path) => {
      const url = new URL(path, 'http://local')
      paths.push(url)
      return url.searchParams.has('offset')
        ? { blocks: ['last'], page: { nextOffset: null } }
        : { blocks: Array.from({ length: 1000 }, (_, i) => i), page: { nextOffset: 1000 } }
    }, 'g', 'd', Array.from({ length: 1001 }, (_, i) => String(i)))
    expect(result).toHaveLength(1001)
    expect(paths.map((path) => path.searchParams.get('limit'))).toEqual(['1000', '1000'])
    expect(paths[1]!.searchParams.get('block_ids')).toBe(paths[0]!.searchParams.get('block_ids'))
  })
})
