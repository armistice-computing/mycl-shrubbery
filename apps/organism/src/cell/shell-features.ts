/**
 * Organism shell-feature composition root.
 *
 * Add independent feature controllers to this list. `main.ts` is already wired
 * to the resulting host at every lifecycle boundary, so feature work does not
 * need to edit the monolithic shell again.
 */

import { REDUCED_MOTION_CHANGE_EVENT } from '@shrubbery/components'
import type {
  ChromePresenceFollowDetail,
  ChromePresenceOpenDetail,
  ChromePresenceSelfUpdateDetail,
  MnBottomBar,
  MnEditorOriginalModeDetail,
  MnPdfAnnotateDetail,
  MnPdfAnnotationSelectDetail,
  MnSettingsActionDetail,
  MnSettingsSelectChangeDetail,
  MnSettingsToggleChangeDetail,
  MnTerminalPane,
} from '@shrubbery/components'
import type { ShrubberyContract } from '@shrubbery/nucleus'
import type { RenderWorkspaceOptions, SidebarNode } from '@shrubbery/runtime'
import {
  applyEditorMaterial,
  applySkin,
  applyTheme,
  isVisualIdentitySkin,
  type Theme,
  type VisualIdentitySkin,
} from '@shrubbery/tokens'
import {
  type AccessGrantGateway,
  type AccessGrantUi,
  OrganismAccessGrantController,
} from './access-grant-controller.js'
import {
  OrganismChromeController,
  revealFollowedPresenceCursor,
} from './chrome-controller.js'
import { PRESENCE_COLORS } from './crdt-presence.js'
import { GardendLocalAiSettings } from './local-ai-settings.js'
import { OrganismOriginalFileController, isPdfSourceFile } from './original-file-controller.js'
import { OrganismPdfReaderController } from './pdf-reader-controller.js'
import type { ProviderSecretStore } from './provider-secret-store.js'
import { GardendSettingsOperations } from './settings-operations.js'
import {
  createDefaultSettingsService,
  type GraphicsSettingsContext,
  type GraphicsSettingsSnapshot,
  readAppearancePreferences,
  readEditorMaterialPreference,
  readEditorTypePreferences,
  readReducedMotionPreference,
  readTerminalAppearance,
  applyEditorTypePreferences,
  resolveThemePreference,
} from './settings-service.js'
import type { ShellContext } from './shell-context.js'
import {
  createShellFeatureHost,
  type ShellFeature,
  type ShellFeatureHost,
} from './shell-feature-host.js'
import {
  makeSidebarDocumentEditable,
  type SidebarMutationMcp,
} from './sidebar-mutations.js'
import { OrganismTtsController, type TtsEditorHost } from './tts-controller.js'
import { TauriDreamingApi } from './dreaming-api.js'
import { GardendFilesSettingsApi } from './files-settings-api.js'
import { GardendAgentsSettingsApi } from './agents-settings-api.js'
import type { DreamingTargets } from './dreaming-settings-editor.js'
import { loadSidebarSections, sidebarFolderOptionsFromSections, type SidebarDocumentRest } from './sidebar-documents.js'
import { documentSwitcherDocumentsFromSidebar } from './document-switcher.js'
import {
  AGENT_STUDIO_GRAPH_ID,
  AgentStudioApi,
  type AgentStudioMcp,
} from './agent-studio-api.js'
import './agent-studio-editor.js'
import type { MnAgentStudioEditor } from './agent-studio-editor.js'
import { OrganismTerminalController, type TerminalIpc } from './terminal-controller.js'
import { createTauriTerminalIpc } from './terminal-ipc.js'

interface FeatureContract {
  readonly auth?: {
    userId(): string
    signOut?(): Promise<void>
  }
  readonly runtime?: {
    graphBaseUrl(graphId: string): string
  }
  readonly providerSecrets?: ProviderSecretStore
  readonly rawMcp?: AgentStudioMcp
}

const agentStudioApis = new WeakMap<object, AgentStudioApi>()

function agentStudioApiFor(value: unknown): AgentStudioApi | undefined {
  if (!value || typeof value !== 'object') return undefined
  const rawMcp = (value as Partial<FeatureContract>).rawMcp
  if (!rawMcp || typeof rawMcp !== 'object') return undefined
  const key = rawMcp as object
  let api = agentStudioApis.get(key)
  if (!api) {
    api = new AgentStudioApi(rawMcp)
    agentStudioApis.set(key, api)
  }
  return api
}

export const ORGANISM_APPEARANCE_CHANGE_EVENT = 'mn-organism-appearance-change'

export interface OrganismAppearanceChangeDetail {
  readonly skin?: VisualIdentitySkin
  readonly theme?: Theme
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

interface TauriGlobal {
  readonly __TAURI_INTERNALS__?: { readonly invoke?: TauriInvoke }
}

function browserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'object' ? globalThis.localStorage : null
  } catch {
    return null
  }
}

function nativeInvoke(): TauriInvoke | undefined {
  return (globalThis as TauriGlobal).__TAURI_INTERNALS__?.invoke
}

