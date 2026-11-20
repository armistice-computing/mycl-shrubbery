import type {
  MnSettingsActionDetail,
  MnSettingsJobActionDetail,
  MnSettingsSection,
  MnSettingsSecretActionDetail,
  MnSettingsSelectChangeDetail,
  MnSettingsToggleChangeDetail,
} from '@shrubbery/components'
import {
  isVisualIdentitySkin,
  SKIN_LABELS,
  type EditorMaterial,
  type Theme,
  type VisualIdentitySkin,
} from '@shrubbery/tokens'
import { GARDEN_SITE_BUNDLE } from '@shrubbery/site/garden'
import { SYNC_FEATURES_ENABLED } from '@shrubbery/nucleus'
import type { GardendSettingsOperations } from './settings-operations.js'
import type { GardendLocalAiSettings } from './local-ai-settings.js'
import type { DreamingApi } from './dreaming-api.js'
import type { DreamingTargets } from './dreaming-settings-editor.js'
import type { FilesSettingsApi } from './files-settings-api.js'
import type { AgentsSettingsApi } from './agents-settings-api.js'
import {
  AI_PROVIDERS,
  TauriProviderSecretStore,
  isAiProvider,
  type ProviderSecretStore,
  type TauriInvoke,
} from './provider-secret-store.js'

export interface OrganismSettingsSnapshot {
  readonly userName: string
  readonly userEmail: string
  readonly sections: readonly MnSettingsSection[]
}

/** What the Dreaming page needs: the Tauri commands and the graph it is for. */
export interface DreamingSettingsContext {
  readonly api: DreamingApi
  readonly graphId: string
  readonly graphTitle?: string
  readonly listTargets?: () => Promise<DreamingTargets>
}

/** What the Files page needs: the graph's file list and its allowed folders. */
export interface FilesSettingsContext {
  readonly api: FilesSettingsApi
  readonly graphId: string
}

/** What the Help page needs: whether the desktop app's node can seed and wipe. */
export interface HelpSettingsContext {
  readonly nativeAvailable: boolean
}

/** What the Connected Agents page needs: the owner's credential routes. */
export interface AgentsSettingsContext {
  readonly api: AgentsSettingsApi
}

export interface GraphicsSettingsSnapshot {
  readonly supported: boolean
  readonly disableCompositing: boolean
}

export interface GraphicsSettingsContext {
  loadSettings(): Promise<GraphicsSettingsSnapshot>
  setDisableCompositing(disabled: boolean): Promise<void>
}

export interface TerminalSettingsContext {
  loadSettings(): Promise<boolean>
  setEnabled(enabled: boolean): Promise<void>
  snapshot(): { readonly available: boolean; readonly enabled: boolean }
}

export interface OrganismSettingsService {
  /** The Dreaming page's commands; only in the desktop app, which has Tauri IPC. */
  readonly dreaming?: DreamingSettingsContext
  /** The Files page; only where the shell can read the graph. */
  readonly files?: FilesSettingsContext
  /** The Connected Agents page; only on a local cell. */
  readonly agents?: AgentsSettingsContext
  /** The Help page; always shown, its graph actions only with the native node. */
  readonly help?: HelpSettingsContext
  load(): Promise<OrganismSettingsSnapshot>
  toggle(detail: MnSettingsToggleChangeDetail): Promise<void>
  select(detail: MnSettingsSelectChangeDetail): Promise<void>
  secret(detail: MnSettingsSecretActionDetail): Promise<void>
  action(detail: MnSettingsActionDetail): Promise<void>
  job(detail: MnSettingsJobActionDetail): Promise<void>
  /** Optional live-operation invalidation (job progress, errors, history refresh). */
  subscribe?(callback: () => void): () => void
}

export interface DefaultSettingsServiceOptions {
  readonly runtimeMode: 'local' | 'hosted'
  readonly userName?: string
  readonly userEmail?: string
  readonly apiBaseUrl?: string
  readonly mcpUrl?: string
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Backward-compatible desktop bridge; projected into a write-only secret store. */
  readonly invoke?: TauriInvoke
  /** Write-only provider credential backend (native Garden or hosted Choreograph). */
  readonly providerSecrets?: ProviderSecretStore
  readonly promptSecret?: (label: string) => string | null | Promise<string | null>
  readonly onAction?: (detail: MnSettingsActionDetail) => void | Promise<void>
  readonly isActionAvailable?: (actionId: string) => boolean
  readonly onPreferenceChange?: (
    detail: MnSettingsToggleChangeDetail | MnSettingsSelectChangeDetail,
  ) => void | Promise<void>
  /** The graph Settings was opened over; Graph Ops names it. */
  readonly graph?: { readonly id: string; readonly title?: string | null } | null
  /** Authenticated gardend effects; omitted for static/component-only stories. */
  readonly operations?: GardendSettingsOperations
  /** Authenticated gardend semantic-model/index/ingestion settings. */
  readonly localAi?: GardendLocalAiSettings
  /** Dreaming setup (Tauri IPC); omitted outside the desktop app. */
  readonly dreaming?: DreamingSettingsContext
  /** The graph's files and allowed folders; omitted when no graph is open. */
  readonly files?: FilesSettingsContext
  /** The owner's agent credentials; omitted outside a local cell. */
  readonly agents?: AgentsSettingsContext
  /** The Help page; omitted, it still shows, without its graph actions. */
  readonly help?: HelpSettingsContext
  readonly terminal?: TerminalSettingsContext
  readonly graphics?: GraphicsSettingsContext
}

