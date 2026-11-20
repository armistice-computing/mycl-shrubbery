import { describe, expect, it } from 'vitest'
import '../mn-home-view.js'
import type { MnHomeView } from '../mn-home-view.js'

async function mount(setup: (element: MnHomeView) => void): Promise<MnHomeView> {
  const element = document.createElement('mn-home-view') as MnHomeView
  setup(element)
  document.body.append(element)
  await element.updateComplete
  return element
}

describe('mn-home-view', () => {
  it('shows a spinner beside "Gathering this graph…" while it loads', async () => {
    const home = await mount(element => { element.status = 'loading' })
    const state = home.shadowRoot!.querySelector('.state')
    expect(state?.textContent).toContain('Gathering this graph')
    expect(state?.querySelector('.state-spinner svg')).not.toBeNull()
  })

  it('heads the Song like the other sections', async () => {
    const home = await mount(element => { element.status = 'ready'; element.verse = ['One line.'] })
    const heading = home.shadowRoot!.querySelector('.song h2')
    expect(heading?.textContent).toContain('The Song')
  })

  it('names the second list as told, and puts the important cards in the Song\'s place when the Song is hidden', async () => {
    const block = { documentId: 'd', blockId: 'b', text: 'A block', documentTitle: 'Doc', importance: 3, valence: 1, wires: 2 }
    const doc = { graphId: 'g', documentId: 'd', title: 'Doc', timestamp: Date.now() }
    const shown = await mount(home => {
      home.recent = [doc]
      home.recentLabel = 'Recently edited'
      home.verse = ['a line']
      home.important = [block]
    })
    const shownRoot = shown.shadowRoot!
    expect([...shownRoot.querySelectorAll('.recents h2')].map(h => h.textContent)).toEqual(['Recently edited'])
    expect(shownRoot.querySelector('.song')).not.toBeNull()
    expect(shownRoot.querySelector('.bottom .card')).not.toBeNull()
    expect(shownRoot.querySelector('.center-important')).toBeNull()
    shown.remove()

    const hidden = await mount(home => {
      home.recent = [doc]
      home.verse = ['a line']
      home.important = [block]
      home.songHidden = true
    })
    const hiddenRoot = hidden.shadowRoot!
    expect(hiddenRoot.querySelector('.song')).toBeNull()
    expect(hiddenRoot.querySelector('.bottom')).toBeNull()
    expect(hiddenRoot.querySelector('.center .center-important .card')).not.toBeNull()
    hidden.remove()
  })

  it('renders only honest controlled projections and forwards user intents', async () => {
    const opened: string[] = []
    const pins: Array<[string, boolean]> = []
    let created = 0
    const element = await mount(home => {
      home.graphId = 'graph-a'
      home.graphTitle = 'Graph A'
      home.todayKey = '2026-07-10'
      home.resume = { graphId: 'graph-a', documentId: 'resume', title: 'Resume Me' }
      home.pinned = [{ graphId: 'graph-a', documentId: 'pinned', title: 'Pinned Note' }]
      home.newlyCreated = [{ graphId: 'graph-a', documentId: 'new', title: 'New Note', timestamp: Date.now() }]
      home.recent = [{ graphId: 'graph-a', documentId: 'recent', title: 'Recent Note', timestamp: Date.now() - 60_000 }]
    })
    element.addEventListener('mn-home-new-document', () => { created += 1 })
    element.addEventListener('mn-home-open-document', event => opened.push((event as CustomEvent).detail.document.documentId))
    element.addEventListener('mn-home-pin-document', event => {
      const detail = (event as CustomEvent).detail
      pins.push([detail.document.documentId, detail.pinned])
    })

    const root = element.shadowRoot!
    expect(element.resume?.title).toBe('Resume Me')
    // No visible brand or graph name (Eschaton, 2026-10-15); the heading stays for screen readers.
    expect(root.querySelector('h1.visually-hidden')?.textContent).toBe('Graph A')
    expect(root.querySelector('.brand, .bookplate, .workspace')).toBeNull()
    expect(root.querySelector('.pill.resume .pill-kicker')?.textContent).toBe('Continue')
    expect(root.querySelector('.pill.resume .pill-title')?.textContent).toBe('Resume Me')
    expect(root.querySelector('.resume')?.getAttribute('aria-label')).toBe('Continue writing Resume Me')
    expect(root.textContent).toContain('Pinned Note')
    expect(root.textContent).toContain('New Note')
    expect(root.textContent).toContain('Recent Note')
    expect(root.textContent).not.toContain('Dream Journal')
    ;(root.querySelector('.new-document') as HTMLButtonElement).click()
    ;(root.querySelector('.resume') as HTMLButtonElement).click()
    ;(root.querySelector('[aria-label="Pin New Note"]') as HTMLButtonElement).click()
    ;(root.querySelector('[aria-label="Unpin Pinned Note"]') as HTMLButtonElement).click()
    expect(created).toBe(1)
    expect(opened).toEqual(['resume'])
    expect(pins).toEqual([['new', true], ['pinned', false]])
  })

  it('puts today\'s note and the Dream Journal in the top bar, and only when supplied', async () => {
    const element = await mount(home => {
      home.graphId = 'graph-a'
      home.todayKey = '2026-07-10'
      home.dreamJournal = {
        graphId: 'graph-a',
        documentId: 'graph-a-dream-journal',
        title: 'Dream Journal',
      }
    })

    const root = element.shadowRoot!
    expect(root.querySelector('header .quick mn-daily-note-row')?.hasAttribute('compact')).toBe(true)
    expect(root.querySelector('header .quick button.dream')).not.toBeNull()
    expect(root.querySelector('header .quick button.new-document')).not.toBeNull()
    // The journal is the last pill in the row (Eschaton, 2026-10-19).
    expect(root.querySelector('header .quick')!.lastElementChild?.classList.contains('dream')).toBe(true)
    expect(root.querySelector('.empty')?.textContent).toBe('Your first pages will gather here.')

    element.todayKey = ''
    element.dreamJournal = null
    await element.updateComplete
    expect(root.querySelector('header .quick mn-daily-note-row')).toBeNull()
    expect(root.querySelector('header .quick button.dream')).toBeNull()
  })

  it('shows Dream Journal only when supplied and exposes loading/error states', async () => {
    const element = await mount(home => {
      home.graphId = 'graph-a'
      home.dreamJournal = { graphId: 'graph-a', documentId: 'graph-a-dream-journal', title: 'Dream Journal' }
    })
    expect(element.shadowRoot!.textContent).toContain('Dream Journal')
    element.status = 'loading'
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('[aria-busy="true"]')).not.toBeNull()
    element.status = 'error'
    element.error = 'projection failed'
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain('projection failed')
  })

  it('shows folders, marks unfiled documents, and opens important blocks and "Remember this?" at their block', async () => {
    const blocks: string[] = []
    const element = await mount(home => {
      home.graphId = 'graph-a'
      home.newlyCreated = [
        { graphId: 'graph-a', documentId: 'filed', title: 'Filed', timestamp: Date.now(), folder: 'Notes' },
        { graphId: 'graph-a', documentId: 'loose', title: 'Loose', timestamp: Date.now(), folder: null },
      ]
      home.verse = ['First line.', 'Second line.']
      home.important = [
        { documentId: 'doc-a', blockId: 'b1', documentTitle: 'Antinomies', text: 'A thought.', importance: 4, valence: -3.7, wires: 6 },
        ...[2, 3, 4].map(n => ({ documentId: `doc-${n}`, blockId: `b${n}`, documentTitle: `Doc ${n}`, text: `Thought ${n}.`, importance: 3, valence: 1, wires: 0 })),
      ]
      home.remember = [
        { kind: 'recent', documentId: 'doc-s', blockId: 'b8', title: 'Last Week', quote: 'Fading words.', importance: 2.1, timestamp: Date.now() - 4 * 86_400_000, how: 'written' },
        { kind: 'past', documentId: 'doc-r', blockId: 'b9', title: 'Old Page', quote: 'Kept words.', importance: 3.4, timestamp: Date.now() - 90 * 86_400_000, how: 'written' },
      ]
    })
    element.addEventListener('mn-home-open-block', event => {
      const detail = (event as CustomEvent).detail
      blocks.push(`${detail.documentId}#${detail.blockId}`)
    })
    const root = element.shadowRoot!
    const metas = [...root.querySelectorAll('.doc-meta')].map(meta => meta.textContent?.replace(/\s+/g, ' ').trim())
    expect(metas[0]).toMatch(/^Notes·\S/)
    expect(root.querySelector('[data-document-id="loose"] .unfiled')?.textContent).toBe('unfiled')
    expect([...root.querySelectorAll('.verse li')].map(li => li.textContent)).toEqual(['First line.', 'Second line.'])
    expect(root.querySelector('.verse li.counterpoint')).toBeNull()
    expect(root.querySelector('.card-values')?.textContent?.replace(/\s+/g, ' ')).toContain('valence \u22123.7')
    ;(root.querySelector('[data-home-block="b1"]') as HTMLButtonElement).click()
    expect([...root.querySelectorAll('.remember-kind')].map(kind => kind.textContent)).toEqual(['Slipping away', 'From further back'])
    // Remember sits in the center under the verse; the bottom band holds only the important blocks.
    expect(root.querySelectorAll('.center .remember-section .remember')).toHaveLength(2)
    expect(root.querySelector('.bottom .remember')).toBeNull()
    expect(root.querySelectorAll('.bottom .cards .card')).toHaveLength(4)
    ;(root.querySelector('[data-home-remember="doc-r"]') as HTMLButtonElement).click()
    expect(blocks).toEqual(['doc-a#b1', 'doc-r#b9'])
  })

  it('hides the Song and the importance band when the graph has neither', async () => {
    const element = await mount(home => {
      home.graphId = 'graph-a'
      home.recent = [{ graphId: 'graph-a', documentId: 'recent', title: 'Recent Note', timestamp: Date.now() }]
    })
    const root = element.shadowRoot!
    expect(root.querySelector('.verse')).toBeNull()
    expect(root.querySelector('.bottom')).toBeNull()
    expect(root.querySelector('.top')?.classList.contains('no-recents')).toBe(false)
  })

  it('draws counterpoint lines in their voice, without the Markdown marks', async () => {
    const home = await mount(element => {
      element.verse = ['The verse.', { text: 'A second voice.', voice: 1 }, { text: 'A third.', voice: 2 }, '', 'After the gap.']
    })
    const items = [...home.shadowRoot!.querySelectorAll('.verse li')]
    expect(items.map(li => li.textContent)).toEqual(['The verse.', 'A second voice.', 'A third.', '', 'After the gap.'])
    expect(items.map(li => li.className)).toEqual(['', 'counterpoint', 'counterpoint', 'stanza-gap', ''])
    expect(items[2]!.getAttribute('data-voice')).toBe('2')
    expect(home.shadowRoot!.textContent).not.toMatch(/_|\*\*/)
  })
})