function nativeGraphicsSettings(): GraphicsSettingsContext | null {
  const invoke = nativeInvoke()
  if (!invoke) return null
  return {
    loadSettings: () => invoke<GraphicsSettingsSnapshot>('graphics_settings_get'),
    setDisableCompositing: async disabled => {
      await invoke<void>('graphics_settings_set', { disabled })
    },
  }
}

let sharedTerminalController: OrganismTerminalController | null = null
let terminalRerender: (() => void) | null = null

function lazyTerminalIpc(): TerminalIpc {
  const native = createTauriTerminalIpc()
  const requireIpc = async (): Promise<TerminalIpc> => {
    const ipc = await native
    if (!ipc) throw new Error('The terminal is available only in the Mycl desktop app')
    return ipc
  }
  return {
    settingsGet: async () => (await requireIpc()).settingsGet(),
    settingsSet: async enabled => (await requireIpc()).settingsSet(enabled),
    open: async (cols, rows, onFrame) => (await requireIpc()).open(cols, rows, onFrame),
    write: async (sessionId, data) => (await requireIpc()).write(sessionId, data),
    resize: async (sessionId, cols, rows) => (await requireIpc()).resize(sessionId, cols, rows),
    close: async sessionId => (await requireIpc()).close(sessionId),
  }
}

function terminalControllerFor(rerender: () => void): OrganismTerminalController {
  terminalRerender = rerender
  sharedTerminalController ??= new OrganismTerminalController({
    ipc: lazyTerminalIpc(),
    requestRender: () => terminalRerender?.(),
  })
  return sharedTerminalController
}

export function organismTerminalEnabled(): boolean {
  return sharedTerminalController?.snapshot().enabled ?? false
}

/**
 * This graph's folders and documents for the Dreaming page's exclusions,
 * read the way the sidebar reads them. Folders carry their parent path.
 */
async function dreamingTargets(rest: SidebarDocumentRest, graphId: string): Promise<DreamingTargets> {
  const sections = await loadSidebarSections(rest, graphId, null)
  const folders = sidebarFolderOptionsFromSections(sections).filter(folder => folder.section === 'documents')
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const pathOf = (parentId: string | null): string | null => {
    const names: string[] = []
    for (let id = parentId, guard = 0; id && guard < 64; guard += 1) {
      const folder = byId.get(id)
      if (!folder) break
      names.unshift(folder.name)
      id = folder.parentId
    }
    return names.length ? names.join(' / ') : null
  }
  return {
    folders: folders.map(folder => ({ id: folder.id, label: folder.name, path: pathOf(folder.parentId) })),
    documents: documentSwitcherDocumentsFromSidebar(sections, graphId)
      .map(document => ({ id: document.id, label: document.label, path: document.path ?? null })),
  }
}

function findNode(nodes: readonly SidebarNode[], id: string): SidebarNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const nested = findNode(node.children ?? [], id)
    if (nested) return nested
  }
  return null
}

function documentTitle(options: Readonly<RenderWorkspaceOptions>, documentId: string | null): string | null {
  if (!documentId) return null
  for (const section of options.sidebar?.sections ?? []) {
    const node = findNode(section.nodes ?? [], documentId)
    if (node) return node.label
  }
  return null
}

function editorText(context: ShellContext<unknown>): string | null {
  const host = context.host.querySelector('#mn-editor-host') as {
    liveEditor?: { getText(): string } | null
  } | null
  return host?.liveEditor?.getText() ?? null
}

function editorHost(context: ShellContext<unknown>): TtsEditorHost | null {
  return context.host.querySelector('#mn-editor-host') as TtsEditorHost | null
}

type OriginalFileContract = Pick<ShrubberyContract, 'auth' | 'runtime'>
type ImportedDocumentContract = OriginalFileContract & { readonly mcp?: SidebarMutationMcp }

function originalFileContract(value: unknown): OriginalFileContract | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<OriginalFileContract>
  const auth = candidate.auth
  const runtime = candidate.runtime
  return auth
    && typeof auth.token === 'function'
    && typeof auth.userId === 'function'
    && typeof auth.whenReady === 'function'
    && runtime
    && typeof runtime.graphBaseUrl === 'function'
    ? candidate as OriginalFileContract
    : null
}

type SettingsOperationsContract = Pick<ShrubberyContract, 'auth' | 'runtime' | 'ui'>

function settingsOperationsContract(value: unknown): SettingsOperationsContract | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<SettingsOperationsContract>
  return candidate.auth
    && typeof candidate.auth.token === 'function'
    && typeof candidate.auth.userId === 'function'
    && candidate.runtime
    && typeof candidate.runtime.graphBaseUrl === 'function'
    && candidate.ui
    && typeof candidate.ui.confirm === 'function'
    ? candidate as SettingsOperationsContract
    : null
}

interface HostedAccessContract {
  readonly auth: { userId(): string }
  readonly gateway: AccessGrantGateway
  readonly ui: AccessGrantUi
}