interface PreferenceState {
  [key: string]: string | boolean | undefined
}

const STORAGE_KEY = 'shrubbery.organism.settings.v1'
type Provider = (typeof AI_PROVIDERS)[number]
export type OrganismThemePreference = Theme | 'system'

export interface OrganismAppearancePreferences {
  readonly skin: VisualIdentitySkin
  readonly theme: OrganismThemePreference
}

const DEFAULTS: PreferenceState = {
  theme: 'system',
  skin: GARDEN_SITE_BUNDLE.appearance.defaultSkin,
  density: 'comfortable',
  reducedMotion: false,
  editorMaterial: GARDEN_SITE_BUNDLE.appearance.defaultEditorMaterial,
  editorFont: 'default',
  lineWidth: 'default',
  blockSpacing: 'default',
  textSize: '100',
  valueMarkers: 'hover',
  terminalFont: 'default',
  terminalSize: '13',
  panelLabels: true,
  // Closed by default (Eschaton, 2026-10-09); the setting turns it back on.
  rightPanelOnLaunch: false,
  homeList: 'created',
  homeListSecond: 'opened',
  // Off by default since 11/20 (Eschaton: it lets What has become important
  // take the Song's place, and Connecting Your Tools suggests turning it on).
  // A new key: every saved profile already holds showSong: true from the old
  // default, which cannot be told from a choice. The only choice anyone could
  // make was off, and off stays off.
  homeSong: false,
  restoreLastDocument: true,
  autoSync: true,
  imageModel: 'google/gemini-2.5-flash-image',
  semanticModel: 'nomic-ai/nomic-embed-text-v2-moe',
  pdfEngine: 'auto',
  experimentalFeatures: false,
  diagnostics: false,
  analytics: false,
}

function visualIdentitySkinFrom(preferences: PreferenceState): VisualIdentitySkin {
  const value = preferences.skin
  return isVisualIdentitySkin(value) ? value : 'garden'
}

function themePreferenceFrom(preferences: PreferenceState): OrganismThemePreference {
  const value = preferences.theme
  return value === 'light' || value === 'dark' ? value : 'system'
}

function readPreferences(storage: DefaultSettingsServiceOptions['storage']): PreferenceState {
  if (!storage) return { ...DEFAULTS }
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULTS }
    const stored = parsed as PreferenceState
    const migratedMaterial = stored.editorMaterial == null && stored.paperPage === true
      ? { editorMaterial: 'paper' }
      : {}
    const merged: PreferenceState = { ...DEFAULTS, ...stored, ...migratedMaterial }
    const normalized: PreferenceState = {
      ...merged,
      skin: visualIdentitySkinFrom(merged),
      theme: themePreferenceFrom(merged),
    }
    // Pre-release values have no compatibility contract: replace anything
    // outside the current catalog immediately so retired identities do not
    // linger invisibly in the settings record.
    if (normalized.skin !== merged.skin || normalized.theme !== merged.theme) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(normalized))
      } catch {
        // A read-only browser store still receives the normalized in-memory view.
      }
    }
    return normalized
  } catch {
    return { ...DEFAULTS }
  }
}

/** Read the shared chrome/settings appearance state without mounting Settings. */
export function readReducedMotionPreference(
  storage: DefaultSettingsServiceOptions['storage'],
): boolean {
  return readPreferences(storage).reducedMotion === true
}

export function readAppearancePreferences(
  storage: DefaultSettingsServiceOptions['storage'],
): OrganismAppearancePreferences {
  const preferences = readPreferences(storage)
  return {
    skin: visualIdentitySkinFrom(preferences),
    theme: themePreferenceFrom(preferences),
  }
}

/** Merge appearance state into the Settings record without clobbering other rows. */
export function persistAppearancePreferences(
  storage: DefaultSettingsServiceOptions['storage'],
  patch: Partial<OrganismAppearancePreferences>,
): void {
  if (!storage) return
  try {
    const preferences = readPreferences(storage)
    if (patch.skin !== undefined) preferences.skin = patch.skin
    if (patch.theme !== undefined) preferences.theme = patch.theme
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Storage denial must not make a chrome action fail.
  }
}

/** Resolve the persisted System/Light/Dark preference into the rendered axis. */
export function resolveThemePreference(
  preference: OrganismThemePreference,
  prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true,
): Theme {
  return preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference
}

function editorMaterialFrom(preferences: PreferenceState): EditorMaterial {
  const value = preferences.editorMaterial
  // The Classic Word page was retired 2026-10-14; anyone on it keeps a page.
  return value === 'paper' || value === 'classic-word' ? 'paper' : 'continuous'
}

