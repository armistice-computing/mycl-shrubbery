import { describe, expect, it } from 'vitest'
import '../mn-vault-preview-dialog.js'
import type { MnVaultPreviewDialog, MnVaultPreviewActionDetail, MnVaultReview } from '../mn-vault-preview-dialog.js'

async function mount(setup: (el: MnVaultPreviewDialog) => void): Promise<MnVaultPreviewDialog> {
  const el = document.createElement('mn-vault-preview-dialog')
  setup(el)
  el.open = true
  document.body.append(el)
  await el.updateComplete
  return el
}

function root(el: MnVaultPreviewDialog): ShadowRoot {
  return el.shadowRoot as ShadowRoot
}

describe('mn-vault-preview-dialog', () => {
  it('renders a path as text, never as markup', async () => {
    const el = await mount(node => {
      node.phase = 'ready'
      node.totalEntries = 1
      node.entries = [{ path: '<img src=x onerror=alert(1)>.md', kind: 'note', bytes: 10 }]
    })
    const path = root(el).querySelector('.path')
    expect(path?.textContent).toBe('<img src=x onerror=alert(1)>.md')
    expect(root(el).querySelector('img')).toBeNull()
    el.remove()
  })

  it('keeps Import disabled until the import step exists, and counts files only', async () => {
    const el = await mount(node => {
      node.phase = 'ready'
      node.totalEntries = 3
      node.entries = [
        { path: 'Notes', kind: 'directory', bytes: 0 },
        { path: 'Notes/a.md', kind: 'note', bytes: 10 },
        { path: 'Notes/b.png', kind: 'attachment', bytes: 2048 },
      ]
    })
    const primary = root(el).querySelector<HTMLButtonElement>('button.primary')
    expect(primary?.disabled).toBe(true)
    expect(primary?.textContent?.trim()).toBe('Import 2 files')
    expect(root(el).textContent).toContain("isn't available yet")
    el.remove()
  })

  it('offers Show more while pages remain', async () => {
    const el = await mount(node => {
      node.phase = 'ready'
      node.totalEntries = 120
      node.hasMore = true
      node.entries = Array.from({ length: 50 }, (_, i) => ({ path: `n${i}.md`, kind: 'note' as const, bytes: 1 }))
    })
    expect(root(el).querySelector('.totals')?.textContent).toContain('Showing the first 50')
    const actions: string[] = []
    el.addEventListener('mn-vault-preview-action', event => actions.push((event as CustomEvent<MnVaultPreviewActionDetail>).detail.action))
    const more = [...root(el).querySelectorAll<HTMLButtonElement>('button.action')].find(button => button.textContent?.includes('Show more'))
    more?.click()
    expect(actions).toEqual(['show-more'])
    expect(root(el).querySelector<HTMLButtonElement>('button.primary')?.textContent?.trim()).toBe('Import everything')
    el.remove()
  })

  it('asks to choose again when a scan expired', async () => {
    const el = await mount(node => { node.phase = 'expired' })
    expect(root(el).textContent).toContain('expired')
    expect(root(el).querySelector('button.primary')?.textContent?.trim()).toBe('Choose again')
    el.remove()
  })

  it('stops the scan on Escape while scanning', async () => {
    const el = await mount(node => { node.phase = 'scanning' })
    const actions: string[] = []
    el.addEventListener('mn-vault-preview-action', event => actions.push((event as CustomEvent<MnVaultPreviewActionDetail>).detail.action))
    root(el).querySelector('.dialog')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(actions).toEqual(['cancel-scan'])
    el.remove()
  })
})

const REVIEW: MnVaultReview = {
  title: 'My vault',
  counts: { sourceNotes: 3, generatedTagHubs: 2, attachments: 1, folders: 2, wires: 9 },
  warnings: [{ path: '<b>x</b>.md', message: 'A heading link stays as written.' }],
  omittedWarnings: 4,
  supportedRefs: 7,
  unmappedRefs: 1,
  originalsPreserved: true,
}

function buttons(el: MnVaultPreviewDialog): string[] {
  return [...root(el).querySelectorAll<HTMLButtonElement>('.footer button')].map(b => b.textContent?.trim() ?? '')
}