function hostedAccessContract(value: unknown): HostedAccessContract | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<HostedAccessContract>
  return candidate.auth
    && typeof candidate.auth.userId === 'function'
    && candidate.gateway
    && typeof candidate.gateway.access === 'function'
    && typeof candidate.gateway.putAccess === 'function'
    && typeof candidate.gateway.deleteAccess === 'function'
    && candidate.ui
    && typeof candidate.ui.confirm === 'function'
    ? candidate as HostedAccessContract
    : null
}

function applyPreference(
  detail: MnSettingsToggleChangeDetail | MnSettingsSelectChangeDetail,
): void {
  const root = document.documentElement
  if ('value' in detail && detail.settingId === 'theme') {
    const preference = detail.value === 'light' || detail.value === 'dark'
      ? detail.value
      : 'system'
    const theme = resolveThemePreference(preference)
    applyTheme({ theme, target: root })
    applyTheme({ theme, target: document.body })
    document.dispatchEvent(new CustomEvent<OrganismAppearanceChangeDetail>(
      ORGANISM_APPEARANCE_CHANGE_EVENT,
      { detail: { theme } },
    ))
  } else if ('value' in detail && detail.settingId === 'skin') {
    const skin = isVisualIdentitySkin(detail.value) ? detail.value : 'garden'
    applySkin({ skin, target: root })
    applySkin({ skin, target: document.body })
    document.dispatchEvent(new CustomEvent<OrganismAppearanceChangeDetail>(
      ORGANISM_APPEARANCE_CHANGE_EVENT,
      { detail: { skin } },
    ))
  } else if ('checked' in detail && detail.settingId === 'reducedMotion') {
    root.toggleAttribute('data-reduced-motion', detail.checked)
    document.dispatchEvent(new CustomEvent(REDUCED_MOTION_CHANGE_EVENT))
  } else if ('value' in detail && detail.settingId === 'editorMaterial') {
    applyEditorMaterial({ material: detail.value === 'paper' ? 'paper' : 'continuous', target: root })
  } else if ('value' in detail && (detail.settingId === 'editorFont' || detail.settingId === 'lineWidth' || detail.settingId === 'blockSpacing' || detail.settingId === 'textSize' || detail.settingId === 'valueMarkers')) {
    // The service persisted the change before calling here.
    applyEditorTypePreferences(readEditorTypePreferences(browserStorage()), root)
  } else if ('value' in detail && (detail.settingId === 'terminalFont' || detail.settingId === 'terminalSize')) {
    // The pane takes its font from the next workspace render.
    terminalRerender?.()
  }
}

function applyStoredAppearance(): void {
  applyEditorTypePreferences(readEditorTypePreferences(browserStorage()), document.documentElement)
  document.documentElement.toggleAttribute(
    'data-reduced-motion',
    readReducedMotionPreference(browserStorage()),
  )
  const appearance = readAppearancePreferences(browserStorage())
  const theme = resolveThemePreference(appearance.theme)
  for (const target of [document.documentElement, document.body]) {
    applySkin({ skin: appearance.skin, target })
    applyTheme({ theme, target })
  }
}

async function settingsAction(
  context: ShellContext<unknown>,
  detail: MnSettingsActionDetail,
  apiBaseUrl: string,
  mcpUrl: string,
): Promise<void> {
  const contract = context.contract as FeatureContract | null
  if (detail.actionId === 'sign-out' && contract?.auth?.signOut) {
    await contract.auth.signOut()
    globalThis.location?.assign('/signin')
    return
  }
  if (detail.actionId === 'copy-api-url' || detail.actionId === 'copy-mcp-url') {
    const value = detail.actionId === 'copy-api-url' ? apiBaseUrl : mcpUrl
    await globalThis.navigator?.clipboard?.writeText(value)
    return
  }
  if (detail.actionId === 'open-history' && context.documentId) {
    document.dispatchEvent(new CustomEvent('mn-editor-history-open', {
      detail: { documentId: context.documentId },
      bubbles: true,
      composed: true,
    }))
  }
}

const SETTINGS_ACTIONS = new Set(['sign-out', 'copy-api-url', 'copy-mcp-url', 'open-history'])