/**
 * Editor typography (Appearance > Editor font, Line width, Text size). Each
 * choice becomes a custom property on the root that only the editor reads, so
 * the app's own chrome keeps the skin's faces and sizes. `default` sets
 * nothing: the skin and the editor material decide.
 */
export const EDITOR_FONTS = {
  default: { label: 'Default', stack: null, weight: null },
  // Body text a touch heavier than 400 (Eschaton, 2026-10-14).
  piazzolla: { label: 'Piazzolla', stack: "'Piazzolla Variable', 'Piazzolla', Georgia, serif", weight: '450' },
  literata: { label: 'Literata', stack: "'Literata Variable', 'Literata', Georgia, serif", weight: '400' },
  'source-sans': { label: 'Source Sans', stack: "'Source Sans 3 Variable', 'Source Sans 3', -apple-system, sans-serif", weight: '400' },
} as const satisfies Record<string, { label: string, stack: string | null, weight: string | null }>

/** The measure of the text itself, before the sheet's own padding. */
export const LINE_WIDTHS = {
  default: { label: 'Default', width: null },
  narrow: { label: 'Narrow', width: '560px' },
  medium: { label: 'Medium', width: '680px' },
  wide: { label: 'Wide', width: '840px' },
  // Larger than any window: the sheet's min(100%, ...) caps it to the pane.
  full: { label: 'Full width', width: '10000px' },
} as const satisfies Record<string, { label: string, width: string | null }>

export const BLOCK_SPACINGS = {
  default: { label: 'Default', gap: null },
  compact: { label: 'Compact', gap: '0' },
  comfortable: { label: 'Comfortable', gap: 'var(--mn-space-2, 0.5rem)' },
  spacious: { label: 'Spacious', gap: 'var(--mn-space-4, 1rem)' },
} as const satisfies Record<string, { label: string, gap: string | null }>

export const TEXT_SIZES = ['90', '100', '110', '125', '140'] as const

/**
 * The value gutter at rest (graph doc "Value Gutter — revision (2026-10-16)"):
 * the signal bars on hover (default), on every block, or not at all. The
 * reader's own flags and valence show in hover and always modes.
 */
export const VALUE_MARKERS = {
  hover: 'On hover',
  always: 'Always',
  hidden: 'Hidden',
} as const

export type ValueMarkersPreference = keyof typeof VALUE_MARKERS

export type EditorFontPreference = keyof typeof EDITOR_FONTS
export type LineWidthPreference = keyof typeof LINE_WIDTHS
export type BlockSpacingPreference = keyof typeof BLOCK_SPACINGS
export type TextSizePreference = (typeof TEXT_SIZES)[number]

export interface EditorTypePreferences {
  readonly editorFont: EditorFontPreference
  readonly lineWidth: LineWidthPreference
  readonly blockSpacing: BlockSpacingPreference
  readonly textSize: TextSizePreference
  readonly valueMarkers: ValueMarkersPreference
}

function isKeyOf<T extends object>(table: T, value: unknown): value is keyof T {
  return typeof value === 'string' && Object.hasOwn(table, value)
}

/** Faces for the terminal. An empty family means the app's own monospace. */
export const TERMINAL_FONTS = {
  default: { label: 'JetBrains Mono', family: '' },
  system: { label: 'System monospace', family: "ui-monospace, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace" },
  menlo: { label: 'Menlo', family: 'Menlo, monospace' },
  monaco: { label: 'Monaco', family: 'Monaco, monospace' },
  courier: { label: 'Courier New', family: "'Courier New', Courier, monospace" },
} as const
export const TERMINAL_SIZES = ['9', '10', '11', '12', '13', '14', '15', '16', '18', '20'] as const

export interface TerminalAppearance {
  readonly terminalFont: keyof typeof TERMINAL_FONTS
  readonly terminalSize: (typeof TERMINAL_SIZES)[number]
  readonly fontFamily: string
  readonly fontSize: number
}

function terminalAppearanceFrom(preferences: PreferenceState): TerminalAppearance {
  const terminalFont = isKeyOf(TERMINAL_FONTS, preferences.terminalFont) ? preferences.terminalFont : 'default'
  const size = preferences.terminalSize
  const terminalSize = (TERMINAL_SIZES as readonly unknown[]).includes(size)
    ? size as (typeof TERMINAL_SIZES)[number]
    : '13'
  return { terminalFont, terminalSize, fontFamily: TERMINAL_FONTS[terminalFont].family, fontSize: Number(terminalSize) }
}

export function readTerminalAppearance(storage: DefaultSettingsServiceOptions['storage']): TerminalAppearance {
  return terminalAppearanceFrom(readPreferences(storage))
}

function editorTypeFrom(preferences: PreferenceState): EditorTypePreferences {
  const size = preferences.textSize
  return {
    editorFont: isKeyOf(EDITOR_FONTS, preferences.editorFont) ? preferences.editorFont : 'default',
    lineWidth: isKeyOf(LINE_WIDTHS, preferences.lineWidth) ? preferences.lineWidth : 'default',
    blockSpacing: isKeyOf(BLOCK_SPACINGS, preferences.blockSpacing) ? preferences.blockSpacing : 'default',
    textSize: (TEXT_SIZES as readonly unknown[]).includes(size) ? size as TextSizePreference : '100',
    valueMarkers: isKeyOf(VALUE_MARKERS, preferences.valueMarkers) ? preferences.valueMarkers : 'hover',
  }
}

