/** The first-run card on Home: three doors, nothing asked, dismissible. */
import { afterEach, describe, expect, it } from 'vitest'
import '../mn-home-view.js'
import type { MnHomeView, MnHomeWelcomeDoorDetail } from '../mn-home-view.js'

async function mount(welcome: boolean): Promise<MnHomeView> {
  const element = document.createElement('mn-home-view') as MnHomeView
  element.status = 'ready'
  element.graphId = 'onboarding'
  element.welcome = welcome
  document.body.appendChild(element)
  await element.updateComplete
  return element
}

afterEach(() => { document.body.innerHTML = '' })

describe('mn-home-view welcome card', () => {
  it('shows three doors and nothing else to fill in', async () => {
    const element = await mount(true)
    const card = element.shadowRoot!.querySelector('.welcome')!
    expect(card).not.toBeNull()
    const doors = [...card.querySelectorAll<HTMLElement>('[data-welcome-door]')]
    expect(doors.map(door => door.dataset['welcomeDoor'])).toEqual(['import', 'write', 'agent'])
    expect(doors.map(door => door.querySelector('.welcome-title')?.textContent)).toEqual([
      'Bring in your notes', 'Quick Start', 'Connect your agent',
    ])
    expect(card.querySelector('input, textarea, select')).toBeNull()
    expect(card.textContent).not.toMatch(/dream/i)
    // Door 1 (vaults) isn't in the first release: promise only what imports today.
    expect(card.textContent).not.toMatch(/obsidian|vault/i)
    expect(card.textContent).toMatch(/PDFs/)
  })

  it('reports the door used, and a dismissal', async () => {
    const element = await mount(true)
    const doors: string[] = []
    let dismissed = 0
    element.addEventListener('mn-home-welcome-door', event => doors.push((event as CustomEvent<MnHomeWelcomeDoorDetail>).detail.door))
    element.addEventListener('mn-home-welcome-dismiss', () => { dismissed += 1 })
    const root = element.shadowRoot!
    root.querySelector<HTMLButtonElement>('[data-welcome-door="agent"]')!.click()
    root.querySelector<HTMLButtonElement>('[data-welcome-door="write"]')!.click()
    root.querySelector<HTMLButtonElement>('.welcome-dismiss')!.click()
    expect(doors).toEqual(['agent', 'write'])
    expect(dismissed).toBe(1)
  })

  it('is absent unless the host asks for it', async () => {
    const element = await mount(false)
    expect(element.shadowRoot!.querySelector('.welcome')).toBeNull()
  })
})
