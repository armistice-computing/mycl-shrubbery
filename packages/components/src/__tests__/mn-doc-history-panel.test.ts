/**
 * REAL component test - mn-doc-history-panel controlled history surface.
 *
 * Snapshot reads, restore, save, bookmark, and delete are host-owned. This test
 * drives the real custom element and verifies it only renders controlled state
 * plus emits composed intents.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import '../mn-doc-history-panel.js'
import {
  diffHistoryLines,
  type MnDocHistoryCursorDetail,
  type MnDocHistoryPanel,
  type MnDocHistoryRestoreDetail,
  type MnDocHistorySnapshotDetail,
} from '../mn-doc-history-panel.js'

async function mount(setup?: (el: MnDocHistoryPanel) => void): Promise<MnDocHistoryPanel> {
  const el = document.createElement('mn-doc-history-panel') as MnDocHistoryPanel
  setup?.(el)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

const sr = (el: MnDocHistoryPanel) => el.shadowRoot!

const snapshots = [
  {
    id: 'snap-recent',
    label: 'Before edit',
    createdAt: Date.now() - 20 * 60_000,
    tier: '20min',
    snapshotCount: 1,
  },
  {
    id: 'snap-day',
    createdAt: Date.now() - 26 * 60 * 60_000,
    tier: 'daily',
    isManual: true,
    blocksModified: 3,
  },
]

describe('mn-doc-history-panel - real custom element', () => {
  beforeAll(() => {
    expect(customElements.get('mn-doc-history-panel')).toBeDefined()
  })

  it('computes a simple controlled line diff without side effects', () => {
    expect(diffHistoryLines('a\nb', 'a\nc\nd')).toEqual([
      { index: 1, older: 'a', newer: 'a', kind: 'same' },
      { index: 2, older: 'b', newer: 'c', kind: 'changed' },
      { index: 3, older: undefined, newer: 'd', kind: 'added' },
    ])
  })

  it('renders loading, error, empty, and diff states from controlled props', async () => {
    const el = await mount((node) => {
      node.status = 'loading'
    })
    expect(sr(el).querySelector('mn-loading')).not.toBeNull()

    el.status = 'error'
    el.error = 'history failed'
    await el.updateComplete
    expect(sr(el).querySelector('mn-empty-state')?.getAttribute('title')).toBe('Could not load history')
    expect(sr(el).querySelector('mn-empty-state')?.getAttribute('description')).toBe('history failed')

    el.status = 'ready'
    el.error = ''
    el.olderId = ''
    await el.updateComplete
    expect(sr(el).querySelector('mn-empty-state')?.getAttribute('title')).toBe('Select a snapshot')

    el.snapshots = snapshots
    el.olderId = 'snap-recent'
    el.newerId = 'live'
    el.olderText = 'one\ntwo'
    el.newerText = 'one\nthree'
    await el.updateComplete
    expect(Array.from(sr(el).querySelectorAll('.rail-row')).map((row) => row.textContent)).toHaveLength(3)
    // The default view shows the chosen version alone, with no diff marks.
    expect([...sr(el).querySelectorAll('.version-line')].map((line) => line.textContent)).toEqual(['one', 'two'])
    expect(sr(el).querySelector('.diff-line')).toBeNull()
    el.diffStyle = 'split'
    await el.updateComplete
    expect(sr(el).querySelector('.diff-line[data-kind="changed"]')).not.toBeNull()
  })

  it('offers Version, Split and Unified, and shows a version even when nothing changed', async () => {
    const el = await mount((node) => {
      node.snapshots = snapshots
      node.olderId = 'snap-recent'
      node.newerId = 'live'
      node.olderText = 'same'
      node.newerText = 'same'
    })
    expect([...sr(el).querySelectorAll('.toggle-button')].map((b) => b.textContent?.trim())).toEqual(['Version', 'Split', 'Unified'])
    expect(sr(el).querySelector('.toggle-button[data-diff-style="version"]')?.getAttribute('data-active')).toBe('true')
    expect(sr(el).querySelector('.version-line')?.textContent).toBe('same')
  })

  it('emits composed timeline/action intents and performs no host work itself', async () => {
    const el = await mount((node) => {
      node.snapshots = snapshots
      node.olderId = 'snap-recent'
      node.newerId = 'live'
      node.olderText = 'before'
      node.newerText = 'after'
    })
    const cursors: MnDocHistoryCursorDetail[] = []
    const bookmarks: MnDocHistorySnapshotDetail[] = []
    const deletes: MnDocHistorySnapshotDetail[] = []
    const restores: MnDocHistoryRestoreDetail[] = []
    let saves = 0
    let refreshes = 0
    let closes = 0
    let styles = 0

    el.addEventListener('mn-doc-history-cursor-change', (event) => {
      cursors.push((event as CustomEvent<MnDocHistoryCursorDetail>).detail)
    })
    el.addEventListener('mn-doc-history-bookmark', (event) => {
      bookmarks.push((event as CustomEvent<MnDocHistorySnapshotDetail>).detail)
    })
    el.addEventListener('mn-doc-history-delete', (event) => {
      deletes.push((event as CustomEvent<MnDocHistorySnapshotDetail>).detail)
    })
    el.addEventListener('mn-doc-history-restore', (event) => {
      restores.push((event as CustomEvent<MnDocHistoryRestoreDetail>).detail)
    })
    el.addEventListener('mn-doc-history-save-current', () => saves++)
    el.addEventListener('mn-doc-history-refresh', () => refreshes++)
    el.addEventListener('mn-doc-history-close', () => closes++)
    el.addEventListener('mn-doc-history-diff-style-change', () => styles++)

    ;(sr(el).querySelectorAll<HTMLElement>('.rail-row')[2]).click()
    const rowCursor = cursors.at(-1)
    ;(sr(el).querySelector('[aria-label="Bookmark snapshot"]') as HTMLButtonElement).click()
    ;(sr(el).querySelector('[aria-label="Delete snapshot"]') as HTMLButtonElement).click()
    const railButtons = Array.from(sr(el).querySelectorAll<HTMLButtonElement>('.rail-header .ghost-button'))
    railButtons[0].click()
    railButtons[1].click()
    ;(sr(el).querySelector('.restore-button') as HTMLButtonElement).click()
    ;(sr(el).querySelector('button[aria-label="Close history"]') as HTMLButtonElement).click()
    ;(Array.from(sr(el).querySelectorAll('.toggle-button'))[1] as HTMLButtonElement).click()
    ;(Array.from(sr(el).querySelectorAll('.header .ghost-button'))[0] as HTMLButtonElement).click()

    expect(rowCursor).toEqual({ olderId: 'snap-day', newerId: 'live', focusedSide: 'older' })
    expect(cursors.at(-1)).toEqual({ olderId: 'snap-recent', newerId: 'live', focusedSide: 'newer' })
    expect(bookmarks).toEqual([{ snapshotId: 'snap-recent' }])
    expect(deletes).toEqual([{ snapshotId: 'snap-recent' }])
    expect(saves).toBe(1)
    expect(restores).toEqual([{ snapshotId: 'snap-recent' }])
    expect(closes).toBe(1)
    expect(styles).toBe(1)
    expect(refreshes).toBe(1)
  })

  it('closes on Escape, unless another dialog is open or there is no close', async () => {
    const closes: number[] = []
    const el = await mount()
    el.addEventListener('mn-doc-history-close', () => closes.push(1))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(closes).toHaveLength(1)

    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    document.body.appendChild(dialog)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(closes).toHaveLength(1)
    dialog.remove()

    el.showClose = false
    await el.updateComplete
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(closes).toHaveLength(1)

    // Removed from the page, it stops listening.
    el.showClose = true
    el.remove()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(closes).toHaveLength(1)
  })

  it('reads created_at sent as epoch milliseconds in a string, as gardend sends it', async () => {
    const threeHoursAgo = String(Date.now() - 3 * 60 * 60 * 1000)
    const el = await mount(panel => {
      panel.status = 'ready'
      panel.snapshots = [{ id: 'snapshot-1', createdAt: threeHoursAgo, tier: '2h', snapshotCount: 44 }]
    })
    const text = el.shadowRoot!.textContent ?? ''
    expect(text).toContain('3 hr ago')
    expect(text).not.toContain('unknown time')
  })
})