function settingsFeature<TContract>(): ShellFeature<TContract> {
  return {
    id: 'settings-controller',
    workspaceSnapshot() {
      applyStoredAppearance()
      applyEditorMaterial({
        material: readEditorMaterialPreference(browserStorage()),
        target: document.documentElement,
      })
    },
    routeOptions(context) {
      applyStoredAppearance()
      applyEditorMaterial({
        material: readEditorMaterialPreference(browserStorage()),
        target: document.documentElement,
      })
      const contract = context.contract as FeatureContract | null
      const runtimeMode = context.deploymentMode === 'hosted' ? 'hosted' : 'local'
      const base = contract?.runtime?.graphBaseUrl(context.graphId) ?? ''
      const invoke = nativeInvoke()
      const operationsContract = settingsOperationsContract(context.contract)
      const operations = operationsContract
        ? new GardendSettingsOperations(
            operationsContract,
            context.graphId,
            context.documentId,
            runtimeMode,
          )
        : undefined
      const localAi = operationsContract && runtimeMode === 'local'
        ? new GardendLocalAiSettings(operationsContract, context.graphId)
        : undefined
      const rest = (context.contract as { rest?: SidebarDocumentRest } | null)?.rest
      // Dreaming's commands are Tauri IPC only, so the page exists only in the app.
      const dreaming = invoke && runtimeMode === 'local' && context.graphId
        ? {
            api: new TauriDreamingApi(invoke as ConstructorParameters<typeof TauriDreamingApi>[0]),
            graphId: context.graphId,
            ...(context.graphTitle ? { graphTitle: context.graphTitle } : {}),
            ...(rest && typeof rest.query === 'function'
              ? { listTargets: () => dreamingTargets(rest, context.graphId) }
              : {}),
          }
        : undefined
      const filesContract = originalFileContract(context.contract)
      // The allowed folders live on gardend's owner control plane, so the
      // page exists only on a local cell.
      const files = runtimeMode === 'local' && filesContract && rest && typeof rest.query === 'function' && context.graphId
        ? {
            api: new GardendFilesSettingsApi({ rest, contract: filesContract, graphId: context.graphId }),
            graphId: context.graphId,
          }
        : undefined
      // Agent keys live on gardend's owner control plane, like the folders.
      const agents = runtimeMode === 'local' && filesContract && context.graphId
        ? {
            api: new GardendAgentsSettingsApi({
              contract: filesContract,
              graphId: context.graphId,
              invoke: invoke ? (command, args) => (invoke as (c: string, a?: Record<string, unknown>) => Promise<unknown>)(command, args) : null,
            }),
          }
        : undefined
      return {
        settingsService: createDefaultSettingsService({
          runtimeMode,
          userName: contract?.auth?.userId() ?? (runtimeMode === 'local' ? 'Local user' : ''),
          apiBaseUrl: base,
          mcpUrl: base ? `${base.replace(/\/$/, '')}/mcp` : '',
          storage: browserStorage(),
          invoke,
          providerSecrets: contract?.providerSecrets,
          ...(context.graphId ? { graph: { id: context.graphId, title: context.graphTitle ?? null } } : {}),
          operations,
          localAi,
          dreaming,
          files,
          agents,
          // Seeding the Getting Started pages and wiping are Tauri commands.
          help: { nativeAvailable: Boolean(invoke) && runtimeMode === 'local' },
          terminal: terminalControllerFor(context.rerender),
          graphics: nativeGraphicsSettings() ?? undefined,
          onPreferenceChange: applyPreference,
          isActionAvailable: actionId => SETTINGS_ACTIONS.has(actionId) && (
            actionId !== 'sign-out' || typeof contract?.auth?.signOut === 'function'
          ) && (actionId !== 'open-history' || Boolean(context.documentId)),
          onAction: detail => settingsAction(context, detail, base, base ? `${base.replace(/\/$/, '')}/mcp` : ''),
        }),
      }
    },
  }
}

export function createAgentStudioWorkspaceFeature<TContract>(): ShellFeature<TContract> {
  return {
    id: 'agent-studio-workspace',
    afterWorkspaceRender(context) {
      const editors = context.host.querySelectorAll<MnAgentStudioEditor>('mn-agent-studio-editor')
      const api = context.graphId === AGENT_STUDIO_GRAPH_ID
        ? agentStudioApiFor(context.contract)
        : undefined
      for (const editor of editors) {
        editor.workspaceSurface = true
        editor.api = api ?? null
      }
    },
  }
}

