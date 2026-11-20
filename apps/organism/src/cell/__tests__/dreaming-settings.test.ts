import { describe, expect, it, vi } from 'vitest'
import '../dreaming-settings-editor.js'
import type { MnDreamingSettings } from '../dreaming-settings-editor.js'
import {
  configForDreamer,
  cycleErrorWords,
  dreamerKey,
  epochMs,
  networkWords,
  nightWindowWords,
  orderDreamers,
  type DetectedDreamer,
  type DreamerConfig,
  type DreamExclusions,
  type DreamGraphSettings,
  type DreamingApi,
  type DreamMechanicsView,
  type MechanicsEdits,
} from '../dreaming-api.js'

// Shapes as sampled from a debug garden on a temp profile, 2026-10-18.
const DREAMERS: DetectedDreamer[] = [
  { kind: 'app', preset: 'kimi', label: 'Kimi Code', program: '/k/kimi', isolation: 'isolated', found: true, recommended: true },
  { kind: 'app', preset: 'claude', label: 'Claude Code', program: '/c/claude', isolation: 'isolated', found: true, recommended: false },
  { kind: 'app', preset: 'codex', label: 'Codex', program: '/x/codex', isolation: 'sandboxed', found: true, recommended: false },
  { kind: 'endpoint', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: ['llama3.2:3b', 'gemma3:1b'], isolation: 'not-applicable', found: true, recommended: false },
  { kind: 'endpoint', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', isolation: 'not-applicable', found: false, recommended: false },
]

function graphSettings(over: Partial<DreamGraphSettings['effective']> = {}, settings: DreamGraphSettings['settings'] = {}): DreamGraphSettings {
  return {
    settings,
    effective: { residueDays: 5, default: true, nightly: null, catchUp: false, ...over },
    defaults: { residueDays: 5, nightly: false, catchUp: false },
    nightWindowHours: [1, 4],
    cooldownHours: 20,
    lastCycle: { lastStartedMs: null, lastTrigger: '', lastStatus: '', lastJobId: null },
    fileError: null,
  }
}

function field<T>(value: T, def: T = value) {
  return { value, default: def, edited: JSON.stringify(value) !== JSON.stringify(def) }
}

function mechanics(agreed: boolean, edits: Partial<Record<'dreamerPrompt' | 'astrologyEnabled', unknown>> = {}): DreamMechanicsView {
  const weights = { embedding: 0.1, structural: 0.25, valuation: 0.2, temporal: 0.2, articulability: 0.25 }
  return {
    notice: { version: 1, text: "we don't recommend changing them", agreed, agreedAt: agreed ? '1792343131481' : null },
    editable: {
      chargeWeights: field(weights),
      dreamerPrompt: field((edits.dreamerPrompt as string | undefined) ?? 'You are the Dreamer.', 'You are the Dreamer.'),
      scaling: field({ maxDreamsPerCycle: 3, scaleReferencePoint: 180, scaleMin: 0.3, scaleMax: 3 }),
      astrologyEnabled: field((edits.astrologyEnabled as boolean | undefined) ?? true, true),
      temporalCurve: field({ troughDays: 7, capDays: 180 }),
    },
    houseAuthored: { weaver: { minPerDream: 2 } },
  }
}

class FakeApi implements DreamingApi {
  config: DreamerConfig = { kind: 'none' }
  graph = graphSettings()
  excluded: DreamExclusions = { folders: [], documents: [] }
  view = mechanics(false)
  calls: [string, ...unknown[]][] = []
  dreamerConfig = vi.fn(async () => this.config)
  setDreamerConfig = vi.fn(async (config: DreamerConfig) => { this.calls.push(['setDreamerConfig', config]); this.config = config })
  listDreamers = vi.fn(async () => DREAMERS)
  testDreamer = vi.fn(async () => ({
    passed: true,
    reply: { json: {}, text: 'a dream of rivers', receipt: { kind: 'app', isolation: 'isolated', network: 'app', durationMs: 4200, ok: true } },
  }))
  graphSettings = vi.fn(async () => this.graph)
  setNightly = vi.fn(async (graphId: string, enabled: boolean) => {
    this.calls.push(['setNightly', graphId, enabled])
    this.graph = graphSettings({ nightly: { enabled, changedAt: '1792343131417' } })
  })
  setCatchUp = vi.fn(async (graphId: string, catchUp: boolean | null) => { this.calls.push(['setCatchUp', graphId, catchUp]) })
  setResidueDays = vi.fn(async (graphId: string, days: number | null) => { this.calls.push(['setResidueDays', graphId, days]) })
  exclusions = vi.fn(async () => this.excluded)
  setExclusions = vi.fn(async (graphId: string, next: DreamExclusions) => { this.calls.push(['setExclusions', graphId, next]); this.excluded = next })
  dreamNow = vi.fn(async (graphId: string, dryRun: boolean) => ({ graphId, status: dryRun ? 'prepared' : 'published', dryRun, prompts: ['[FRAGMENTS] one'], system: 'You are the Dreamer.' }))
  mechanics = vi.fn(async () => this.view)
  agreeToNotice = vi.fn(async () => { this.view = mechanics(true); return this.view })
  setMechanics = vi.fn(async (edits: MechanicsEdits) => { this.calls.push(['setMechanics', edits]); return this.view })
}

async function mount(api: FakeApi): Promise<MnDreamingSettings> {
  const el = document.createElement('mn-dreaming-settings') as MnDreamingSettings
  el.graphTitle = 'Home graph'
  el.listTargets = async () => ({
    folders: [{ id: 'folder-a', label: 'Private notes', path: null }],
    documents: [{ id: 'doc-a', label: 'Diary', path: 'Private notes' }],
  })
  el.api = api
  el.graphId = 'default_x1'
  document.body.appendChild(el)
  await settle(el)
  return el
}

async function settle(el: MnDreamingSettings): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise(r => setTimeout(r, 0))
    await el.updateComplete
  }
}

