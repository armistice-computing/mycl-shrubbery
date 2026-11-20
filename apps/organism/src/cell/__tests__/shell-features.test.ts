import { describe, expect, it, vi } from 'vitest'
import '@shrubbery/components'
import { REDUCED_MOTION_CHANGE_EVENT } from '@shrubbery/components'
import { synchronizedCrdtProviderLifecycle } from '@shrubbery/nucleus'
import type { ProviderHandle } from '@shrubbery/nucleus'
import type { MnBottomBar } from '@shrubbery/components'
import {
  createOrganismShellFeatureHost,
  ORGANISM_APPEARANCE_CHANGE_EVENT,
} from '../shell-features.js'
import { createShellContext } from '../shell-context.js'

function context(
  host: HTMLElement,
  rerender = vi.fn(),
  options: {
    graphId?: string
    documentId?: string | null
    toolsCall?: (name: string, args: Record<string, unknown>) => Promise<unknown>
    fetch?: typeof globalThis.fetch
  } = {},
) {
  return createShellContext({
    host,
    graphId: options.graphId ?? 'graph-a',
    documentId: options.documentId === undefined ? 'doc-a' : options.documentId,
    app: 'garden',
    source: 'CELL_LIVE',
    deploymentMode: 'playground',
    contract: {
      auth: {
        token: () => 'local-token',
        userId: () => 'local-user',
        whenReady: () => Promise.resolve(),
      },
      runtime: { graphBaseUrl: () => 'http://127.0.0.1:7777' },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.toolsCall ? { mcp: { toolsCall: options.toolsCall } } : {}),
    },
    location: new URL('http://localhost/'),
    rerender,
  })
}

class Awareness {
  clientID?: number
  readonly states = new Map<number, unknown>([
    [2, { user: { name: 'Nora', color: '#2563eb' } }],
  ])
  readonly listeners = new Set<() => void>()
  private localState: Record<string, unknown> | null = null
  getStates(): Map<number, unknown> { return this.states }
  getLocalState(): Record<string, unknown> | null { return this.localState }
  setLocalState(state: Record<string, unknown> | null): void {
    this.localState = state
    if (this.clientID !== undefined) {
      if (state) this.states.set(this.clientID, state)
      else this.states.delete(this.clientID)
    }
    for (const callback of this.listeners) callback()
  }
  setLocalStateField(field: string, value: unknown): void {
    this.setLocalState({ ...(this.localState ?? {}), [field]: value })
  }
  on(_event: 'change', callback: () => void): void { this.listeners.add(callback) }
  off(_event: 'change', callback: () => void): void { this.listeners.delete(callback) }
}