export function readEditorTypePreferences(
  storage: DefaultSettingsServiceOptions['storage'],
): EditorTypePreferences {
  return editorTypeFrom(readPreferences(storage))
}

/** Write the editor typography onto the root (or remove what is at default). */
export function applyEditorTypePreferences(
  preferences: EditorTypePreferences,
  root: {
    style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>
    setAttribute?: (name: string, value: string) => void
    removeAttribute?: (name: string) => void
  },
): void {
  const set = (name: string, value: string | null) => {
    if (value === null) root.style.removeProperty(name)
    else root.style.setProperty(name, value)
  }
  set('--mn-editor-font', EDITOR_FONTS[preferences.editorFont].stack)
  set('--mn-editor-font-weight', EDITOR_FONTS[preferences.editorFont].weight)
  set('--mn-editor-line-width', LINE_WIDTHS[preferences.lineWidth].width)
  set('--mn-editor-block-gap', BLOCK_SPACINGS[preferences.blockSpacing].gap)
  set('--mn-editor-text-scale', preferences.textSize === '100' ? null : String(Number(preferences.textSize) / 100))
  // The editor host mirrors this attribute (editor-host.ts _syncEditorMaterial).
  if (preferences.valueMarkers === 'hover') root.removeAttribute?.('data-value-markers')
  else root.setAttribute?.('data-value-markers', preferences.valueMarkers)
}

/** Read the one preference the live editor needs before the settings route is
 * mounted. The rest of the settings state remains private to this service. */
export function readEditorMaterialPreference(
  storage: DefaultSettingsServiceOptions['storage'],
): EditorMaterial {
  return editorMaterialFrom(readPreferences(storage))
}

/**
 * Whether the right rail opens when the workspace boots.
 *
 * DELIBERATELY A LAUNCH PREFERENCE, not a live mirror of the rail's state. The
 * rail is already opened and closed constantly during a session -- by the
 * toolbar, by Mod+Shift+I, by opening an inspector on a document -- and its
 * session state already persists on its own key
 * (`shrubbery.organism.panel-layout.v1`). A settings toggle that tried to
 * reflect that would be a second source of truth for one fact, and the two
 * would disagree the first time the rail was closed by any of the other three
 * routes. So the toggle answers one question the session state cannot: what
 * should be true when the window opens.
 */
/**
 * What Home's two recents lists show (Eschaton, 2026-11-17 and 11-18): each
 * can be the newest documents, the latest writes (yours or an agent's), or
 * the ones you opened. `homeList` is the first list (it was the only choice
 * on 11-17, so its stored value carries over) and `homeListSecond` the
 * second. Each list keeps its own place and length on Home.
 */
export type HomeListPreference = 'created' | 'updated' | 'opened'

export interface HomeListsPreference {
  readonly first: HomeListPreference
  readonly second: HomeListPreference
}

function homeListFrom(value: unknown, fallback: HomeListPreference): HomeListPreference {
  return value === 'created' || value === 'updated' || value === 'opened' ? value : fallback
}

const HOME_LIST_OPTIONS: ReadonlyArray<{ readonly value: HomeListPreference; readonly label: string }> = [
  { value: 'created', label: 'Recently created' },
  { value: 'updated', label: 'Recently edited' },
  { value: 'opened', label: 'Recently opened' },
]

export function readHomeListPreference(
  storage: DefaultSettingsServiceOptions['storage'],
): HomeListPreference {
  return homeListFrom(readPreferences(storage).homeList, 'created')
}

export function readHomeListsPreference(
  storage: DefaultSettingsServiceOptions['storage'],
): HomeListsPreference {
  const preferences = readPreferences(storage)
  return {
    first: homeListFrom(preferences.homeList, 'created'),
    second: homeListFrom(preferences.homeListSecond, 'opened'),
  }
}

/** Home shows the Song's newest verse only when this is turned on (default off). */
export function readShowSongPreference(
  storage: DefaultSettingsServiceOptions['storage'],
): boolean {
  return readPreferences(storage).homeSong === true
}

/** New Document asks for a name first unless this is turned off (default on). */
export function readAskDocumentNamePreference(
  storage: DefaultSettingsServiceOptions['storage'],
): boolean {
  return readPreferences(storage).askDocumentName !== false
}

/** Generated pages get their own section in Files unless this is off (default on). */
export function readSeparateGeneratedPreference(
  storage: DefaultSettingsServiceOptions['storage'],
): boolean {
  return readPreferences(storage).separateGenerated !== false
}

export function readRightPanelOnLaunchPreference(
  storage: DefaultSettingsServiceOptions['storage'],
): boolean {
  return readPreferences(storage).rightPanelOnLaunch === true
}