const q = <T extends Element>(el: MnDreamingSettings, selector: string) => el.shadowRoot!.querySelector<T>(selector)

describe('dreaming-api helpers', () => {
  it('orders found dreamers first, the recommended one first among them', () => {
    const shuffled = [DREAMERS[4]!, DREAMERS[1]!, DREAMERS[0]!, DREAMERS[3]!]
    expect(orderDreamers(shuffled).map(d => d.label)).toEqual(['Kimi Code', 'Claude Code', 'Ollama', 'LM Studio'])
  })

  it('maps a listed dreamer to the config it saves as', () => {
    expect(configForDreamer(DREAMERS[0]!)).toEqual({ kind: 'app', preset: 'kimi', program: '/k/kimi' })
    expect(configForDreamer(DREAMERS[2]!)).toEqual({ kind: 'app', preset: 'codex', program: '/x/codex', acceptReducedIsolation: false })
    expect(configForDreamer(DREAMERS[3]!)).toEqual({ kind: 'endpoint', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b' })
    expect(dreamerKey({ kind: 'endpoint', baseUrl: 'http://localhost:11434/v1/', model: 'x' })).toBe(dreamerKey(DREAMERS[3]!))
  })

  it('says where the fragments go', () => {
    expect(networkWords(DREAMERS[0]!)).toContain('its own model service over the network')
    expect(networkWords(DREAMERS[3]!)).toBe('the fragments stay on this computer')
    expect(networkWords({ kind: 'endpoint', baseUrl: 'https://openrouter.ai/api/v1', model: 'm' })).toContain('sent over the network')
  })

  it('turns gardend cycle errors into what to do in the app', () => {
    expect(cycleErrorWords('dreaming needs the semantic index: semantic index not found; run refresh_semantic_index first'))
      .toMatch(/^Dreaming reads this graph's semantic index.*Settings, Search & PDFs/)
    expect(cycleErrorWords('something else')).toBe('something else')
  })

  it('reads gardend times and the night window', () => {
    expect(epochMs('1792343131417')).toBe(1792343131417)
    expect(epochMs(null)).toBeNull()
    expect(nightWindowWords([1, 4])).toBe('1–4 a.m.')
  })
})

describe('mn-dreaming-settings', () => {
  it('keeps nightly consent off until a dreamer is saved, then names it and where the fragments go', async () => {
    const api = new FakeApi()
    const el = await mount(api)
    const nightly = q<HTMLInputElement>(el, '[data-dream-nightly]')!
    expect(nightly.checked).toBe(false)
    expect(nightly.disabled).toBe(true)
    expect(q(el, '[data-dreaming="nightly"]')!.textContent).toContain('Choose and save a dreamer above first')

    const picker = q<HTMLSelectElement>(el, 'select[aria-label="Dreamer"]')!
    picker.value = 'app:kimi'
    picker.dispatchEvent(new Event('change'))
    await settle(el)
    q<HTMLButtonElement>(el, '[data-dreamer-save]')!.click()
    await settle(el)
    expect(api.calls).toContainEqual(['setDreamerConfig', { kind: 'app', preset: 'kimi', program: '/k/kimi' }])

    const text = q(el, '[data-dreaming="nightly"]')!.textContent!.replace(/\s+/g, ' ')
    expect(text).toContain('between 1–4 a.m., using Kimi Code')
    expect(text).toContain('its own model service over the network')
    const enabled = q<HTMLInputElement>(el, '[data-dream-nightly]')!
    expect(enabled.disabled).toBe(false)
    enabled.checked = true
    enabled.dispatchEvent(new Event('change'))
    await settle(el)
    expect(api.calls).toContainEqual(['setNightly', 'default_x1', true])
    expect(q<HTMLInputElement>(el, '[data-dream-nightly]')!.checked).toBe(true)
  })

  it('will not save or test a sandboxed dreamer until reduced isolation is accepted', async () => {
    const api = new FakeApi()
    const el = await mount(api)
    const picker = q<HTMLSelectElement>(el, 'select[aria-label="Dreamer"]')!
    picker.value = 'app:codex'
    picker.dispatchEvent(new Event('change'))
    await settle(el)
    expect(q<HTMLButtonElement>(el, '[data-dreamer-save]')!.disabled).toBe(true)
    expect(q<HTMLButtonElement>(el, '[data-dreamer-test]')!.disabled).toBe(true)
    const accept = q<HTMLInputElement>(el, '[data-accept-reduced]')!
    accept.checked = true
    accept.dispatchEvent(new Event('change'))
    await settle(el)
    q<HTMLButtonElement>(el, '[data-dreamer-save]')!.click()
    await settle(el)
    expect(api.calls).toContainEqual(['setDreamerConfig', { kind: 'app', preset: 'codex', program: '/x/codex', acceptReducedIsolation: true }])
  })

  it('tests the unsaved choice and shows the receipt', async () => {
    const api = new FakeApi()
    const el = await mount(api)
    const picker = q<HTMLSelectElement>(el, 'select[aria-label="Dreamer"]')!
    picker.value = 'app:claude'
    picker.dispatchEvent(new Event('change'))
    await settle(el)
    q<HTMLButtonElement>(el, '[data-dreamer-test]')!.click()
    await settle(el)
    expect(api.testDreamer).toHaveBeenCalledWith({ kind: 'app', preset: 'claude', program: '/c/claude' })
    const result = q(el, '[data-dreamer-test-result]')!.textContent!
    expect(result).toContain('The dreamer answered.')
    expect(result).toContain('4.2 s')
    expect(result).toContain('network: app')
    expect(result).toContain('a dream of rivers')
    expect(api.setDreamerConfig).not.toHaveBeenCalled()
  })

  it('shows the mechanics before agreement but locks editing until the notice is agreed', async () => {
    const api = new FakeApi()
    const el = await mount(api)
    const prompt = q<HTMLTextAreaElement>(el, 'textarea[aria-label="The Dreamer prompt"]')!
    expect(prompt.value).toBe('You are the Dreamer.')
    expect(prompt.readOnly).toBe(true)
    expect(q(el, '[data-dreaming="mechanics"]')!.textContent).toContain('"minPerDream": 2')
    expect(q(el, '[data-mechanics-save]')).toBeNull()

    q<HTMLButtonElement>(el, '[data-mechanics-agree]')!.click()
    await settle(el)
    expect(api.agreeToNotice).toHaveBeenCalledWith(1)
    const editable = q<HTMLTextAreaElement>(el, 'textarea[aria-label="The Dreamer prompt"]')!
    expect(editable.readOnly).toBe(false)
    editable.value = 'You are a different dreamer.'
    editable.dispatchEvent(new Event('input'))
    await settle(el)
    q<HTMLButtonElement>(el, '[data-mechanics-save]')!.click()
    await settle(el)
    // Only fields that differ from the house default are sent.
    expect(api.calls).toContainEqual(['setMechanics', { dreamerPrompt: 'You are a different dreamer.' }])
  })

  it('resets one field without saving unsaved drafts in another', async () => {
    const api = new FakeApi()
    api.view = { ...mechanics(true, { dreamerPrompt: 'edited', astrologyEnabled: false }) }
    const el = await mount(api)
    // An unsaved draft in the prompt...
    const prompt = q<HTMLTextAreaElement>(el, 'textarea[aria-label="The Dreamer prompt"]')!
    prompt.value = 'unsaved draft'
    prompt.dispatchEvent(new Event('input'))
    await settle(el)
    // ...then reset astrology.
    const reset = q(el, '[data-mechanics-field="astrologyEnabled"]')!.querySelector<HTMLButtonElement>('button.link')!
    reset.click()
    await settle(el)
    expect(api.calls).toContainEqual(['setMechanics', { dreamerPrompt: 'edited' }])
  })

  it('adds and removes exclusions by name', async () => {
    const api = new FakeApi()
    const el = await mount(api)
    const folder = q<HTMLSelectElement>(el, '[data-exclude-folder]')!
    folder.value = 'folder-a'
    folder.dispatchEvent(new Event('change'))
    await settle(el)
    const doc = q<HTMLInputElement>(el, '[data-exclude-document]')!
    doc.value = 'Private notes / Diary'
    doc.dispatchEvent(new Event('change'))
    await settle(el)
    expect(api.excluded).toEqual({ folders: ['folder-a'], documents: ['doc-a'] })
    const chips = q(el, '[data-dream-exclusions]')!.textContent!
    expect(chips).toContain('Private notes')
    expect(chips).toContain('Private notes / Diary')
    q(el, '[data-dream-exclusions]')!.querySelector<HTMLButtonElement>('button')!.click()
    await settle(el)
    expect(api.excluded).toEqual({ folders: [], documents: ['doc-a'] })
  })

  it('previews without dreaming, and dreams only after a second click', async () => {
    const api = new FakeApi()
    api.config = { kind: 'app', preset: 'kimi', program: '/k/kimi' }
    const el = await mount(api)
    q<HTMLButtonElement>(el, '[data-dream-preview]')!.click()
    await settle(el)
    expect(api.dreamNow).toHaveBeenCalledWith('default_x1', true)
    expect(q(el, '[data-dream-result]')!.textContent).toContain('[FRAGMENTS] one')

    q<HTMLButtonElement>(el, '[data-dream-now]')!.click()
    await settle(el)
    expect(api.dreamNow).toHaveBeenCalledTimes(1)
    const confirm = q<HTMLButtonElement>(el, '[data-dream-confirm]')!
    expect(confirm.textContent).toContain('Dream now with Kimi Code')
    confirm.click()
    await settle(el)
    expect(api.dreamNow).toHaveBeenLastCalledWith('default_x1', false)
  })

  it('saves residue days and resets them to the default', async () => {
    const api = new FakeApi()
    const el = await mount(api)
    const input = q<HTMLInputElement>(el, '[data-dream-residue]')!
    input.value = '3'
    input.dispatchEvent(new Event('input'))
    await settle(el)
    q(el, '[data-dreaming="residue"]')!.querySelector<HTMLButtonElement>('button')!.click()
    await settle(el)
    expect(api.calls).toContainEqual(['setResidueDays', 'default_x1', 3])
  })
})