describe('createOrganismShellFeatureHost', () => {
  it('persists and reapplies the paper page and the editor font through the shell seam', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    document.documentElement.removeAttribute('data-editor-material')
    const root = document.createElement('div')
    const shellContext = context(root)
    const firstHost = createOrganismShellFeatureHost()
    try {
      const service = firstHost.routeOptions(shellContext, {}).settingsService!
      await service.select({
        sectionId: 'appearance',
        settingId: 'editorMaterial',
        value: 'paper',
      })
      expect(document.documentElement.dataset.editorMaterial).toBe('paper')
      await service.select({ sectionId: 'appearance', settingId: 'editorFont', value: 'piazzolla' })
      expect(document.documentElement.style.getPropertyValue('--mn-editor-font')).toContain('Piazzolla')
      await service.select({ sectionId: 'appearance', settingId: 'blockSpacing', value: 'comfortable' })
      expect(document.documentElement.style.getPropertyValue('--mn-editor-block-gap')).toBe('var(--mn-space-2, 0.5rem)')

      document.documentElement.removeAttribute('data-editor-material')
      document.documentElement.style.removeProperty('--mn-editor-font')
      document.documentElement.style.removeProperty('--mn-editor-block-gap')
      const restoredHost = createOrganismShellFeatureHost()
      restoredHost.workspaceSnapshot(shellContext, {})
      expect(document.documentElement.dataset.editorMaterial).toBe('paper')
      expect(document.documentElement.style.getPropertyValue('--mn-editor-font')).toContain('Piazzolla')
      expect(document.documentElement.style.getPropertyValue('--mn-editor-block-gap')).toBe('var(--mn-space-2, 0.5rem)')
      restoredHost.destroy()
      await service.select({ sectionId: 'appearance', settingId: 'editorFont', value: 'default' })
      expect(document.documentElement.style.getPropertyValue('--mn-editor-font')).toBe('')
      await service.select({ sectionId: 'appearance', settingId: 'blockSpacing', value: 'default' })
      expect(document.documentElement.style.getPropertyValue('--mn-editor-block-gap')).toBe('')

      await service.select({
        sectionId: 'appearance',
        settingId: 'editorMaterial',
        value: 'continuous',
      })
      expect(document.documentElement.hasAttribute('data-editor-material')).toBe(false)
    } finally {
      firstHost.destroy()
      vi.unstubAllGlobals()
      document.documentElement.removeAttribute('data-editor-material')
    }
  })

  it('restores reduced motion and announces changes to continuous renderers', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    let changes = 0
    const listener = () => { changes += 1 }
    document.addEventListener(REDUCED_MOTION_CHANGE_EVENT, listener)
    const host = createOrganismShellFeatureHost()
    try {
      const service = host.routeOptions(context(document.createElement('div')), {}).settingsService!
      await service.toggle({ sectionId: 'appearance', settingId: 'reducedMotion', checked: true })
      expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true)
      expect(changes).toBe(1)

      document.documentElement.removeAttribute('data-reduced-motion')
      host.workspaceSnapshot(context(document.createElement('div')), {})
      expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(true)
    } finally {
      host.destroy()
      document.removeEventListener(REDUCED_MOTION_CHANGE_EVENT, listener)
      document.documentElement.removeAttribute('data-reduced-motion')
      vi.unstubAllGlobals()
    }
  })

  it('applies a skin through the same persisted Settings/chrome appearance seam', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    })
    const changes: unknown[] = []
    const listener = (event: Event) => changes.push((event as CustomEvent).detail)
    document.addEventListener(ORGANISM_APPEARANCE_CHANGE_EVENT, listener)
    const host = createOrganismShellFeatureHost()
    try {
      const service = host.routeOptions(context(document.createElement('div')), {}).settingsService!
      // Garden is the only global skin: selecting it clears any stale data-skin.
      document.documentElement.dataset.skin = 'research'
      document.body.dataset.skin = 'research'
      await service.select({ sectionId: 'appearance', settingId: 'skin', value: 'garden' })
      await service.select({ sectionId: 'appearance', settingId: 'theme', value: 'dark' })
      expect(document.documentElement.hasAttribute('data-skin')).toBe(false)
      expect(document.body.hasAttribute('data-skin')).toBe(false)
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(changes).toEqual([{ skin: 'garden' }, { theme: 'dark' }])

      document.documentElement.dataset.theme = 'light'
      host.workspaceSnapshot(context(document.createElement('div')), {})
      expect(document.documentElement.hasAttribute('data-skin')).toBe(false)
      expect(document.documentElement.dataset.theme).toBe('dark')
    } finally {
      host.destroy()
      document.removeEventListener(ORGANISM_APPEARANCE_CHANGE_EVENT, listener)
      vi.unstubAllGlobals()
      document.documentElement.removeAttribute('data-skin')
      document.body.removeAttribute('data-skin')
      document.documentElement.dataset.theme = 'light'
      document.body.dataset.theme = 'light'
    }
  })

  it('contributes a capability-scoped controlled settings service without a main.ts adapter', async () => {
    const host = createOrganismShellFeatureHost()
    const root = document.createElement('div')
    const options = host.routeOptions(context(root), {})
    const snapshot = await options.settingsService!.load()
    expect(snapshot.userName).toBe('local-user')
    expect(snapshot.sections.map(section => section.id)).toEqual([
      'appearance', 'interface', 'agents', 'help', 'api-mcp',
    ])
    expect(snapshot.sections.map(section => section.id)).not.toContain('local-ai')
    expect(snapshot.sections.find(section => section.id === 'api-mcp')?.metrics).toEqual([
      { id: 'api-base', label: 'API base', value: 'http://127.0.0.1:7777' },
      { id: 'mcp-url', label: 'MCP endpoint', value: 'http://127.0.0.1:7777/mcp' },
    ])
    host.destroy()
  })

  it('activates authenticated gardend Settings operations through the production feature seam', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return new Response(JSON.stringify({ restorePoints: [], nextCursor: null, totalCount: 0 }), {
        headers: { 'content-type': 'application/json' },
      })
    }))
    try {
      const root = document.createElement('div')
      const shellContext = createShellContext({
        host: root,
        graphId: 'graph-a',
        documentId: 'doc-a',
        app: 'garden',
        source: 'CELL_LIVE',
        deploymentMode: 'playground',
        contract: {
          auth: {
            token: () => 'local-token',
            userId: () => 'local-user',
            isAuthenticated: () => true,
            whenReady: () => Promise.resolve(),
            onChange: () => () => undefined,
          },
          runtime: {
            mode: () => 'local' as const,
            isGateway: () => false,
            graphBaseUrl: () => 'http://127.0.0.1:7777',
          },
          ui: {
            confirm: async () => true,
            icon: () => ({}) as never,
            presenceColors: [],
          },
        },
        location: new URL('http://localhost/settings'),
        rerender: vi.fn(),
      })
      const host = createOrganismShellFeatureHost()
      const service = host.routeOptions(shellContext, {}).settingsService!
      const snapshot = await service.load()

      expect(requests.map(request => request.url)).toEqual(expect.arrayContaining([
        'http://127.0.0.1:7777/v1/time-travel/graph-a/restore-points?limit=50',
        'http://127.0.0.1:7777/api/semantic/model/status',
        'http://127.0.0.1:7777/api/semantic/models',
        'http://127.0.0.1:7777/api/semantic/index/status/graph-a',
        'http://127.0.0.1:7777/api/artifacts/ingestion/approaches',
        'http://127.0.0.1:7777/api/artifacts/ingestion/docling/status',
        'http://127.0.0.1:7777/api/artifacts/ingestion/pdf/pipeline',
      ]))
      expect(requests.every(request => request.authorization === 'Bearer local-token')).toBe(true)
      // Every importer this release offers is live; Notion and Roam say "Coming soon".
      expect(snapshot.sections.find(section => section.id === 'imports')?.actions?.filter(action => !action.comingSoon).every(action => action.disabled === false)).toBe(true)
      expect(snapshot.sections.find(section => section.id === 'graph-ops')?.actions?.filter(action => !action.disabled).map(action => action.id)).toEqual([
        'duplicate-graph', 'export-graph', 'import-graph',
      ])
      expect(snapshot.sections.find(section => section.id === 'local-ai')).toBeDefined()
      expect(service.subscribe).toBeTypeOf('function')
      host.destroy()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('projects live editor/sidebar/provider state and subscribes through the provider hook', async () => {
    const root = document.createElement('div')
    const editor = document.createElement('div') as unknown as HTMLElement & {
      liveEditor: { getText(): string }
    }
    editor.id = 'mn-editor-host'
    editor.liveEditor = { getText: () => 'One two three' }
    root.appendChild(editor)
    const rerender = vi.fn()
    const shellContext = context(root, rerender)
    const awareness = new Awareness()
    const provider: ProviderHandle = {
      doc: {},
      awareness,
      lifecycle: synchronizedCrdtProviderLifecycle(),
      whenRenderable: Promise.resolve(),
      whenEditable: Promise.resolve(),
      whenSynced: Promise.resolve(),
      renderSource: Promise.resolve('live'),
      destroy() {},
    }
    const host = createOrganismShellFeatureHost()
    const unbind = host.bindProvider(provider, shellContext)
    const snapshot = host.workspaceSnapshot(shellContext, {
      chrome: { activeApp: 'garden' },
      sidebar: {
        sections: [{ id: 'docs', label: 'Docs', nodes: [
          { id: 'doc-a', label: 'Living Map', kind: 'document' },
          { id: 'artifact-a', label: 'Diagram', kind: 'artifact' },
        ] }],
      },
    })

    expect(snapshot.chrome).toMatchObject({
      activeApp: 'garden',
      itemCount: 2,
      documentStats: { words: 3, characters: 13 },
      presence: [{ id: '2', name: 'Nora', color: '#2563eb' }],
      runtimeMode: 'local',
    })
    expect(snapshot.chrome?.breadcrumbs?.[1]).toMatchObject({
      id: 'doc-a',
      label: 'Living Map',
      current: true,
    })
    await Promise.resolve()
    expect(rerender).toHaveBeenCalled()
    unbind()
    expect(awareness.listeners.size).toBe(0)
    host.destroy()
  })

  it('wires controlled presence inspect, exact-tab follow, and real self awareness updates', async () => {
    const root = document.createElement('div')
    const bar = document.createElement('mn-bottom-bar') as MnBottomBar
    root.append(bar)
    const editorHost = document.createElement('div')
    editorHost.id = 'mn-editor-host'
    const editorShadow = editorHost.attachShadow({ mode: 'open' })
    const remoteCursor = document.createElement('span')
    remoteCursor.className = 'ProseMirror-yjs-cursor'
    remoteCursor.dataset.presenceClientId = 'ada-tab'
    remoteCursor.scrollIntoView = vi.fn()
    editorShadow.append(remoteCursor)
    root.append(editorHost)

    const awareness = new Awareness()
    awareness.clientID = 1
    awareness.setLocalState({
      user: {
        userId: 'nora', name: 'Nora', color: '#2563eb', type: 'human',
        clientId: 'nora-tab', deviceId: 'nora-device',
      },
      presence: {
        humanId: 'nora', deviceId: 'nora-device', clientId: 'nora-tab',
        connectionEpoch: 1, publishedAt: 1,
      },
    })
    awareness.states.set(2, {
      user: {
        userId: 'ada', name: 'Ada', color: '#16a34a', type: 'human',
        clientId: 'ada-tab', deviceId: 'ada-device',
      },
      cursor: { anchor: {}, head: {} },
      presence: {
        humanId: 'ada', deviceId: 'ada-device', clientId: 'ada-tab',
        connectionEpoch: 1, publishedAt: 2,
      },
    })
    const provider: ProviderHandle = {
      doc: {},
      awareness,
      lifecycle: synchronizedCrdtProviderLifecycle(),
      whenRenderable: Promise.resolve(),
      whenEditable: Promise.resolve(),
      whenSynced: Promise.resolve(),
      renderSource: Promise.resolve('live'),
      destroy() {},
    }
    const rerender = vi.fn()
    const shellContext = context(root, rerender)
    const host = createOrganismShellFeatureHost()
    host.bindProvider(provider, shellContext)

    const project = () => host.workspaceSnapshot(shellContext, { chrome: {} })
    let snapshot = project()
    bar.presence = snapshot.chrome?.presence ?? []
    host.afterWorkspaceRender(shellContext, snapshot)
    const ada = bar.presence.find(person => person.id === 'human:ada')!
    const nora = bar.presence.find(person => person.id === 'human:nora')!

    bar.dispatchEvent(new CustomEvent('mn-presence-open', {
      detail: { person: ada }, bubbles: true, composed: true,
    }))
    snapshot = project()
    bar.presence = snapshot.chrome?.presence ?? []
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(bar.openPresenceId).toBe('human:ada')

    bar.dispatchEvent(new CustomEvent('mn-presence-follow', {
      detail: { person: ada, session: ada.sessions![0], following: true },
      bubbles: true, composed: true,
    }))
    snapshot = project()
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(bar.followedPresenceClientId).toBe('ada-tab')
    expect(remoteCursor.dataset.presenceFollowed).toBe('true')
    expect(remoteCursor.scrollIntoView).toHaveBeenCalled()

    bar.dispatchEvent(new CustomEvent('mn-presence-self-update', {
      detail: { person: nora, name: 'Nora Prime', color: '#7c3aed' },
      bubbles: true, composed: true,
    }))
    expect(awareness.getLocalState()?.user).toMatchObject({
      userId: 'nora', name: 'Nora Prime', color: '#7c3aed', type: 'human',
    })
    host.destroy()
  })

  it('derives reader availability from source metadata and persists Make Editable through MCP', async () => {
    const root = document.createElement('div')
    const editor = document.createElement('div') as HTMLElement & {
      originalFileView?: {
        available?: boolean
        active?: boolean
        filename?: string
        pdf?: { canAnnotate?: boolean; annotations?: unknown[] } | null
      }
    }
    editor.id = 'mn-editor-host'
    root.appendChild(editor)
    const rerender = vi.fn()
    const toolsCall = vi.fn(async () => ({ success: true, readOnly: false }))
    // The PDF reader controller loads eagerly on scope; keep the cell seam
    // network-free in tests (404 before any engine work).
    const fetch = vi.fn(async () => new Response('missing', { status: 404 })) as unknown as typeof globalThis.fetch
    const shellContext = context(root, rerender, { toolsCall, fetch })
    const host = createOrganismShellFeatureHost()
    const base = {
      sidebar: {
        sections: [{ id: 'documents', label: 'Documents', nodes: [{
          id: 'doc-a',
          label: 'Imported Paper',
          kind: 'document' as const,
          readOnly: true,
          sourceFile: {
            storageKey: 'local://artifacts/paper/original/paper.pdf',
            originalFilename: 'paper.pdf',
            mimeType: 'application/pdf',
            fileType: 'pdf',
          },
        }] }],
      },
    }

    const first = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, first)
    expect(first.editorDocumentAccess).toMatchObject({ readOnly: true, makeEditableStatus: 'idle' })
    // PDF sources open original-first: active by default, with the controlled
    // reader state merged in (annotation layer intentionally empty this slice).
    expect(editor.originalFileView).toMatchObject({ available: true, active: true, filename: 'paper.pdf' })
    // The reader controller ran the document-original route plus the artifact
    // fallback; the merged view then carries its snapshot.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    const settled = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, settled)
    expect(editor.originalFileView?.pdf).toMatchObject({ canAnnotate: false, annotations: [] })

    root.dispatchEvent(new CustomEvent('mn-editor-make-editable', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(toolsCall).toHaveBeenCalledWith('make_document_editable', {
      graphId: 'graph-a',
      documentId: 'doc-a',
    })
    const after = host.workspaceSnapshot(shellContext, base)
    expect(after.editorDocumentAccess).toMatchObject({ readOnly: false, makeEditableStatus: 'idle' })

    const otherGraph = context(root, rerender, { graphId: 'graph-b', toolsCall })
    const isolated = host.workspaceSnapshot(otherGraph, {
      sidebar: { sections: [{ id: 'documents', label: 'Documents', nodes: [{
        id: 'doc-a', label: 'Same ID, no source', kind: 'document', readOnly: true,
      }] }] },
    })
    host.afterWorkspaceRender(otherGraph, isolated)
    expect(isolated.editorDocumentAccess).toMatchObject({ readOnly: true })
    expect(editor.originalFileView).toMatchObject({ available: false })
    host.destroy()
  })

  it('routes document-scope pdf intents only from the editor host, and honors the session toggle-off', async () => {
    const root = document.createElement('div')
    const editor = document.createElement('div') as HTMLElement & {
      originalFileView?: { active?: boolean; pdf?: { zoom?: number } | null }
    }
    editor.id = 'mn-editor-host'
    root.appendChild(editor)
    // The artifact surface lives OUTSIDE #mn-editor-host; its pdf events must
    // never steer the document reader.
    const artifactElsewhere = document.createElement('div')
    root.appendChild(artifactElsewhere)
    const rerender = vi.fn()
    let fetchCalls = 0
    const fetch = vi.fn(async () => {
      fetchCalls += 1
      return new Response('missing', { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const shellContext = context(root, rerender, { fetch })
    const host = createOrganismShellFeatureHost()
    const base = {
      sidebar: {
        sections: [{ id: 'documents', label: 'Documents', nodes: [{
          id: 'doc-a',
          label: 'Imported Paper',
          kind: 'document' as const,
          readOnly: true,
          sourceFile: {
            storageKey: 'local://artifacts/paper/original/paper.pdf',
            originalFilename: 'paper.pdf',
            mimeType: 'application/pdf',
            fileType: 'pdf',
          },
        }] }],
      },
    }

    let snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView).toMatchObject({ active: true })
    expect(editor.originalFileView?.pdf?.zoom).toBe(1)

    // Reader intents from inside the editor host reach the controller.
    editor.dispatchEvent(new CustomEvent('mn-pdf-zoom-change', {
      detail: { zoom: 1.6, mode: 'in' }, bubbles: true, composed: true,
    }))
    snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView?.pdf?.zoom).toBe(1.6)

    // The same intent from outside the editor host is ignored.
    artifactElsewhere.dispatchEvent(new CustomEvent('mn-pdf-zoom-change', {
      detail: { zoom: 2.4, mode: 'in' }, bubbles: true, composed: true,
    }))
    snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView?.pdf?.zoom).toBe(1.6)

    const callsBeforeReload = fetchCalls
    editor.dispatchEvent(new CustomEvent('mn-pdf-reload', { bubbles: true, composed: true }))
    await vi.waitFor(() => expect(fetchCalls).toBeGreaterThan(callsBeforeReload))

    // The toolbar toggle turns the surface off; rerenders never re-activate it.
    root.dispatchEvent(new CustomEvent('mn-editor-original-view-toggle', { bubbles: true, composed: true }))
    snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView?.active).toBe(false)
    snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView?.active).toBe(false)
    host.destroy()
  })

  it('routes explicit source-mode intents, and open-original returns to Original without reloading', async () => {
    const root = document.createElement('div')
    const editor = document.createElement('div') as HTMLElement & {
      originalFileView?: {
        active?: boolean
        mode?: string
        pdf?: { mode?: string } | null
      }
    }
    editor.id = 'mn-editor-host'
    root.appendChild(editor)
    const rerender = vi.fn()
    let fetchCalls = 0
    const fetch = vi.fn(async () => {
      fetchCalls += 1
      return new Response('missing', { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const shellContext = context(root, rerender, { fetch })
    const host = createOrganismShellFeatureHost()
    const base = {
      sidebar: {
        sections: [{ id: 'documents', label: 'Documents', nodes: [{
          id: 'doc-a',
          label: 'Imported Paper',
          kind: 'document' as const,
          readOnly: true,
          sourceFile: {
            storageKey: 'local://artifacts/paper/original/paper.pdf',
            originalFilename: 'paper.pdf',
            mimeType: 'application/pdf',
            fileType: 'pdf',
          },
        }] }],
      },
    }

    let snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    await vi.waitFor(() => expect(fetchCalls).toBeGreaterThan(0))
    expect(editor.originalFileView).toMatchObject({ active: true, mode: 'original' })

    // The explicit mode setter switches surfaces without re-fetching bytes or
    // touching the annotation store (no companion is created by a mode change).
    const callsAtReady = fetchCalls
    root.dispatchEvent(new CustomEvent('mn-editor-original-mode-change', {
      detail: { mode: 'annotations' }, bubbles: true, composed: true,
    }))
    snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView).toMatchObject({ active: true, mode: 'annotations' })
    expect(fetchCalls).toBe(callsAtReady)

    // open-original from the annotation list returns to Original.
    editor.dispatchEvent(new CustomEvent('mn-pdf-annotation-open-original', {
      detail: { annotationId: 'ann-1' }, bubbles: true, composed: true,
    }))
    snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView).toMatchObject({ active: true, mode: 'original' })
    expect(fetchCalls).toBe(callsAtReady)

    // Document mode is the explicit opt-out, sticky across rerenders.
    root.dispatchEvent(new CustomEvent('mn-editor-original-mode-change', {
      detail: { mode: 'document' }, bubbles: true, composed: true,
    }))
    snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView).toMatchObject({ active: false, mode: 'document' })
    snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView).toMatchObject({ active: false, mode: 'document' })
    host.destroy()
  })

  it('refuses Annotations mode for a non-PDF original', async () => {
    const root = document.createElement('div')
    const editor = document.createElement('div') as HTMLElement & {
      originalFileView?: { active?: boolean; mode?: string }
    }
    editor.id = 'mn-editor-host'
    root.appendChild(editor)
    const rerender = vi.fn()
    const shellContext = context(root, rerender, {
      fetch: vi.fn(async () => new Response('missing', { status: 404 })) as unknown as typeof globalThis.fetch,
    })
    const host = createOrganismShellFeatureHost()
    const base = {
      sidebar: {
        sections: [{ id: 'documents', label: 'Documents', nodes: [{
          id: 'doc-a',
          label: 'Imported Notes',
          kind: 'document' as const,
          readOnly: true,
          sourceFile: {
            storageKey: 'local://artifacts/notes/original/notes.md',
            originalFilename: 'notes.md',
            mimeType: 'text/markdown',
            fileType: 'md',
          },
        }] }],
      },
    }

    let snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView).toMatchObject({ available: true, active: false, mode: 'document' })

    root.dispatchEvent(new CustomEvent('mn-editor-original-mode-change', {
      detail: { mode: 'annotations' }, bubbles: true, composed: true,
    }))
    snapshot = host.workspaceSnapshot(shellContext, base)
    host.afterWorkspaceRender(shellContext, snapshot)
    expect(editor.originalFileView).toMatchObject({ active: false, mode: 'document' })
    host.destroy()
  })
})