function chromeFeature<TContract>(): ShellFeature<TContract> {
  let controller: OrganismChromeController | null = null
  let listeningRoot: HTMLElement | null = null
  const ensure = (context: ShellContext<TContract>): OrganismChromeController => {
    controller ??= new OrganismChromeController({
      runtimeMode: context.deploymentMode === 'hosted' ? 'hosted' : 'local',
      requestRender: context.rerender,
    })
    return controller
  }
  const onPresenceOpen = (event: Event): void => {
    const detail = (event as CustomEvent<ChromePresenceOpenDetail>).detail
    if (detail?.person?.id) controller?.openPresence(detail.person.id)
  }
  const onPresenceClose = (): void => controller?.closePresence()
  const onPresenceFollow = (event: Event): void => {
    const detail = (event as CustomEvent<ChromePresenceFollowDetail>).detail
    if (!detail?.session?.clientId) return
    controller?.setFollowedPresenceClient(detail.session.clientId, detail.following)
  }
  const onPresenceSelfUpdate = (event: Event): void => {
    const detail = (event as CustomEvent<ChromePresenceSelfUpdateDetail>).detail
    if (!detail?.person?.id) return
    controller?.updateSelfPresence(detail.person.id, {
      ...(detail.name === undefined ? {} : { name: detail.name }),
      ...(detail.color === undefined ? {} : { color: detail.color }),
    })
  }
  const onPresenceOverflowToggle = (event: Event): void => {
    const detail = (event as CustomEvent<{ readonly open?: boolean }>).detail
    controller?.setPresenceOverflowOpen(Boolean(detail?.open))
  }
  const listen = (root: HTMLElement): void => {
    if (listeningRoot === root) return
    if (listeningRoot) {
      listeningRoot.removeEventListener('mn-presence-open', onPresenceOpen)
      listeningRoot.removeEventListener('mn-presence-close', onPresenceClose)
      listeningRoot.removeEventListener('mn-presence-follow', onPresenceFollow)
      listeningRoot.removeEventListener('mn-presence-self-update', onPresenceSelfUpdate)
      listeningRoot.removeEventListener('mn-presence-overflow-toggle', onPresenceOverflowToggle)
    }
    listeningRoot = root
    root.addEventListener('mn-presence-open', onPresenceOpen)
    root.addEventListener('mn-presence-close', onPresenceClose)
    root.addEventListener('mn-presence-follow', onPresenceFollow)
    root.addEventListener('mn-presence-self-update', onPresenceSelfUpdate)
    root.addEventListener('mn-presence-overflow-toggle', onPresenceOverflowToggle)
  }
  return {
    id: 'workspace-chrome-controller',
    bindProvider(provider, context) {
      ensure(context).bindProvider(provider)
      return () => controller?.bindProvider(null)
    },
    workspaceSnapshot(context, snapshot) {
      const projection = ensure(context).snapshot({
        graphId: context.graphId,
        documentId: context.documentId,
        documentTitle: documentTitle(snapshot, context.documentId),
        sidebarSections: snapshot.sidebar?.sections,
        editorText: editorText(context as ShellContext<unknown>),
      })
      return {
        chrome: {
          ...snapshot.chrome,
          ...projection,
          documentExportAvailable: Boolean(context.documentId),
          onBreadcrumbOpen: ({ breadcrumb }) => {
            if (breadcrumb.kind === 'graph') {
              context.host.dispatchEvent(new CustomEvent('mn-navigate-home', {
                bubbles: true,
                composed: true,
              }))
            }
          },
          onBreadcrumbMenuOpen: (detail) => {
            context.host.dispatchEvent(new CustomEvent('mn-breadcrumb-menu-open', {
              detail,
              bubbles: true,
              composed: true,
            }))
          },
        },
      }
    },
    afterWorkspaceRender(context) {
      listen(context.host)
      const bar = context.host.querySelector('mn-bottom-bar') as MnBottomBar | null
      const interaction = controller?.interactionState()
      if (bar && interaction) {
        bar.openPresenceId = interaction.openPresenceId
        bar.followedPresenceClientId = interaction.followedPresenceClientId
        bar.selfPresenceEditable = interaction.selfPresenceEditable
        bar.presenceColors = PRESENCE_COLORS
        bar.presenceOverflowOpen = interaction.presenceOverflowOpen
      }
      revealFollowedPresenceCursor(
        context.host,
        interaction?.followedPresenceClientId ?? null,
      )
    },
    destroy() {
      if (listeningRoot) {
        listeningRoot.removeEventListener('mn-presence-open', onPresenceOpen)
        listeningRoot.removeEventListener('mn-presence-close', onPresenceClose)
        listeningRoot.removeEventListener('mn-presence-follow', onPresenceFollow)
        listeningRoot.removeEventListener('mn-presence-self-update', onPresenceSelfUpdate)
        listeningRoot.removeEventListener('mn-presence-overflow-toggle', onPresenceOverflowToggle)
      }
      controller?.destroy()
      controller = null
      listeningRoot = null
    },
  }
}

function hostedAccessFeature<TContract>(): ShellFeature<TContract> {
  let controller: OrganismAccessGrantController | null = null
  const ensure = (context: ShellContext<TContract>): OrganismAccessGrantController => {
    controller ??= new OrganismAccessGrantController({ requestRender: context.rerender })
    return controller
  }
  return {
    id: 'hosted-access-grants',
    workspaceSnapshot(context, snapshot) {
      const contract = context.deploymentMode === 'hosted'
        ? hostedAccessContract(context.contract)
        : null
      const currentUserId = contract?.auth.userId().trim() ?? ''
      if (!contract || !currentUserId || !context.graphId.trim()) {
        controller?.setScope(null)
        return {
          chrome: {
            ...snapshot.chrome,
            access: null,
          },
        }
      }
      const workspace = snapshot.chrome?.workspaces?.find(item => item.graphId === context.graphId)
      const graphCrumb = snapshot.chrome?.breadcrumbs?.find(item => item.kind === 'graph')
      const active = ensure(context)
      active.setScope({
        gateway: contract.gateway,
        ui: contract.ui,
        graphId: context.graphId,
        graphTitle: workspace?.title || graphCrumb?.label || context.graphId,
        currentUserId,
        roleHint: workspace?.role ?? 'unknown',
      })
      return {
        chrome: {
          ...snapshot.chrome,
          access: active.snapshot(),
        },
      }
    },
    destroy() {
      controller?.destroy()
      controller = null
    },
  }
}