function section(
  id: string,
  title: string,
  description: string,
  rows: Omit<MnSettingsSection, 'id' | 'title' | 'description'>,
): MnSettingsSection {
  return { id, title, description, ...rows }
}

export class DefaultOrganismSettingsService implements OrganismSettingsService {
  readonly dreaming: DreamingSettingsContext | undefined
  readonly files: FilesSettingsContext | undefined
  readonly agents: AgentsSettingsContext | undefined
  readonly help: HelpSettingsContext
  private preferences: PreferenceState
  private graphics: GraphicsSettingsSnapshot = { supported: false, disableCompositing: false }
  private readonly providerSecrets: ProviderSecretStore | null
  private providerSecretsAvailable = false
  private providerStatus: Record<Provider, boolean> = {
    openrouter: false,
    anthropic: false,
    openai: false,
  }

  constructor(private readonly options: DefaultSettingsServiceOptions) {
    this.dreaming = options.dreaming
    this.files = options.files
    this.agents = options.agents
    this.help = options.help ?? { nativeAvailable: false }
    this.preferences = readPreferences(options.storage)
    this.providerSecrets = options.providerSecrets
      ?? (options.invoke ? new TauriProviderSecretStore(options.invoke) : null)
  }

  private async refreshProviderStatus(): Promise<void> {
    if (!this.providerSecrets) {
      this.providerSecretsAvailable = false
      return
    }
    try {
      const status = await this.providerSecrets.status()
      for (const provider of AI_PROVIDERS) this.providerStatus[provider] = status[provider] === true
      this.providerSecretsAvailable = true
    } catch {
      this.providerSecretsAvailable = false
      // Browser and hosted deployments have no native secret store. The section
      // remains truthful: every provider is shown as missing and disabled.
    }
  }

  private persist(): void {
    try {
      this.options.storage?.setItem(STORAGE_KEY, JSON.stringify(this.preferences))
    } catch {
      // Private browsing/storage denial must not make a setting interaction crash.
    }
  }

  private actionUnavailable(actionId: string): boolean {
    if (this.options.operations?.supports(actionId)) return false
    return !this.options.onAction || this.options.isActionAvailable?.(actionId) === false
  }

