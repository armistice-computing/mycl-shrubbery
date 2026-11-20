import { afterEach, describe, expect, it } from 'vitest'
import '../mn-salience-config.js'
import {
  SALIENCE_CONFIG_REQUEST_EVENT,
  type MnSalienceConfig,
  type SalienceConfigRequestDetail,
  type SalienceConfigView,
} from '../mn-salience-config.js'

const CONFIG: SalienceConfigView = {
  importancePrompt: 'What matters here?',
  valencePrompt: 'Which way does it pull?',
  weights: {
    importance_weight: 0.3,
    valence_weight: 0.2,
    temporal_weight: 0.15,
    block_wires_weight: 0.15,
    doc_wires_weight: 0.1,
    wire_freshness_weight: 0.1,
    importance_ref: 10,
    valence_ref: 10,
    block_wires_ref: 3,
    doc_wires_ref: 8,
    half_life_days: 30,
  },
  historyCount: 2,
}

const listeners: EventListener[] = []
afterEach(() => {
  for (const listener of listeners.splice(0)) document.body.removeEventListener(SALIENCE_CONFIG_REQUEST_EVENT, listener)
  document.body.replaceChildren()
})

async function mount(
  answer: (detail: SalienceConfigRequestDetail) => void,
  setup: (element: MnSalienceConfig) => void = () => {},
): Promise<{ element: MnSalienceConfig; requests: SalienceConfigRequestDetail[] }> {
  const requests: SalienceConfigRequestDetail[] = []
  const listener = ((event: CustomEvent<SalienceConfigRequestDetail>) => {
    event.preventDefault()
    requests.push(event.detail)
    answer(event.detail)
  }) as EventListener
  listeners.push(listener)
  document.body.addEventListener(SALIENCE_CONFIG_REQUEST_EVENT, listener)
  const element = document.createElement('mn-salience-config')
  setup(element)
  document.body.append(element)
  await element.updateComplete
  return { element, requests }
}

const root = (element: MnSalienceConfig): ShadowRoot => element.shadowRoot!
const input = (element: MnSalienceConfig, name: string) =>
  root(element).querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!
const saveButton = (element: MnSalienceConfig) => root(element).querySelector<HTMLButtonElement>('.save')!

async function type(element: MnSalienceConfig, name: string, value: string): Promise<void> {
  const field = input(element, name)
  field.value = value
  field.dispatchEvent(new Event('input'))
  await element.updateComplete
}

async function openPanel(element: MnSalienceConfig): Promise<void> {
  root(element).querySelector<HTMLButtonElement>('.toggle')!.click()
  await element.updateComplete
  await element.updateComplete
}

describe('mn-salience-config', () => {
  it('is closed at first and loads the settings on first open', async () => {
    const { element, requests } = await mount(detail => detail.respond({ config: CONFIG }))
    expect(requests).toHaveLength(0)
    expect(root(element).querySelector('.panel')).toBeNull()

    await openPanel(element)
    expect(requests.map(r => r.action)).toEqual(['load'])
    expect(input(element, 'half_life_days').value).toBe('30')
    expect(input(element, 'importance_weight').value).toBe('0.3')
    expect(input(element, 'importancePrompt').value).toBe('What matters here?')
    expect(root(element).querySelector('.sum')!.textContent).toContain('1.00')
    expect(root(element).querySelector('.sum')!.textContent).toContain('2 earlier')
    // Nothing changed yet: nothing to save.
    expect(saveButton(element).disabled).toBe(true)
  })

  it('saves only what changed, and shows what the cell answers', async () => {
    const { element, requests } = await mount(detail => {
      if (detail.action === 'load') detail.respond({ config: CONFIG })
      else detail.respond({ config: { ...CONFIG, weights: { ...CONFIG.weights, half_life_days: 14 }, historyCount: 3 } })
    })
    await openPanel(element)
    await type(element, 'half_life_days', '14')
    await type(element, 'valencePrompt', 'A new valence prompt.')
    expect(saveButton(element).disabled).toBe(false)
    saveButton(element).click()
    await element.updateComplete

    expect(requests[1]!.action).toBe('save')
    expect(requests[1]!.patch).toEqual({ weights: { half_life_days: 14 }, valencePrompt: 'A new valence prompt.' })
    expect(root(element).querySelector('.sum')!.textContent).toContain('3 earlier')
    expect(root(element).querySelector('.status:not([hidden])')!.textContent).toContain('Saved')
  })

  it('refuses a half-life of 0, a negative weight, or an empty field', async () => {
    const { element } = await mount(detail => detail.respond({ config: CONFIG }))
    await openPanel(element)
    for (const [name, value] of [['half_life_days', '0'], ['temporal_weight', '-1'], ['doc_wires_ref', '']] as const) {
      await type(element, name, value)
      expect(saveButton(element).disabled, name).toBe(true)
      expect(input(element, name).getAttribute('aria-invalid'), name).toBe('true')
      await type(element, name, String(CONFIG.weights[name]))
    }
  })

  it('is read-only when the graph cannot be written', async () => {
    const { element } = await mount(detail => detail.respond({ config: CONFIG }), el => { el.writable = false })
    await openPanel(element)
    expect(input(element, 'importance_weight').disabled).toBe(true)
    expect(saveButton(element).disabled).toBe(true)
  })

  it('says so when no cell claims the request, and shows a cell error', async () => {
    const element = document.createElement('mn-salience-config')
    document.body.append(element)
    await element.updateComplete
    await openPanel(element)
    expect(root(element).querySelector('.status')!.textContent).toContain('none answered')

    document.body.replaceChildren()
    const failing = await mount(detail => detail.respond({ error: 'MCP error for get_values: boom' }))
    await openPanel(failing.element)
    expect(root(failing.element).querySelector('.status[data-kind="error"]')!.textContent).toContain('boom')
  })

  it('refuses a blank prompt: gardend would ignore it and report nothing saved', async () => {
    const { element } = await mount(detail => detail.respond({ config: CONFIG }))
    await openPanel(element)
    await type(element, 'importancePrompt', '   ')
    expect(saveButton(element).disabled).toBe(true)
    expect(input(element, 'importancePrompt').getAttribute('aria-invalid')).toBe('true')
  })

  it('keeps half-typed numbers, and reads the settings afresh on every open and for a new graph', async () => {
    let half = 30
    const { element, requests } = await mount(
      detail => detail.respond({ config: { ...CONFIG, weights: { ...CONFIG.weights, half_life_days: half } } }),
      el => { el.graphKey = 'graph-a' },
    )
    await openPanel(element)
    await type(element, 'half_life_days', '1e')
    expect(input(element, 'half_life_days').value).toBe('1e')
    expect(saveButton(element).disabled).toBe(true)

    // Closed and opened again: an agent may have revaluated meanwhile.
    half = 45
    await openPanel(element)
    await openPanel(element)
    expect(requests.filter(r => r.action === 'load')).toHaveLength(2)
    expect(input(element, 'half_life_days').value).toBe('45')

    // Another graph: the old settings go, and the new graph's load.
    half = 7
    element.graphKey = 'graph-b'
    await element.updateComplete
    await element.updateComplete
    expect(requests.filter(r => r.action === 'load')).toHaveLength(3)
    expect(input(element, 'half_life_days').value).toBe('7')
  })
})