function actionsOf(el: MnVaultPreviewDialog): MnVaultPreviewActionDetail[] {
  const seen: MnVaultPreviewActionDetail[] = []
  el.addEventListener('mn-vault-preview-action', event => seen.push((event as CustomEvent<MnVaultPreviewActionDetail>).detail))
  return seen
}

describe('mn-vault-preview-dialog import steps', () => {
  it('asks for the new graph name before review, and reviews only with one', async () => {
    const el = await mount(node => {
      node.phase = 'ready'
      node.importAvailable = true
      node.totalEntries = 1
      node.entries = [{ path: 'a.md', kind: 'note', bytes: 1 }]
    })
    const seen = actionsOf(el)
    const review = root(el).querySelector<HTMLButtonElement>('button.primary')
    expect(review?.textContent?.trim()).toBe('Review the import')
    expect(review?.disabled).toBe(true)
    const input = root(el).querySelector<HTMLInputElement>('#vault-graph-title')!
    input.value = 'Notes'
    input.dispatchEvent(new Event('input'))
    expect(seen).toEqual([{ action: 'title', title: 'Notes' }])
    el.graphTitle = 'Notes'
    await el.updateComplete
    expect(root(el).querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(false)
    el.remove()
  })

  it('shows what the import will make, the promise, and warnings as text', async () => {
    const el = await mount(node => { node.step = 'review'; node.review = REVIEW })
    const body = root(el).querySelector('.body')?.textContent ?? ''
    expect(body).toContain('new graph called “My vault”')
    expect(body).toContain('2 tags become pages')
    expect(body).toContain('is an example of')
    expect(body).toContain('Your vault is never changed')
    expect(body).toContain('And 4 more warnings')
    expect(root(el).querySelector('.warnings b')).toBeNull()
    expect(buttons(el)).toEqual(['Back', 'Import into a new graph'])
    el.remove()
  })

  it('says references resolved, not links that will work, and counts vault folders', async () => {
    const el = await mount(node => { node.step = 'review'; node.review = { ...REVIEW, tagReferences: 5 } })
    const body = root(el).querySelector('.body')?.textContent ?? ''
    expect(body).toContain("7 references resolved, 1 couldn't be matched and stays as written.")
    expect(body).not.toContain('will work')
    expect(body).toContain('2 folders from the vault keep their place')
    expect(body).toContain('9 wires in the new graph, from links and tags')
    expect(body).toContain('5 tag uses in all')
    el.remove()
  })

  it('shows a building job with no worker as interrupted, with no progress and no re-import', async () => {
    const el = await mount(node => { node.step = 'job'; node.job = { phase: 'building', title: 'My vault', error: null, workerActive: false } })
    const body = root(el).querySelector('.body')?.textContent ?? ''
    expect(body).toContain('Interrupted — not running right now')
    expect(body).toContain("didn't finish")
    expect(root(el).querySelector('.spinner')).toBeNull()
    expect(buttons(el)).not.toContain('Choose again')
    expect(buttons(el)).toContain('Check again')
    el.remove()
  })

  it('shows why a cancel did not stop the job, never a success', async () => {
    const el = await mount(node => {
      node.step = 'job'
      node.job = { phase: 'publishing', title: 'My vault', error: null, workerActive: true }
      node.stopRefused = true
      node.stopExplanation = 'Publication has already begun.'
    })
    const body = root(el).querySelector('.body')?.textContent ?? ''
    expect(body).toContain("It didn't stop: Publication has already begun.")
    expect(body).not.toContain('was stopped')
    el.remove()
  })

  it('offers Stop while building, and not once publishing', async () => {
    const el = await mount(node => { node.step = 'job'; node.job = { phase: 'building', title: 'My vault', error: null, workerActive: true } })
    expect(buttons(el)).toContain('Stop')
    el.job = { phase: 'publishing', title: 'My vault', error: null, workerActive: true }
    await el.updateComplete
    expect(buttons(el)).not.toContain('Stop')
    expect(root(el).textContent).toContain("can't be stopped now")
    el.remove()
  })

  it('is honest about uncertain: it keeps checking and makes no second copy', async () => {
    const el = await mount(node => { node.step = 'job'; node.job = { phase: 'uncertain', title: 'My vault', error: 'Needs reconciling with what was written.', workerActive: true } })
    expect(root(el).textContent).toContain("won't make a second copy")
    expect(root(el).textContent).toContain('Needs reconciling with what was written.')
    const seen = actionsOf(el)
    ;[...root(el).querySelectorAll<HTMLButtonElement>('.footer button')].find(b => b.textContent?.includes('Check again'))?.click()
    expect(seen.map(a => a.action)).toEqual(['check-again'])
    el.remove()
  })

  it('offers the new graph only when published', async () => {
    const el = await mount(node => { node.step = 'published'; node.review = REVIEW; node.canOpenGraph = true; node.job = { phase: 'published', title: 'My vault', error: null, workerActive: true, destinationAvailable: true } })
    expect(buttons(el)).toEqual(['Recent imports', 'Close', 'Open “My vault”'])
    const seen = actionsOf(el)
    root(el).querySelector<HTMLButtonElement>('button.primary')?.click()
    expect(seen.map(a => a.action)).toEqual(['open-graph'])
    el.remove()
  })

  it('shows why a published graph cannot open, with no Open button', async () => {
    const el = await mount(node => {
      node.step = 'published'
      node.review = REVIEW
      node.canOpenGraph = false
      node.job = { phase: 'published', title: 'My vault', error: 'This import was published, but its graph is no longer available or has been replaced.', workerActive: false, destinationAvailable: false }
    })
    expect(root(el).textContent).toContain('no longer available or has been replaced')
    expect(buttons(el).some(b => b.startsWith('Open'))).toBe(false)
    el.remove()
  })

  it('shows Stopping… while a requested stop settles', async () => {
    const el = await mount(node => { node.step = 'job'; node.job = { phase: 'building', title: 'My vault', error: null, workerActive: true, cancelRequested: true } })
    expect(root(el).textContent).toContain('Stopping the import')
    const stop = [...root(el).querySelectorAll<HTMLButtonElement>('.footer button')].find(b => b.textContent?.includes('Stopping'))
    expect(stop?.disabled).toBe(true)
    el.remove()
  })

  it('lists recent imports and opens one by its job id', async () => {
    const el = await mount(node => {
      node.step = 'recent'
      node.recentComplete = true
      node.recent = [
        { jobId: 'j1', phase: 'building', title: 'Reading notes', error: null, workerActive: true },
        { jobId: 'j2', phase: 'published', title: 'Deleted vault', error: null, workerActive: false, destinationAvailable: false },
      ]
    })
    expect(root(el).textContent).toContain('Running')
    expect(root(el).textContent).toContain('Graph removed')
    const seen = actionsOf(el)
    root(el).querySelector<HTMLButtonElement>('.entries button')?.click()
    expect(seen).toEqual([{ action: 'open-recent', jobId: 'j1' }])
    el.remove()
  })

  it('offers the chooser plainly when the vault must be chosen again', async () => {
    const el = await mount(node => { node.step = 'review-failed'; node.needsReselect = true; node.stepError = 'Choose the source in this app session before creating a preview.' })
    expect(root(el).textContent).toContain('After Mycl restarts')
    expect(buttons(el)).toContain('Choose the vault again')
    expect(buttons(el)).not.toContain('Back')
    el.remove()
  })

  it('counts down the last minute of a preview', async () => {
    const el = await mount(node => { node.step = 'review'; node.review = { ...REVIEW, expiresAt: 100_000 }; node.now = () => 58_000 })
    expect(root(el).textContent).toContain('This preview closes in 42 seconds')
    el.now = () => 10_000
    el.requestUpdate()
    await el.updateComplete
    expect(root(el).textContent).not.toContain('This preview closes')
    el.remove()
  })

  it('says a stopped import made no graph', async () => {
    const el = await mount(node => { node.step = 'abandoned' })
    expect(root(el).textContent).toContain('No graph was added')
    el.remove()
  })
})