  async load(): Promise<OrganismSettingsSnapshot> {
    await Promise.all([
      this.refreshProviderStatus(),
      this.options.operations?.ensureHistoryLoaded(),
      this.options.localAi?.ensureLoaded(),
      this.options.terminal?.loadSettings(),
      this.options.graphics?.loadSettings().then(settings => { this.graphics = settings }),
    ])
    const hasProviderSecrets = Boolean(this.providerSecrets && this.providerSecretsAvailable)
    const local = this.options.runtimeMode === 'local'
    const apiBaseUrl = this.options.apiBaseUrl?.trim() || (local ? 'Local loopback' : 'Hosted gateway')
    const mcpUrl = this.options.mcpUrl?.trim() || (local ? '/mcp' : '/g/{graph_id}/mcp')
    const p = this.preferences

    const sections: MnSettingsSection[] = [
      section('account', 'Account', 'Profile, authentication, and account state.', {
        metrics: [
          { id: 'identity', label: 'Identity', value: this.options.userEmail || this.options.userName || 'Local user' },
          { id: 'runtime', label: 'Runtime', value: this.options.runtimeMode, tone: local ? 'neutral' : 'accent' },
        ],
        actions: local || this.actionUnavailable('sign-out')
          ? []
          : [{ id: 'sign-out', label: 'Sign out', description: 'End the current hosted session.', variant: 'danger' }],
      }),
      section('appearance', 'Appearance', 'Skin, theme, how documents read, and motion.', {
        selects: [
          { id: 'theme', label: 'Theme', value: themePreferenceFrom(p), options: [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] },
          // One skin today: a one-option picker would be dead UI, so it shows only
          // when there is a real choice.
          ...(GARDEN_SITE_BUNDLE.appearance.skins.length > 1 ? [{
            id: 'skin',
            label: 'Skin',
            value: visualIdentitySkinFrom(p),
            options: GARDEN_SITE_BUNDLE.appearance.skins.map((value) => ({ value, label: SKIN_LABELS[value] })),
          }] : []),
          {
            id: 'editorMaterial',
            label: 'Editor canvas',
            description: 'A continuous canvas, or a quiet physical page.',
            value: editorMaterialFrom(p),
            options: GARDEN_SITE_BUNDLE.appearance.editorMaterials.map((value) => ({
              value,
              label: value === 'continuous' ? 'Continuous canvas' : 'Quiet paper page',
            })),
          },
          {
            id: 'editorFont',
            label: 'Editor font',
            description: 'The face for documents. The rest of the app keeps its own.',
            value: editorTypeFrom(p).editorFont,
            options: Object.entries(EDITOR_FONTS).map(([value, font]) => ({ value, label: font.label })),
          },
          {
            id: 'lineWidth',
            label: 'Line width',
            description: 'How long a line of text runs before it wraps.',
            value: editorTypeFrom(p).lineWidth,
            options: Object.entries(LINE_WIDTHS).map(([value, width]) => ({ value, label: width.label })),
          },
          {
            id: 'blockSpacing',
            label: 'Block spacing',
            description: 'The space between blocks in documents.',
            value: editorTypeFrom(p).blockSpacing,
            options: Object.entries(BLOCK_SPACINGS).map(([value, spacing]) => ({ value, label: spacing.label })),
          },
          {
            id: 'valueMarkers',
            label: 'Value markers',
            description: 'The signal bars beside each block. Your own flags and valence show unless hidden.',
            value: editorTypeFrom(p).valueMarkers,
            options: Object.entries(VALUE_MARKERS).map(([value, label]) => ({ value, label })),
          },
          {
            id: 'textSize',
            label: 'Text size',
            description: 'The size of text in documents.',
            value: editorTypeFrom(p).textSize,
            options: TEXT_SIZES.map((value) => ({ value, label: `${value}%` })),
          },
          // The terminal's own look, once the terminal is on (Interface).
          ...(this.options.terminal?.snapshot().enabled ? [
            {
              id: 'terminalFont',
              label: 'Terminal font',
              description: 'The face for the terminal in the right panel. A font this computer does not have falls back to its own monospace.',
              value: terminalAppearanceFrom(p).terminalFont,
              options: Object.entries(TERMINAL_FONTS).map(([value, font]) => ({ value, label: font.label })),
            },
            {
              id: 'terminalSize',
              label: 'Terminal text size',
              description: 'The size of text in the terminal.',
              value: terminalAppearanceFrom(p).terminalSize,
              options: TERMINAL_SIZES.map((value) => ({ value, label: `${value} px` })),
            },
          ] : []),
        ],
        toggles: [
          { id: 'reducedMotion', label: 'Reduce motion', checked: p.reducedMotion === true },
          ...(this.graphics.supported ? [{
            id: 'disableCompositing',
            label: 'Disable accelerated compositing',
            description: 'Can substantially reduce memory use with software graphics. Applies after restarting Mycl.',
            checked: this.graphics.disableCompositing,
          }] : []),
        ],
      }),
      section('interface', 'Interface', 'How the window is laid out.', {
        selects: [
          {
            id: 'homeList',
            label: "Home's first list",
            description: 'Under Pinned. Recently edited counts writes by you and by your agents.',
            value: homeListFrom(p.homeList, 'created'),
            options: HOME_LIST_OPTIONS.map(option => ({ ...option })),
          },
          {
            id: 'homeListSecond',
            label: "Home's second list",
            description: 'Under the first list, a little shorter.',
            value: homeListFrom(p.homeListSecond, 'opened'),
            options: HOME_LIST_OPTIONS.map(option => ({ ...option })),
          },
        ],
        toggles: [
          {
            id: 'askDocumentName',
            label: 'Ask for a name before a new document',
            description: 'Off, a new document opens at once, named for when you made it (like 11.18.26.9.55). You can rename it any time.',
            checked: p.askDocumentName !== false,
          },
          {
            id: 'separateGenerated',
            label: 'Keep generated pages in their own section',
            description: 'In Files, the pages Mycl writes itself (What Has Become Important, Diaries, the Song) sit under Made by Mycl. Off, they are listed with your documents.',
            checked: p.separateGenerated !== false,
          },
          {
            id: 'homeSong',
            label: 'Show the Song on Home',
            description: "The newest verse of the graph's Song, written by your agents. Off, What has become important takes its place.",
            checked: p.homeSong === true,
          },
          {
            id: 'rightPanelOnLaunch',
            label: 'Open the right panel on launch',
            description: 'The right rail can still be opened and closed at any time; this is only what it does when the window opens.',
            checked: p.rightPanelOnLaunch === true,
          },
          {
            id: 'terminalEnabled',
            label: 'Terminal',
            description: this.options.terminal?.snapshot().available
              ? 'A terminal in the right panel, running your own shell. Nothing starts until you choose Open. Once it is on, its font and text size are under Appearance.'
              : 'The terminal is available in the Mycl desktop app.',
            checked: this.options.terminal?.snapshot().enabled ?? false,
            disabled: !this.options.terminal?.snapshot().available,
          },
        ],
      }),
      section('billing', 'Billing', 'Plan and subscription controls.', {
        metrics: [{ id: 'plan', label: 'Plan', value: local ? 'Local' : 'Hosted' }],
        actions: [{ id: 'manage-billing', label: 'Manage billing', disabled: local || this.actionUnavailable('manage-billing') }],
      }),
      section('usage', 'Usage', 'Runtime and storage usage summaries.', {
        metrics: [
          { id: 'runtime', label: 'Execution', value: local ? 'On device' : 'Cloud' },
          { id: 'storage', label: 'Graph storage', value: local ? 'Local profile' : 'Durable cloud cell' },
        ],
        actions: [{ id: 'refresh-usage', label: 'Refresh usage', disabled: this.actionUnavailable('refresh-usage') }],
      }),
      section('history', 'History', 'Snapshots, restore points, and document time travel.', {
        actions: this.actionUnavailable('open-history')
          ? []
          : [{ id: 'open-history', label: 'Open document history' }],
        notes: ['Document history is scoped to the active graph and document.'],
      }),
      section('graph-ops', 'Graph Ops', 'Export, import, duplicate, and maintain graphs.', {
        subject: graphSubject(this.options.graph),
        actions: [
          { id: 'duplicate-graph', label: 'Duplicate graph', disabled: this.actionUnavailable('duplicate-graph') },
          { id: 'export-graph', label: 'Export graph', disabled: this.actionUnavailable('export-graph') },
          { id: 'import-graph', label: 'Import graph', disabled: this.actionUnavailable('import-graph') },
        ],
        jobs: [],
      }),
      section('imports', 'Imports', 'Bring documents and knowledge archives into Mycl.', {
        actions: [
          { id: 'import-files', label: 'Import files', disabled: this.actionUnavailable('import-files') },
          { id: 'import-obsidian', label: 'Import Obsidian vault', disabled: this.actionUnavailable('import-obsidian') },
          { id: 'import-notion', label: 'Import Notion archive', disabled: this.actionUnavailable('import-notion') },
          { id: 'import-roam', label: 'Import Roam archive', disabled: this.actionUnavailable('import-roam') },
        ],
      }),
      ...(this.files ? [section(
        'files',
        'Files',
        'The files this graph keeps or links to, and the folders agents may link from.',
        { wide: true, contentSlot: 'files' },
      )] : []),
      ...(this.agents ? [section(
        'agents',
        'Connected Agents',
        'Let your own agents read and write in your graphs, and disconnect them.',
        { wide: true, contentSlot: 'agents' },
      )] : []),
      section(
        'help',
        'Help',
        'Ways to begin, the latest Getting Started pages, and starting over.',
        { wide: true, contentSlot: 'help' },
      ),
      section('api-keys', 'AI Provider Keys', 'Agent-inference provider credentials. Secret values are write-only and never reflected into component properties.', {
        secrets: hasProviderSecrets ? (this.providerSecrets?.providers ?? []).map(provider => ({
          id: provider,
          label: provider === 'openrouter' ? 'OpenRouter' : provider === 'openai' ? 'OpenAI' : 'Anthropic',
          provider,
          configured: this.providerStatus[provider],
          disabled: !hasProviderSecrets,
        })) : [],
        notes: hasProviderSecrets && this.providerSecrets
          ? [`Keys are stored in the ${this.providerSecrets.storageLabel}.`]
          : ['Provider-key management is unavailable in this runtime.'],
      }),
      section('api-mcp', 'API & MCP', 'Loopback or gateway endpoints used by external agents.', {
        metrics: [
          { id: 'api-base', label: 'API base', value: apiBaseUrl },
          { id: 'mcp-url', label: 'MCP endpoint', value: mcpUrl },
        ],
        actions: [
          ...(!this.actionUnavailable('copy-api-url') ? [{ id: 'copy-api-url', label: 'Copy API URL' }] : []),
          ...(!this.actionUnavailable('copy-mcp-url') ? [{ id: 'copy-mcp-url', label: 'Copy MCP URL' }] : []),
        ] satisfies MnSettingsSection['actions'],
      }),
      section('local-ai', 'Search & PDFs', 'Search by meaning, and how PDFs are read when you import them.', {}),
      ...(local && this.dreaming ? [section(
        'dreaming',
        'Dreaming',
        'Mycl can dream on a graph at night with an AI you choose. Off until you turn it on.',
        { wide: true, contentSlot: 'dreaming' },
      )] : []),
      section('experimental', 'Experimental', 'Opt into unfinished Mycl capabilities.', {
        toggles: [
          { id: 'experimentalFeatures', label: 'Experimental features', checked: p.experimentalFeatures === true },
          { id: 'diagnostics', label: 'Extended diagnostics', checked: p.diagnostics === true },
        ],
      }),
      section('privacy', 'Privacy', 'Telemetry and local-data controls.', {
        toggles: [{ id: 'analytics', label: 'Anonymous product analytics', checked: p.analytics === true }],
        actions: [{ id: 'clear-local-cache', label: 'Clear local cache', variant: 'danger', disabled: this.actionUnavailable('clear-local-cache') }],
        notes: [local ? 'Graph content remains in the local Mycl profile.' : 'Hosted graph content is stored in the graph’s durable cloud cell.'],
      }),
    ]
    const localAiSection = sections.find(section => section.id === 'local-ai')
    const projectedSections = localAiSection && this.options.localAi
      ? sections.map(section => section.id === 'local-ai' ? this.options.localAi!.decorateSection(section) : section)
      : sections
    const hasEndpoints = Boolean(this.options.apiBaseUrl?.trim() && this.options.mcpUrl?.trim())
    const visibleSections = projectedSections.filter(section => {
      // Offline there is no account to show; a hosted cell keeps its sign-in.
      if (section.id === 'account') return !local || SYNC_FEATURES_ENABLED
      if (section.id === 'billing' || section.id === 'usage') return false
      if (section.id === 'experimental' || section.id === 'privacy') return false
      if (section.id === 'api-keys') return !local && hasProviderSecrets
      if (section.id === 'local-ai') return local && Boolean(this.options.localAi)
      if (section.id === 'api-mcp') return hasEndpoints
      if (section.id === 'history' || section.id === 'graph-ops' || section.id === 'imports') {
        return Boolean(this.options.operations)
      }
      return true
    })
    return {
      userName: this.options.userName ?? '',
      userEmail: this.options.userEmail ?? '',
      sections: this.options.operations?.decorateSections(visibleSections) ?? visibleSections,
    }
  }