function ttsFeature<TContract>(): ShellFeature<TContract> {
  let controller: OrganismTtsController | null = null
  const ensure = (context: ShellContext<TContract>): OrganismTtsController => {
    controller ??= new OrganismTtsController({ requestRender: context.rerender })
    return controller
  }
  return {
    id: 'browser-tts-controller',
    bindProvider(_provider, context) {
      const active = ensure(context)
      active.setScope(context.graphId, context.documentId)
      // Provider cleanup can run inside Organism's authoritative render path;
      // reset synchronously without recursively requesting another render.
      return () => active.stop(false)
    },
    workspaceSnapshot(context) {
      const active = ensure(context)
      active.setScope(context.graphId, context.documentId)
      active.setEditorHost(editorHost(context as ShellContext<unknown>))
      return { tts: active.snapshot() }
    },
    afterWorkspaceRender(context) {
      ensure(context).setEditorHost(editorHost(context as ShellContext<unknown>))
    },
    destroy() {
      controller?.destroy()
      controller = null
    },
  }
}

function terminalFeature<TContract>(): ShellFeature<TContract> {
  let view: MnTerminalPane | null = null
  let loaded = false
  const ensure = (context: ShellContext<TContract>): OrganismTerminalController => {
    const controller = terminalControllerFor(context.rerender)
    if (!loaded) {
      loaded = true
      void controller.loadSettings()
    }
    return controller
  }
  return {
    id: 'terminal-controller',
    workspaceSnapshot(context) {
      const controller = ensure(context)
      return {
        terminal: {
          ...controller.snapshot(),
          fontFamily: readTerminalAppearance(browserStorage()).fontFamily,
          fontSize: readTerminalAppearance(browserStorage()).fontSize,
          onOpen: (size: { cols: number; rows: number }) => { void controller.open(size) },
          onInput: (data: string) => { void controller.write(data) },
          onResize: (size: { cols: number; rows: number }) => { void controller.resize(size) },
          onEnd: () => { void controller.end() },
        },
      }
    },
    afterWorkspaceRender(context) {
      ensure(context)
      const next = context.host.querySelector<MnTerminalPane>('mn-terminal-pane')
      if (next === view) return
      if (view) sharedTerminalController?.detach(view)
      view = next
      if (view) sharedTerminalController?.attach(view)
    },
    destroy() {
      if (view) sharedTerminalController?.detach(view)
      view = null
      sharedTerminalController?.destroy()
      sharedTerminalController = null
      terminalRerender = null
      loaded = false
    },
  }
}

