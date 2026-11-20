import { describe, expect, it } from 'vitest'
import { HomeActivityStore } from './home-activity.js'

class MemoryStorage {
  readonly data = new Map<string, string>()
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void { this.data.set(key, value) }
}

const docs = [
  { id: 'one', title: 'One' },
  { id: 'two', title: 'Two' },
  { id: 'graph-a-dream-journal', title: 'Dream Journal' },
]

describe('HomeActivityStore', () => {
  it('adopts gardend recents by newest time, keeping a newer local open', () => {
    const storage = new MemoryStorage()
    const activity = new HomeActivityStore(storage)
    activity.markOpened('graph-a', 'one', 500)
    expect(activity.adoptRecent('graph-a', [
      { documentId: 'two', lastOpenedAt: 400 },
      { documentId: 'one', lastOpenedAt: 100 },
      { documentId: 'graph-a-dream-journal', lastOpenedAt: 50 },
    ])).toBe(true)
    expect(activity.openedIds('graph-a')).toEqual(['one', 'two', 'graph-a-dream-journal'])
    expect(activity.project('graph-a', docs).resume?.documentId).toBe('one')
    // The same answer again changes nothing, so a redraw need not follow.
    expect(activity.adoptRecent('graph-a', [{ documentId: 'two', lastOpenedAt: 400 }])).toBe(false)
    // Persisted: a new store reads the merged list back.
    expect(new HomeActivityStore(storage).openedIds('graph-a')).toEqual(['one', 'two', 'graph-a-dream-journal'])
    // A newer gardend open moves resume.
    activity.adoptRecent('graph-a', [{ documentId: 'two', lastOpenedAt: 900 }])
    expect(activity.project('graph-a', docs).resume?.documentId).toBe('two')
  })

  it('projects only existing documents and keeps graph activity isolated', () => {
    const storage = new MemoryStorage()
    const activity = new HomeActivityStore(storage)
    activity.markOpened('graph-a', 'one', 10)
    activity.markCreated('graph-a', 'two', 20)
    activity.setPinned('graph-a', 'one', true)
    activity.markOpened('graph-b', 'other', 30)

    const a = activity.project('graph-a', docs)
    expect(a.resume?.documentId).toBe('two')
    expect(a.pinned?.map(item => item.documentId)).toEqual(['one'])
    expect(a.newlyCreated?.map(item => item.documentId)).toEqual(['two'])
    expect(a.recent).toEqual([])
    expect(a.dreamJournal).toBeNull()
    expect(activity.project('graph-b', docs).resume).toBeNull()
  })

  it('requires explicit real dreaming enablement and survives malformed storage', () => {
    const storage = new MemoryStorage()
    storage.setItem('shrubbery.organism.home-activity.v1', '{bad')
    const activity = new HomeActivityStore(storage)
    expect(activity.project('graph-a', docs).dreamJournal).toBeNull()
    expect(activity.project('graph-a', docs, { dreamingEnabled: true }).dreamJournal?.documentId)
      .toBe('graph-a-dream-journal')
    // The shell always enables the slot; a graph whose journal was never written shows no card.
    expect(activity.project('graph-b', docs, { dreamingEnabled: true }).dreamJournal).toBeNull()
  })

  it('shows the Dream Journal only when it was written within the freshness window', () => {
    const activity = new HomeActivityStore(new MemoryStorage())
    const day = 24 * 60 * 60 * 1000
    const now = 10 * day
    const journal = (updatedAt?: number) => [{ id: 'graph-a-dream-journal', title: 'Dream Journal', readOnly: true, updatedAt }]
    const project = (updatedAt?: number) =>
      activity.project('graph-a', journal(updatedAt), { dreamingEnabled: true, dreamJournalFreshMs: day, now }).dreamJournal
    expect(project(now - 8 * 60 * 60 * 1000)).toMatchObject({ documentId: 'graph-a-dream-journal', timestamp: now - 8 * 60 * 60 * 1000 })
    expect(project(now - day - 1)).toBeNull()
    expect(project(undefined)).toBeNull()
  })

  it('shows authoritative preexisting documents as newly created in a fresh browser', () => {
    const activity = new HomeActivityStore(new MemoryStorage())
    const projection = activity.project('graph-a', [
      { id: 'older', title: 'Older', createdAt: 100 },
      { id: 'newer', title: 'Newer', createdAt: 200 },
    ])
    expect(projection.newlyCreated?.map(item => item.documentId)).toEqual(['newer', 'older'])
  })

  it('lists the latest writes for "Last updated", leaving out pinned and read-only views', () => {
    const activity = new HomeActivityStore(new MemoryStorage())
    activity.setPinned('graph-a', 'pinned', true)
    const projection = activity.project('graph-a', [
      { id: 'old', title: 'Old', createdAt: 300, updatedAt: 310 },
      { id: 'fresh', title: 'Fresh', createdAt: 100, updatedAt: 900 },
      { id: 'pinned', title: 'Pinned', updatedAt: 1000 },
      { id: 'view', title: 'View', readOnly: true, updatedAt: 1100 },
      { id: 'never', title: 'Never written' },
    ])
    expect(projection.recentlyUpdated.map(item => [item.documentId, item.timestamp])).toEqual([['fresh', 900], ['old', 310]])
    // The created list is unchanged by it.
    expect(projection.newlyCreated?.map(item => item.documentId)).toEqual(['old', 'fresh'])
  })

  it('lists a document created and then opened in both lists, and carries its folder', () => {
    const activity = new HomeActivityStore(new MemoryStorage())
    activity.markOpened('graph-a', 'made', 30)
    const projection = activity.project('graph-a', [
      { id: 'made', title: 'Made', createdAt: 20, folder: 'Notes' },
      { id: 'loose', title: 'Loose', createdAt: 10, folder: null },
    ])
    expect(projection.recent?.map(item => item.documentId)).toEqual(['made'])
    expect(projection.newlyCreated?.map(item => [item.documentId, item.folder])).toEqual([['made', 'Notes'], ['loose', null]])
    activity.markOpened('graph-a', 'loose', 40)
    expect(activity.openedIds('graph-a')).toEqual(['loose', 'made'])
  })

  it('gives the pinned section precedence and rejects future timestamps', () => {
    const activity = new HomeActivityStore(new MemoryStorage())
    activity.markOpened('graph-a', 'recent', 20)
    activity.setPinned('graph-a', 'pinned', true)
    const projection = activity.project('graph-a', [
      { id: 'recent', title: 'Recent', createdAt: 10 },
      { id: 'pinned', title: 'Pinned', createdAt: 11 },
      { id: 'future', title: 'Future', createdAt: Date.now() + 2 * 86_400_000 },
    ])
    expect(projection.recent?.map(item => item.documentId)).toEqual(['recent'])
    expect(projection.pinned?.map(item => item.documentId)).toEqual(['pinned'])
    expect(projection.newlyCreated?.map(item => item.documentId)).toEqual(['recent'])
  })
})