  async toggle(detail: MnSettingsToggleChangeDetail): Promise<void> {
    if (detail.settingId === 'disableCompositing') {
      if (!this.options.graphics) throw new Error('Graphics settings are unavailable in this runtime')
      await this.options.graphics.setDisableCompositing(detail.checked)
      this.graphics = { ...this.graphics, disableCompositing: detail.checked }
      return
    }
    if (detail.settingId === 'terminalEnabled') {
      if (!this.options.terminal) throw new Error('Terminal is unavailable in this runtime')
      await this.options.terminal.setEnabled(detail.checked)
      return
    }
    this.preferences[detail.settingId] = detail.checked
    this.persist()
    await this.options.onPreferenceChange?.(detail)
  }

  async select(detail: MnSettingsSelectChangeDetail): Promise<void> {
    if (this.options.localAi?.handlesSelect(detail.settingId)) {
      await this.options.localAi.select(detail.settingId, detail.value)
      return
    }
    const normalized = detail.settingId === 'editorMaterial'
      ? editorMaterialFrom({ editorMaterial: detail.value })
      : detail.settingId === 'editorFont' || detail.settingId === 'lineWidth' || detail.settingId === 'blockSpacing' || detail.settingId === 'textSize' || detail.settingId === 'valueMarkers'
        ? editorTypeFrom({ [detail.settingId]: detail.value })[detail.settingId]
      : detail.settingId === 'terminalFont' || detail.settingId === 'terminalSize'
        ? terminalAppearanceFrom({ [detail.settingId]: detail.value })[detail.settingId]
      : detail.settingId === 'skin'
        ? visualIdentitySkinFrom({ skin: detail.value })
        : detail.settingId === 'theme'
          ? themePreferenceFrom({ theme: detail.value })
          : detail.value
    this.preferences[detail.settingId] = normalized
    if (detail.settingId === 'editorMaterial') delete this.preferences.paperPage
    this.persist()
    await this.options.onPreferenceChange?.({ ...detail, value: normalized })
  }

