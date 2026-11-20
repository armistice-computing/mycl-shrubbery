import { describe, expect, it } from 'vitest'
import {
  createDefaultSettingsService,
  graphSubject,
  persistAppearancePreferences,
  readAppearancePreferences,
  readEditorMaterialPreference,
  readAskDocumentNamePreference,
  readHomeListPreference,
  readHomeListsPreference,
  readReducedMotionPreference,
  readShowSongPreference,
  readEditorTypePreferences,
  applyEditorTypePreferences,
  resolveThemePreference,
} from '../settings-service.js'
import { TauriDreamingApi } from '../dreaming-api.js'
import { GardendFilesSettingsApi } from '../files-settings-api.js'

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

describe('DefaultOrganismSettingsService', () => {
  it('publishes the Dreaming page only in the desktop app, where its Tauri commands exist', async () => {
    const dreaming = { api: new TauriDreamingApi(async () => { throw new Error('not called while projecting') }), graphId: 'default_x1' }
    const local = createDefaultSettingsService({ runtimeMode: 'local', dreaming })
    const sections = (await local.load()).sections
    expect(local.dreaming).toBe(dreaming)
    expect(sections.find(section => section.id === 'dreaming')).toMatchObject({ wide: true, contentSlot: 'dreaming' })
    const ids = sections.map(section => section.id)
    // Right after Local AI when that shows; never without the commands.
    if (ids.includes('local-ai')) expect(ids.indexOf('dreaming')).toBe(ids.indexOf('local-ai') + 1)
    expect((await createDefaultSettingsService({ runtimeMode: 'local' }).load()).sections.some(s => s.id === 'dreaming')).toBe(false)
    expect((await createDefaultSettingsService({ runtimeMode: 'hosted', dreaming }).load()).sections.some(s => s.id === 'dreaming')).toBe(false)
  })

  it('publishes the Files page only when the shell can read the graph', async () => {
    const files = {
      graphId: 'fileslist',
      api: new GardendFilesSettingsApi({
        graphId: 'fileslist',
        rest: { async query() { throw new Error('not called while projecting') } },
        contract: {
          auth: { token: () => undefined, userId: () => 'local', whenReady: async () => undefined } as never,
          runtime: { graphBaseUrl: () => '' } as never,
        },
      }),
    }
    const service = createDefaultSettingsService({ runtimeMode: 'local', files })
    expect(service.files).toBe(files)
    expect((await service.load()).sections.find(section => section.id === 'files'))
      .toMatchObject({ title: 'Files', wide: true, contentSlot: 'files' })
    expect((await createDefaultSettingsService({ runtimeMode: 'local' }).load()).sections.some(s => s.id === 'files')).toBe(false)
  })

  it('has no Account page in the desktop app until sync exists', async () => {
    const snapshot = await createDefaultSettingsService({ runtimeMode: 'local' }).load()
    expect(snapshot.sections.map(section => section.id)).not.toContain('account')
    expect(snapshot.sections[0]?.id).toBe('appearance')
  })

  it('keeps Terminal enabled state in the native backend, never localStorage', async () => {
    const storage = new MemoryStorage()
    const calls: string[] = []
    let enabled = false
    const terminal = {
      loadSettings: async () => { calls.push('get'); return enabled },
      setEnabled: async (value: boolean) => { calls.push(`set:${value}`); enabled = value },
      snapshot: () => ({ available: true, enabled }),
    }
    const service = createDefaultSettingsService({ runtimeMode: 'local', storage, terminal })
    const interfaceSection = (await service.load()).sections.find(section => section.id === 'interface')!
    expect(interfaceSection.toggles?.find(toggle => toggle.id === 'terminalEnabled')).toMatchObject({
      checked: false,
      disabled: false,
    })

    await service.toggle({ sectionId: 'interface', settingId: 'terminalEnabled', checked: true })
    expect(calls).toEqual(['get', 'set:true'])
    expect(storage.values.size).toBe(0)
    const reloaded = (await service.load()).sections.find(section => section.id === 'interface')!
    expect(reloaded.toggles?.find(toggle => toggle.id === 'terminalEnabled')?.checked).toBe(true)
  })

  it('disables the Terminal toggle when native support is absent', async () => {
    const terminal = {
      loadSettings: async () => false,
      setEnabled: async () => { throw new Error('must not be called') },
      snapshot: () => ({ available: false, enabled: false }),
    }
    const service = createDefaultSettingsService({ runtimeMode: 'local', terminal })
    const interfaceSection = (await service.load()).sections.find(section => section.id === 'interface')!
    expect(interfaceSection.toggles?.find(toggle => toggle.id === 'terminalEnabled')).toMatchObject({
      checked: false,
      disabled: true,
    })
  })

  it('keeps the restart-only compositing preference in the native backend', async () => {
    const storage = new MemoryStorage()
    const calls: string[] = []
    let settings = { supported: true, disableCompositing: false }
    const graphics = {
      loadSettings: async () => { calls.push('get'); return settings },
      setDisableCompositing: async (disabled: boolean) => {
        calls.push(`set:${disabled}`)
        settings = { ...settings, disableCompositing: disabled }
      },
    }
    const service = createDefaultSettingsService({ runtimeMode: 'local', storage, graphics })
    const appearance = (await service.load()).sections.find(section => section.id === 'appearance')!
    expect(appearance.toggles?.find(toggle => toggle.id === 'disableCompositing')).toMatchObject({
      checked: false,
      description: expect.stringContaining('restarting'),
    })

    await service.toggle({ sectionId: 'appearance', settingId: 'disableCompositing', checked: true })
    expect(calls).toEqual(['get', 'set:true'])
    expect(storage.values.size).toBe(0)
    const reloaded = (await service.load()).sections.find(section => section.id === 'appearance')!
    expect(reloaded.toggles?.find(toggle => toggle.id === 'disableCompositing')?.checked).toBe(true)
  })

  it('hides the compositing preference where the native backend does not support it', async () => {
    const graphics = {
      loadSettings: async () => ({ supported: false, disableCompositing: false }),
      setDisableCompositing: async () => { throw new Error('must not be called') },
    }
    const service = createDefaultSettingsService({ runtimeMode: 'local', graphics })
    const appearance = (await service.load()).sections.find(section => section.id === 'appearance')!
    expect(appearance.toggles?.some(toggle => toggle.id === 'disableCompositing')).toBe(false)
  })

  it('publishes only settings backed by this runtime instead of disabled placeholders', async () => {
    const service = createDefaultSettingsService({
      runtimeMode: 'hosted',
      userName: 'Nora',
      userEmail: 'nora@example.test',
      apiBaseUrl: 'https://api.example.test',
      mcpUrl: 'https://api.example.test/g/graph/mcp',
    })
    const snapshot = await service.load()
    expect(snapshot.userEmail).toBe('nora@example.test')
    expect(snapshot.sections.map(section => section.id)).toEqual([
      'account', 'appearance', 'interface', 'help', 'api-mcp',
    ])
    expect(snapshot.sections.flatMap(section => [
      ...(section.toggles ?? []).map(setting => setting.id),
      ...(section.selects ?? []).map(setting => setting.id),
    ])).not.toEqual(expect.arrayContaining(['density', 'restoreLastDocument', 'autoSync']))
    expect(snapshot.sections.find(section => section.id === 'api-mcp')?.metrics).toEqual([
      { id: 'api-base', label: 'API base', value: 'https://api.example.test' },
      { id: 'mcp-url', label: 'MCP endpoint', value: 'https://api.example.test/g/graph/mcp' },
    ])
    expect(snapshot.sections.flatMap(section => section.actions ?? [])).toEqual([])
  })

  it('persists controlled toggle/select changes and reflects them after reload', async () => {
    const storage = new MemoryStorage()
    const service = createDefaultSettingsService({ runtimeMode: 'local', storage })
    await service.toggle({ sectionId: 'appearance', settingId: 'reducedMotion', checked: true })
    await service.select({ sectionId: 'appearance', settingId: 'editorMaterial', value: 'paper' })
    await service.select({ sectionId: 'appearance', settingId: 'theme', value: 'dark' })
    const snapshot = await service.load()
    const appearance = snapshot.sections.find(section => section.id === 'appearance')!
    expect(appearance.toggles?.find(toggle => toggle.id === 'reducedMotion')?.checked).toBe(true)
    expect(appearance.selects?.find(select => select.id === 'editorMaterial')?.value).toBe('paper')
    expect(appearance.selects?.find(select => select.id === 'theme')?.value).toBe('dark')
    expect(readEditorMaterialPreference(storage)).toBe('paper')
    expect(readReducedMotionPreference(storage)).toBe(true)
    expect(storage.values.size).toBe(1)

    await service.select({ sectionId: 'appearance', settingId: 'editorMaterial', value: 'continuous' })
    expect(readEditorMaterialPreference(storage)).toBe('continuous')
  })

  it("lets each of Home's two lists be created, edited or opened, defaulting to created then opened", async () => {
    const storage = new MemoryStorage()
    const service = createDefaultSettingsService({ runtimeMode: 'local', storage })
    const select = (id: string) => service.load().then(snapshot => snapshot.sections.find(section => section.id === 'interface')!.selects?.find(item => item.id === id))
    expect((await select('homeList'))?.value).toBe('created')
    expect((await select('homeListSecond'))?.value).toBe('opened')
    expect((await select('homeListSecond'))?.options.map(option => option.label)).toEqual(['Recently created', 'Recently edited', 'Recently opened'])
    expect(readHomeListsPreference(storage)).toEqual({ first: 'created', second: 'opened' })
    await service.select({ sectionId: 'interface', settingId: 'homeList', value: 'opened' })
    await service.select({ sectionId: 'interface', settingId: 'homeListSecond', value: 'updated' })
    expect(readHomeListsPreference(storage)).toEqual({ first: 'opened', second: 'updated' })
    expect(readHomeListPreference(storage)).toBe('opened')
  })

  it("keeps an 11/17 'Last updated' choice for Home's first list", () => {
    const storage = new MemoryStorage()
    storage.setItem('shrubbery.organism.settings.v1', JSON.stringify({ homeList: 'updated' }))
    expect(readHomeListsPreference(storage)).toEqual({ first: 'updated', second: 'opened' })
  })

  it('hides the Song on Home until it is turned on', async () => {
    const storage = new MemoryStorage()
    const service = createDefaultSettingsService({ runtimeMode: 'local', storage })
    const toggle = () => service.load().then(snapshot => snapshot.sections.find(section => section.id === 'interface')!.toggles?.find(item => item.id === 'homeSong'))
    expect((await toggle())?.checked).toBe(false)
    expect(readShowSongPreference(storage)).toBe(false)
    await service.toggle({ sectionId: 'interface', settingId: 'homeSong', checked: true })
    expect(readShowSongPreference(storage)).toBe(true)
    expect((await toggle())?.checked).toBe(true)
    await service.toggle({ sectionId: 'interface', settingId: 'homeSong', checked: false })
    expect(readShowSongPreference(storage)).toBe(false)
  })

  it('reads an old saved showSong as no choice: the Song stays off until turned on', () => {
    const storage = new MemoryStorage()
    // A profile saved before 11/20 holds the old default.
    storage.setItem('shrubbery.organism.settings.v1', JSON.stringify({ showSong: true, homeList: 'created' }))
    expect(readShowSongPreference(storage)).toBe(false)
    storage.setItem('shrubbery.organism.settings.v1', JSON.stringify({ showSong: false }))
    expect(readShowSongPreference(storage)).toBe(false)
  })

  it('asks for a new document\'s name by default, and remembers when that is turned off', async () => {
    const storage = new MemoryStorage()
    const service = createDefaultSettingsService({ runtimeMode: 'local', storage })
    const toggle = () => service.load().then(snapshot => snapshot.sections.find(section => section.id === 'interface')!.toggles?.find(item => item.id === 'askDocumentName'))
    expect((await toggle())?.checked).toBe(true)
    expect(readAskDocumentNamePreference(storage)).toBe(true)
    await service.toggle({ sectionId: 'interface', settingId: 'askDocumentName', checked: false })
    expect((await toggle())?.checked).toBe(false)
    expect(readAskDocumentNamePreference(storage)).toBe(false)
  })

  it('retires the Classic Word page: a stored choice reads back as the paper page', async () => {
    const storage = new MemoryStorage()
    storage.setItem('shrubbery.organism.settings.v1', JSON.stringify({ editorMaterial: 'classic-word' }))
    expect(readEditorMaterialPreference(storage)).toBe('paper')
    const service = createDefaultSettingsService({ runtimeMode: 'local', storage })
    const appearance = (await service.load()).sections.find(section => section.id === 'appearance')!
    const material = appearance.selects?.find(select => select.id === 'editorMaterial')
    expect(material?.value).toBe('paper')
    expect(material?.options.map(option => option.value)).toEqual(['continuous', 'paper'])
  })

  it('persists editor typography and block spacing, and rejects values outside the catalogs', async () => {
    const storage = new MemoryStorage()
    const service = createDefaultSettingsService({ runtimeMode: 'local', storage })
    expect(readEditorTypePreferences(storage)).toEqual({ editorFont: 'default', lineWidth: 'default', blockSpacing: 'default', textSize: '100', valueMarkers: 'hover' })
    await service.select({ sectionId: 'appearance', settingId: 'editorFont', value: 'piazzolla' })
    await service.select({ sectionId: 'appearance', settingId: 'lineWidth', value: 'narrow' })
    await service.select({ sectionId: 'appearance', settingId: 'blockSpacing', value: 'spacious' })
    await service.select({ sectionId: 'appearance', settingId: 'textSize', value: '125' })
    expect(readEditorTypePreferences(storage)).toEqual({ editorFont: 'piazzolla', lineWidth: 'narrow', blockSpacing: 'spacious', textSize: '125', valueMarkers: 'hover' })
    const appearance = (await service.load()).sections.find(section => section.id === 'appearance')!
    expect(appearance.selects?.find(select => select.id === 'editorFont')?.value).toBe('piazzolla')
    expect(appearance.selects?.find(select => select.id === 'blockSpacing')?.value).toBe('spacious')

    await service.select({ sectionId: 'appearance', settingId: 'editorFont', value: 'comic-sans' })
    await service.select({ sectionId: 'appearance', settingId: 'textSize', value: '400' })
    await service.select({ sectionId: 'appearance', settingId: 'lineWidth', value: 'toString' })
    await service.select({ sectionId: 'appearance', settingId: 'blockSpacing', value: 'enormous' })
    expect(readEditorTypePreferences(storage)).toEqual({ editorFont: 'default', lineWidth: 'default', blockSpacing: 'default', textSize: '100', valueMarkers: 'hover' })
  })

  it('writes editor typography as root custom properties and removes them at default', () => {
    const props = new Map<string, string>()
    const attrs = new Map<string, string>()
    const root = {
      style: {
        setProperty: (name: string, value: string | null) => { props.set(name, value ?? '') },
        removeProperty: (name: string) => { props.delete(name); return '' },
      },
      setAttribute: (name: string, value: string) => { attrs.set(name, value) },
      removeAttribute: (name: string) => { attrs.delete(name) },
    }
    applyEditorTypePreferences({ editorFont: 'piazzolla', lineWidth: 'full', blockSpacing: 'spacious', textSize: '110', valueMarkers: 'hidden' }, root)
    expect(props.get('--mn-editor-font')).toContain("'Piazzolla Variable'")
    expect(props.get('--mn-editor-font-weight')).toBe('450')
    expect(props.get('--mn-editor-line-width')).toBe('10000px')
    expect(props.get('--mn-editor-block-gap')).toBe('var(--mn-space-4, 1rem)')
    expect(props.get('--mn-editor-text-scale')).toBe('1.1')
    expect(attrs.get('data-value-markers')).toBe('hidden')
    applyEditorTypePreferences({ editorFont: 'default', lineWidth: 'default', blockSpacing: 'default', textSize: '100', valueMarkers: 'hover' }, root)
    expect(props.size).toBe(0)
    expect(attrs.has('data-value-markers')).toBe(false)
  })

  it('shows no Skin picker while Garden is the only skin, and persists appearance', async () => {
    const storage = new MemoryStorage()
    const service = createDefaultSettingsService({ runtimeMode: 'local', storage })
    const initial = await service.load()
    const skin = initial.sections.find(section => section.id === 'appearance')
      ?.selects?.find(select => select.id === 'skin')
    expect(skin).toBeUndefined()

    await service.select({ sectionId: 'appearance', settingId: 'skin', value: 'garden' })
    expect(readAppearancePreferences(storage)).toEqual({ skin: 'garden', theme: 'system' })

    persistAppearancePreferences(storage, { skin: 'garden', theme: 'dark' })
    expect(readAppearancePreferences(storage)).toEqual({ skin: 'garden', theme: 'dark' })
    expect(resolveThemePreference('system', true)).toBe('dark')
    expect(resolveThemePreference('system', false)).toBe('light')
  })

  it('overwrites removed and unknown stored identities with Garden', () => {
    const storage = new MemoryStorage()
    storage.setItem('shrubbery.organism.settings.v1', JSON.stringify({ skin: 'sophia' }))
    expect(readAppearancePreferences(storage).skin).toBe('garden')
    storage.setItem('shrubbery.organism.settings.v1', JSON.stringify({ skin: 'emporium' }))
    expect(readAppearancePreferences(storage).skin).toBe('garden')
    storage.setItem('shrubbery.organism.settings.v1', JSON.stringify({ skin: 'not-a-skin' }))
    expect(readAppearancePreferences(storage).skin).toBe('garden')
    expect(JSON.parse(storage.getItem('shrubbery.organism.settings.v1') ?? '{}').skin).toBe('garden')
  })

  it('migrates the former paperPage boolean without losing an opted-in page', async () => {
    const storage = new MemoryStorage()
    storage.setItem('shrubbery.organism.settings.v1', JSON.stringify({ paperPage: true }))
    expect(readEditorMaterialPreference(storage)).toBe('paper')
    const snapshot = await createDefaultSettingsService({ runtimeMode: 'local', storage }).load()
    const material = snapshot.sections.find(section => section.id === 'appearance')
      ?.selects?.find(select => select.id === 'editorMaterial')
    expect(material?.value).toBe('paper')
  })

  it('offers no OpenRouter key in the desktop app: image generation is held back', async () => {
    const invoke = async <T>(command: string): Promise<T> => {
      if (command === 'provider_key_status') return { openrouter: false } as T
      return undefined as T
    }
    const snapshot = await createDefaultSettingsService({ runtimeMode: 'local', invoke }).load()
    expect(snapshot.sections.find(section => section.id === 'api-keys')).toBeUndefined()
    // Search & PDFs needs the node's model and PDF readers, not a provider key.
    expect(snapshot.sections.find(section => section.id === 'local-ai')).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('OpenRouter')
  })

  it('projects a hosted Choreograph credential store as account-scoped OpenRouter only', async () => {
    let configured = false
    const writes: string[] = []
    const service = createDefaultSettingsService({
      runtimeMode: 'hosted',
      apiBaseUrl: 'https://api.example.test/g/graph-a',
      mcpUrl: 'https://api.example.test/g/graph-a/mcp',
      providerSecrets: {
        providers: ['openrouter'],
        storageLabel: 'Choreograph account secret store',
        async status() { return { openrouter: configured } },
        async store(provider, secret) {
          expect(provider).toBe('openrouter')
          writes.push(secret)
          configured = true
        },
        async delete(provider) {
          expect(provider).toBe('openrouter')
          configured = false
        },
      },
      promptSecret: () => 'hosted-sentinel-secret',
    })

    let snapshot = await service.load()
    expect(snapshot.sections.map(section => section.id)).toEqual([
      'account', 'appearance', 'interface', 'help', 'api-keys', 'api-mcp',
    ])
    expect(snapshot.sections.find(section => section.id === 'local-ai')).toBeUndefined()
    expect(snapshot.sections.find(section => section.id === 'api-keys')?.secrets?.map(secret => secret.id)).toEqual(['openrouter'])

    await service.secret({ sectionId: 'api-keys', secretId: 'openrouter', action: 'configure' })
    snapshot = await service.load()
    expect(snapshot.sections.find(section => section.id === 'api-keys')?.secrets?.[0].configured).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('hosted-sentinel-secret')
    expect(writes).toEqual(['hosted-sentinel-secret'])

    await service.secret({ sectionId: 'api-keys', secretId: 'openrouter', action: 'delete' })
    snapshot = await service.load()
    expect(snapshot.sections.find(section => section.id === 'api-keys')?.secrets?.[0].configured).toBe(false)
  })
})

describe('Graph Ops names the current graph', () => {
  it('shows the graph name, with its id when they differ', () => {
    expect(graphSubject({ id: 'default_x1', title: 'My notes' })).toEqual({
      title: 'My notes',
      detail: 'Graph ID: default_x1. Duplicate, export and restore act on this graph.',
    })
    expect(graphSubject({ id: 'notes' })?.title).toBe('notes')
    expect(graphSubject(null)).toBeNull()
  })

})
