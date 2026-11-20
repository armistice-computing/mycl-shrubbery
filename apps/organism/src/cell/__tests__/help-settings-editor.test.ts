import { describe, expect, it } from 'vitest'
import '../help-settings-editor.js'
import type { MnHelpSettings } from '../help-settings-editor.js'
import {
  HELP_ADD_GETTING_STARTED_EVENT,
  HELP_DOOR_EVENT,
  HELP_SHOW_WELCOME_EVENT,
  HELP_WIPE_EVENT,
  type HelpDoorDetail,
  type HelpRequestDetail,
} from '../help-actions.js'

async function mount(nativeAvailable: boolean): Promise<MnHelpSettings> {
  const el = document.createElement('mn-help-settings') as MnHelpSettings
  el.nativeAvailable = nativeAvailable
  document.body.append(el)
  await el.updateComplete
  return el
}

const q = <T extends Element = HTMLElement>(el: MnHelpSettings, selector: string) =>
  el.shadowRoot!.querySelector(selector) as T | null

async function click(el: MnHelpSettings, selector: string): Promise<void> {
  q<HTMLButtonElement>(el, selector)!.click()
  await el.updateComplete
}

describe('mn-help-settings', () => {
  it('offers six doors and the welcome card', async () => {
    const el = await mount(true)
    const doors = [...el.shadowRoot!.querySelectorAll('[data-help-door]')].map(node => node.getAttribute('data-help-door'))
    expect(doors).toEqual(['start-here', 'import', 'wires', 'today', 'agent', 'shortcuts'])
    const seen: string[] = []
    el.addEventListener(HELP_DOOR_EVENT, (event) => { seen.push((event as CustomEvent<HelpDoorDetail>).detail.door) })
    let welcome = 0
    el.addEventListener(HELP_SHOW_WELCOME_EVENT, () => { welcome++ })
    await click(el, '[data-help-door="wires"]')
    await click(el, '[data-help-show-welcome]')
    expect(seen).toEqual(['wires'])
    expect(welcome).toBe(1)
    el.remove()
  })

  it('outside the desktop app, the graph actions are off and say why', async () => {
    const el = await mount(false)
    expect(q<HTMLButtonElement>(el, '[data-help-add-getting-started]')!.disabled).toBe(true)
    expect(q<HTMLButtonElement>(el, '[data-wipe-start]')!.disabled).toBe(true)
    expect(el.shadowRoot!.textContent).toContain('Only in the desktop app.')
    el.remove()
  })

  it('asks three times before wiping, the last by typing delete', async () => {
    const el = await mount(true)
    let wipes = 0
    let resolve: HelpRequestDetail['resolve'] = () => undefined
    el.addEventListener(HELP_WIPE_EVENT, (event) => {
      wipes++
      resolve = (event as CustomEvent<HelpRequestDetail>).detail.resolve
    })

    await click(el, '[data-wipe-start]')
    expect(q(el, '.confirm')!.getAttribute('data-wipe-step')).toBe('1')
    await click(el, '[data-wipe-next="1"]')
    expect(q(el, '.confirm')!.getAttribute('data-wipe-step')).toBe('2')
    await click(el, '[data-wipe-next="2"]')
    expect(q(el, '.confirm')!.getAttribute('data-wipe-step')).toBe('3')

    const confirm = () => q<HTMLButtonElement>(el, '[data-wipe-confirm]')!
    expect(confirm().disabled).toBe(true)
    const input = q<HTMLInputElement>(el, '.confirm input')!
    input.value = 'delet'
    input.dispatchEvent(new Event('input'))
    await el.updateComplete
    expect(confirm().disabled).toBe(true)
    input.value = 'delete'
    input.dispatchEvent(new Event('input'))
    await el.updateComplete
    expect(confirm().disabled).toBe(false)

    await click(el, '[data-wipe-confirm]')
    expect(wipes).toBe(1)
    expect(confirm().textContent).toContain('Wiping…')
    resolve({ ok: true, message: 'Done.' })
    await el.updateComplete
    expect(q(el, '.confirm')!.getAttribute('data-wipe-step')).toBe('0')
    el.remove()
  })

  it('Cancel at any step puts the wipe away', async () => {
    const el = await mount(true)
    await click(el, '[data-wipe-start]')
    await click(el, '[data-wipe-next="1"]')
    await click(el, '[data-wipe-cancel]')
    expect(q(el, '.confirm')!.getAttribute('data-wipe-step')).toBe('0')
    el.remove()
  })

  it('shows what adding the Getting Started pages did', async () => {
    const el = await mount(true)
    el.addEventListener(HELP_ADD_GETTING_STARTED_EVENT, (event) => {
      (event as CustomEvent<HelpRequestDetail>).detail.resolve({ ok: false, message: 'Couldn’t add them.' })
    })
    await click(el, '[data-help-add-getting-started]')
    await el.updateComplete
    const outcomes = [...el.shadowRoot!.querySelectorAll('.outcome')].filter(node => !node.hasAttribute('hidden'))
    expect(outcomes.map(node => node.textContent)).toEqual(['Couldn’t add them.'])
    el.remove()
  })
})