function originalFileFeature<TContract>(): ShellFeature<TContract> {
  let controller: OrganismOriginalFileController | null = null
  let pdfController: OrganismPdfReaderController | null = null
  let latestContext: ShellContext<TContract> | null = null
  let listeningRoot: HTMLElement | null = null
  let assignedHost: (HTMLElement & { originalFileView?: unknown }) | null = null
  let renderQueued = false
  let latestSnapshot: Readonly<RenderWorkspaceOptions> | null = null
  let mutationScope = ''
  let makeEditableStatus: 'idle' | 'saving' | 'error' = 'idle'
  let makeEditableError = ''
  const madeEditable = new Set<string>()

  const requestRender = (): void => {
    if (renderQueued) return
    renderQueued = true
    queueMicrotask(() => {
      renderQueued = false
      latestContext?.rerender()
    })
  }
  const ensure = (): OrganismOriginalFileController => {
    controller ??= new OrganismOriginalFileController({
      requestRender,
      fetch: (input, init) => {
        const harnessFetch = (latestContext?.contract as { fetch?: typeof fetch } | null)?.fetch
        return harnessFetch ? harnessFetch(input, init) : globalThis.fetch(input, init)
      },
    })
    return controller
  }
  // The document-backed PDF reader (Phase 2): same lifetime as the original
  // surface, composed here so neither controller imports the other.
  const ensurePdf = (): OrganismPdfReaderController => {
    pdfController ??= new OrganismPdfReaderController({
      requestRender,
      fetch: (input, init) => {
        const harnessFetch = (latestContext?.contract as { fetch?: typeof fetch } | null)?.fetch
        return harnessFetch ? harnessFetch(input, init) : globalThis.fetch(input, init)
      },
    })
    return pdfController
  }
  const mergedOriginalView = (): unknown => {
    const base = ensure().snapshot()
    const pdf = pdfController?.hasScope() ? pdfController.snapshot() : null
    if (!pdf) return { ...base, pdf: null }
    // For PDF scopes the reader controller owns bytes/status/downloadability;
    // the original controller owns availability/activation. One controlled
    // view, no duplicate fetches.
    return {
      ...base,
      status: pdf.status,
      error: pdf.error || base.error,
      filename: pdf.filename || base.filename,
      mimeType: pdf.mimeType || base.mimeType,
      fileType: base.fileType || 'pdf',
      src: '',
      downloadable: pdf.downloadable,
      externalOpenable: pdf.externalOpenable,
      pdf,
    }
  }
  const fromAssignedHost = (event: Event): boolean => {
    const host = assignedHost
    if (!host || typeof event.composedPath !== 'function') return false
    return event.composedPath().includes(host)
  }
  const onToggle = (): void => { void controller?.toggle() }
  const onOriginalModeChange = (event: Event): void => {
    const mode = (event as CustomEvent<MnEditorOriginalModeDetail>).detail?.mode
    if (mode === 'document' || mode === 'original' || mode === 'annotations') {
      void controller?.setMode(mode)
    }
  }
  const onReload = (): void => {
    if (pdfController?.hasScope()) void pdfController.reload()
    else void controller?.reload()
  }
  const onDownload = (): void => {
    if (pdfController?.hasScope()) pdfController.download()
    else controller?.download()
  }
  const onOpenExternal = (): void => {
    if (pdfController?.hasScope()) pdfController.openExternal()
    else controller?.openExternal()
  }
  const onChapterSelect = (event: Event): void => {
    const chapterId = (event as CustomEvent<{ chapterId?: string }>).detail?.chapterId?.trim()
    if (chapterId) controller?.selectChapter(chapterId)
  }
  const onPdfPageVisible = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    const pageNumber = (event as CustomEvent<{ pageNumber?: number }>).detail?.pageNumber
    if (typeof pageNumber === 'number') pdfController?.handlePageVisible(pageNumber)
  }
  const onPdfPageChange = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    const pageNumber = (event as CustomEvent<{ pageNumber?: number }>).detail?.pageNumber
    if (typeof pageNumber === 'number') pdfController?.setPageNumber(pageNumber)
  }
  const onPdfZoomChange = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    const zoom = (event as CustomEvent<{ zoom?: number }>).detail?.zoom
    if (typeof zoom === 'number') pdfController?.setZoom(zoom)
  }
  const onPdfDownload = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    pdfController?.download()
  }
  const onPdfOpenExternal = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    pdfController?.openExternal()
  }
  const onPdfReload = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    void pdfController?.reload()
  }
  const onPdfHighlight = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    const detail = (event as CustomEvent<MnPdfAnnotateDetail>).detail
    if (detail) void pdfController?.highlight(detail)
  }
  const onPdfNote = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    const detail = (event as CustomEvent<MnPdfAnnotateDetail>).detail
    if (detail) void pdfController?.note(detail)
  }
  const onPdfAnnotationSelect = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    const detail = (event as CustomEvent<MnPdfAnnotationSelectDetail>).detail
    if (detail?.annotationId) pdfController?.selectAnnotation(detail.annotationId)
  }
  const onPdfAnnotationOpenOriginal = (event: Event): void => {
    if (!fromAssignedHost(event)) return
    const detail = (event as CustomEvent<MnPdfAnnotationSelectDetail>).detail
    if (!detail?.annotationId) return
    // From the annotation list: Original mode, jumped to the annotation's page.
    pdfController?.selectAnnotation(detail.annotationId)
    void controller?.setMode('original')
  }
  const currentDocumentNode = (): SidebarNode | null => {
    const documentId = latestContext?.documentId
    if (!documentId) return null
    for (const section of latestSnapshot?.sidebar?.sections ?? []) {
      const node = findNode(section.nodes ?? [], documentId)
      if (node?.kind === 'document') return node
    }
    return null
  }
  const onMakeEditable = (): void => {
    const context = latestContext
    const node = currentDocumentNode()
    if (!context?.documentId || !node?.readOnly || makeEditableStatus === 'saving') return
    const mcp = (context.contract as ImportedDocumentContract | null)?.mcp
    if (!mcp || typeof mcp.toolsCall !== 'function') {
      makeEditableStatus = 'error'
      makeEditableError = 'This backend does not expose the authoritative Make Editable operation.'
      requestRender()
      return
    }
    const graphId = context.graphId
    const documentId = context.documentId
    const scope = `${graphId}\u0000${documentId}`
    mutationScope = scope
    makeEditableStatus = 'saving'
    makeEditableError = ''
    requestRender()
    void makeSidebarDocumentEditable(mcp, { graphId, documentId }).then(() => {
      madeEditable.add(scope)
      if (mutationScope === scope) {
        makeEditableStatus = 'idle'
        makeEditableError = ''
      }
      requestRender()
    }).catch((error: unknown) => {
      if (mutationScope !== scope) return
      makeEditableStatus = 'error'
      makeEditableError = error instanceof Error ? error.message : String(error)
      requestRender()
    })
  }
  const PDF_EVENTS: ReadonlyArray<readonly [string, (event: Event) => void]> = [
    ['mn-pdf-page-visible', onPdfPageVisible],
    ['mn-pdf-page-change', onPdfPageChange],
    ['mn-pdf-zoom-change', onPdfZoomChange],
    ['mn-pdf-download', onPdfDownload],
    ['mn-pdf-open-external', onPdfOpenExternal],
    ['mn-pdf-reload', onPdfReload],
    ['mn-pdf-highlight', onPdfHighlight],
    ['mn-pdf-note', onPdfNote],
    ['mn-pdf-annotation-select', onPdfAnnotationSelect],
    ['mn-pdf-annotation-open-original', onPdfAnnotationOpenOriginal],
  ]
  const listen = (root: HTMLElement): void => {
    if (listeningRoot === root) return
    if (listeningRoot) {
      listeningRoot.removeEventListener('mn-editor-original-view-toggle', onToggle)
      listeningRoot.removeEventListener('mn-editor-original-mode-change', onOriginalModeChange)
      listeningRoot.removeEventListener('mn-original-viewer-reload', onReload)
      listeningRoot.removeEventListener('mn-original-viewer-download', onDownload)
      listeningRoot.removeEventListener('mn-original-viewer-open-external', onOpenExternal)
      listeningRoot.removeEventListener('mn-original-viewer-chapter-select', onChapterSelect)
      listeningRoot.removeEventListener('mn-editor-make-editable', onMakeEditable)
      for (const [type, handler] of PDF_EVENTS) listeningRoot.removeEventListener(type, handler)
    }
    listeningRoot = root
    root.addEventListener('mn-editor-original-view-toggle', onToggle)
    root.addEventListener('mn-editor-original-mode-change', onOriginalModeChange)
    root.addEventListener('mn-original-viewer-reload', onReload)
    root.addEventListener('mn-original-viewer-download', onDownload)
    root.addEventListener('mn-original-viewer-open-external', onOpenExternal)
    root.addEventListener('mn-original-viewer-chapter-select', onChapterSelect)
    root.addEventListener('mn-editor-make-editable', onMakeEditable)
    for (const [type, handler] of PDF_EVENTS) root.addEventListener(type, handler)
  }

  return {
    id: 'original-file-controller',
    bindProvider(_provider, context) {
      latestContext = context
      const contract = originalFileContract(context.contract)
      ensure().setScope(contract, context.graphId, context.documentId)
      return () => {
        controller?.releaseScope(context.graphId, context.documentId)
        pdfController?.setScope(null, null)
      }
    },
    workspaceSnapshot(context, snapshot) {
      latestContext = context
      latestSnapshot = snapshot
      const node = currentDocumentNode()
      const scope = context.documentId ? `${context.graphId}\u0000${context.documentId}` : ''
      if (scope !== mutationScope) {
        mutationScope = scope
        makeEditableStatus = 'idle'
        makeEditableError = ''
      }
      if (node && !node.readOnly) madeEditable.delete(scope)
      const contract = originalFileContract(context.contract)
      ensure().setScope(
        contract,
        context.graphId,
        context.documentId,
        node?.sourceFile ?? null,
      )
      // Document-backed PDF scope (Phase 2): the reader controller loads
      // bytes/pages for PDF sources only; anything else clears it.
      const sourceFile = node?.sourceFile ?? null
      const documentId = context.documentId
      const pdfScope = contract && documentId && isPdfSourceFile(sourceFile)
        ? { kind: 'document' as const, graphId: context.graphId, documentId, sourceFile: sourceFile! }
        : null
      ensurePdf().setScope(pdfScope ? contract : null, pdfScope)
      return {
        editorDocumentAccess: context.documentId
          ? {
              readOnly: Boolean(node?.readOnly) && !madeEditable.has(scope),
              makeEditableStatus,
              makeEditableError,
            }
          : null,
      }
    },
    afterWorkspaceRender(context) {
      latestContext = context
      listen(context.host)
      const host = context.host.querySelector('#mn-editor-host') as
        | (HTMLElement & { originalFileView?: unknown })
        | null
      if (assignedHost && assignedHost !== host) assignedHost.originalFileView = null
      assignedHost = host
      if (host) host.originalFileView = mergedOriginalView()
    },
    destroy() {
      if (listeningRoot) {
        listeningRoot.removeEventListener('mn-editor-original-view-toggle', onToggle)
        listeningRoot.removeEventListener('mn-editor-original-mode-change', onOriginalModeChange)
        listeningRoot.removeEventListener('mn-original-viewer-reload', onReload)
        listeningRoot.removeEventListener('mn-original-viewer-download', onDownload)
        listeningRoot.removeEventListener('mn-original-viewer-open-external', onOpenExternal)
        listeningRoot.removeEventListener('mn-original-viewer-chapter-select', onChapterSelect)
        listeningRoot.removeEventListener('mn-editor-make-editable', onMakeEditable)
        for (const [type, handler] of PDF_EVENTS) listeningRoot.removeEventListener(type, handler)
      }
      if (assignedHost) assignedHost.originalFileView = null
      controller?.destroy()
      controller = null
      pdfController?.destroy()
      pdfController = null
      assignedHost = null
      listeningRoot = null
      latestContext = null
      latestSnapshot = null
      mutationScope = ''
      makeEditableStatus = 'idle'
      makeEditableError = ''
      madeEditable.clear()
    },
  }
}

export function createOrganismShellFeatureHost<TContract = unknown>(): ShellFeatureHost<TContract> {
  const features: readonly ShellFeature<TContract>[] = [
    settingsFeature<TContract>(),
    createAgentStudioWorkspaceFeature<TContract>(),
    ttsFeature<TContract>(),
    terminalFeature<TContract>(),
    originalFileFeature<TContract>(),
    chromeFeature<TContract>(),
    hostedAccessFeature<TContract>(),
  ]
  return createShellFeatureHost(features)
}