  async secret(detail: MnSettingsSecretActionDetail): Promise<void> {
    const provider = isAiProvider(detail.secretId) ? detail.secretId : null
    if (provider && this.providerSecrets && !this.providerSecretsAvailable) {
      await this.refreshProviderStatus()
    }
    if (!provider || !this.providerSecrets || !this.providerSecretsAvailable) throw new Error('Provider key storage is unavailable.')
    if (detail.action === 'delete') {
      await this.providerSecrets.delete(provider)
      this.providerStatus[provider] = false
      return
    }
    const prompt = this.options.promptSecret ?? ((label: string) => globalThis.prompt?.(`Enter ${label} API key`) ?? null)
    const value = (await prompt(provider))?.trim()
    if (!value) return
    await this.providerSecrets.store(provider, value)
    this.providerStatus[provider] = true
  }

  async action(detail: MnSettingsActionDetail): Promise<void> {
    if (this.options.operations?.supports(detail.actionId)) {
      await this.options.operations.action(detail)
      return
    }
    if (!this.options.onAction) throw new Error(`Settings action is unavailable: ${detail.actionId}`)
    await this.options.onAction(detail)
  }

  async job(detail: MnSettingsJobActionDetail): Promise<void> {
    if (this.options.localAi?.handlesJob(detail.jobId)) {
      await this.options.localAi.job(detail.jobId)
      return
    }
    throw new Error(`Settings job is unavailable: ${detail.jobId}`)
  }

  subscribe(callback: () => void): () => void {
    const unsubscribeOperations = this.options.operations?.subscribe(callback) ?? (() => undefined)
    const unsubscribeLocalAi = this.options.localAi?.subscribe(callback) ?? (() => undefined)
    return () => {
      unsubscribeOperations()
      unsubscribeLocalAi()
    }
  }
}

/** Graph Ops' card: the graph's name, with its id beneath when they differ. */
export function graphSubject(
  graph: { readonly id: string; readonly title?: string | null } | null | undefined,
): { readonly title: string; readonly detail: string } | null {
  const id = graph?.id?.trim() ?? ''
  if (!id) return null
  const title = graph?.title?.trim() || id
  return {
    title,
    detail: title === id
      ? 'Duplicate, export and restore act on this graph.'
      : `Graph ID: ${id}. Duplicate, export and restore act on this graph.`,
  }
}

export function createDefaultSettingsService(
  options: DefaultSettingsServiceOptions,
): DefaultOrganismSettingsService {
  return new DefaultOrganismSettingsService(options)
}
