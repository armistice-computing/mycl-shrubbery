/**
 * native-menu.ts — the desktop app's menu bar, built from the CommandRegistry.
 *
 * The registry already feeds the command palette and the shortcuts dialog.
 * The native menu is a third surface over the same commands, so a menu item,
 * its shortcut and the keyboard can never disagree. The Cmd+A bug was two
 * owners of one key: the default Tauri menu's Select All and the editor.
 *
 * Here: a layout of command ids per menu, a builder that turns the layout and
 * the current context into a spec (labels, accelerators, enabled and checked
 * states), and an installer that sends the spec to the shell (garden
 * `set_app_menu`) and runs the command a menu click names (the shell's
 * `app-menu` event). The shell adds what macOS itself owns: About, Services,
 * Hide, Quit, the clipboard items, and the Window menu's items. Undo and Redo
 * are registry commands (edit.undo / edit.redo), like Select All.
 *
 * Desktop only. In a browser there is no native menu, and the top bar remains
 * the menu (her ruling, 2026-09-30).
 */
import type { Command, CommandContext, CommandRegistry } from '@shrubbery/nucleus'

/**
 * A slot in a menu: a command id, '-' for a separator, 'native:<item>', or a
 * nested submenu.
 */
export type NativeMenuSlot = string | { readonly submenu: string; readonly items: readonly string[] }

export interface NativeMenuLayout {
  /** Items for the app menu, after About (e.g. Settings). */
  readonly appItems: readonly NativeMenuSlot[]
  readonly menus: ReadonlyArray<{ readonly title: string; readonly items: readonly NativeMenuSlot[] }>
}

export type NativeMenuItemSpec =
  | {
      readonly kind: 'command'
      readonly id: string
      readonly label: string
      readonly accelerator?: string
      readonly enabled: boolean
      readonly checked?: boolean
    }
  | { readonly kind: 'separator' }
  | { readonly kind: 'native'; readonly item: string }
  | { readonly kind: 'submenu'; readonly label: string; readonly items: readonly NativeMenuItemSpec[] }

export interface NativeMenuSpec {
  readonly appItems: readonly NativeMenuItemSpec[]
  readonly menus: ReadonlyArray<{ readonly title: string; readonly items: readonly NativeMenuItemSpec[] }>
}

/**
 * Garden's menu bar. A slot ending in `.*` expands to every registered
 * command with that prefix that is available now, in registration order (the
 * right-panel toggles, the graphs). A command that is not registered is left
 * out; a named command that is unavailable shows disabled.
 */
export const GARDEN_NATIVE_MENU: NativeMenuLayout = {
  appItems: ['app.settings'],
  menus: [
    {
      title: 'File',
      items: [
        'document.new', 'file.new-folder', 'go.today',
        '-', 'file.import', 'document.export',
        '-', 'document.rename', 'document.move', 'document.history',
        '-', 'document.delete',
      ],
    },
    {
      title: 'Edit',
      items: [
        // Undo/Redo are registry commands, not the shell's native items: a
        // native Undo sends undo: to WKWebView, whose own undo stack fights
        // ProseMirror's (the Cmd+A lesson, again).
        'edit.undo', 'edit.redo',
        '-', 'native:cut', 'native:copy', 'native:paste', 'edit.select-all',
        '-', 'edit.find', 'edit.add-comment',
      ],
    },
    {
      title: 'View',
      items: [
        'view.appearance.system', 'view.appearance.light', 'view.appearance.dark',
        '-', 'view.zen', 'view.sidebar.left', 'panel.toggle.*', 'view.split', 'view.split.switch',
        '-', 'view.title-bar', 'native:fullscreen',
      ],
    },
    {
      title: 'Go',
      items: [
        'go.home', 'go.back', 'go.forward', 'go.daily-calendar',
        '-', 'go.open-document', { submenu: 'Switch Graph', items: ['go.graph.*'] },
      ],
    },
    { title: 'Window', items: [] },
    { title: 'Help', items: ['help.page', '-', 'help.welcome', 'help.start-here', '-', 'view.shortcuts'] },
  ],
}

const ACCELERATOR_KEY_NAMES: Readonly<Record<string, string>> = {
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  "'": 'Quote',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
}

/**
 * The registry's shortcut ('Mod+Shift+D') as a Tauri accelerator
 * ('CmdOrCtrl+Shift+D'), or undefined when it must not become one. A menu
 * accelerator takes its key everywhere in the app, text fields included, so
 * only Mod combinations and function keys qualify. A bare Enter or a letter
 * would be swallowed from every input.
 */
export function toAccelerator(shortcut: string | undefined): string | undefined {
  if (!shortcut) return undefined
  const tokens = shortcut.split('+').map(token => token.trim()).filter(Boolean)
  // 'Mod++' style shortcuts split to an empty key; not used, not supported.
  const key = tokens[tokens.length - 1]
  if (!key) return undefined
  const modifiers = tokens.slice(0, -1).map(token => token.toLowerCase())
  const functionKey = /^F([1-9]|1[0-2])$/i.test(key)
  if (!modifiers.includes('mod') && !functionKey) return undefined
  const parts: string[] = []
  for (const modifier of modifiers) {
    if (modifier === 'mod') parts.push('CmdOrCtrl')
    else if (modifier === 'shift') parts.push('Shift')
    else if (modifier === 'alt') parts.push('Alt')
    else if (modifier === 'ctrl') parts.push('Ctrl')
    else return undefined
  }
  parts.push(ACCELERATOR_KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key))
  return parts.join('+')
}

/** A layout slot shows a command only if the command declares the 'menu' surface. */
function onMenu(command: Command): boolean {
  return command.surfaces.includes('menu')
}

function isEnabled(command: Command, ctx: CommandContext): boolean {
  if (command.disabled === true) return false
  if (command.when && !command.when(ctx)) return false
  if (command.appliesTo && !command.appliesTo(ctx.selection)) return false
  return true
}

function commandItem(command: Command, ctx: CommandContext): NativeMenuItemSpec {
  const accelerator = toAccelerator(command.shortcut)
  const checked = command.isChecked ? command.isChecked(ctx) : command.checked
  return {
    kind: 'command',
    id: command.id,
    label: command.label,
    ...(accelerator ? { accelerator } : {}),
    enabled: isEnabled(command, ctx),
    ...(checked !== undefined ? { checked } : {}),
  }
}

function expandSlots(
  slots: readonly NativeMenuSlot[],
  registry: Pick<CommandRegistry, 'get' | 'getAll'>,
  ctx: CommandContext,
): NativeMenuItemSpec[] {
  const items: NativeMenuItemSpec[] = []
  for (const slot of slots) {
    if (typeof slot !== 'string') {
      const nested = expandSlots(slot.items, registry, ctx)
      if (nested.length > 0) items.push({ kind: 'submenu', label: slot.submenu, items: nested })
    } else if (slot === '-') {
      items.push({ kind: 'separator' })
    } else if (slot.startsWith('native:')) {
      items.push({ kind: 'native', item: slot.slice('native:'.length) })
    } else if (slot.endsWith('.*')) {
      const prefix = slot.slice(0, -1)
      for (const command of registry.getAll()) {
        // A group lists what exists now: a deleted graph leaves the menu
        // rather than lingering disabled.
        if (command.id.startsWith(prefix) ? (onMenu(command) ? isEnabled(command, ctx) : false) : false) {
          items.push(commandItem(command, ctx))
        }
      }
    } else {
      const command = registry.get(slot)
      if (command ? onMenu(command) : false) items.push(commandItem(command!, ctx))
    }
  }
  // No separator at either end, and never two in a row: a slot may expand to
  // nothing.
  const compact: NativeMenuItemSpec[] = []
  for (const item of items) {
    if (item.kind === 'separator' ? (compact.length === 0 || compact[compact.length - 1]?.kind === 'separator') : false) continue
    compact.push(item)
  }
  if (compact[compact.length - 1]?.kind === 'separator') compact.pop()
  return compact
}

/** The spec for `layout` under the current context. */
export function buildNativeMenuSpec(
  layout: NativeMenuLayout,
  registry: Pick<CommandRegistry, 'get' | 'getAll'>,
  ctx: CommandContext,
): NativeMenuSpec {
  return {
    appItems: expandSlots(layout.appItems, registry, ctx),
    menus: layout.menus.map(menu => ({ title: menu.title, items: expandSlots(menu.items, registry, ctx) })),
  }
}

export interface NativeMenuBridge {
  readonly invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
  readonly listen: (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>
}

/** What has focus when a menu command fires. */
export interface MenuFocusState {
  /** Focus is inside a modal dialog. */
  readonly modalOpen: boolean
  /** Focus is in a form field (an input or textarea; not the document editor). */
  readonly textEntry: boolean
}

const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'

/** Read the focus state, through open shadow roots. */
export function menuFocusState(doc: Document): MenuFocusState {
  let active: Element | null = doc.activeElement
  const path: Element[] = []
  while (active) {
    path.push(active)
    const inner: Element | null = active.shadowRoot?.activeElement ?? null
    if (!inner) break
    active = inner
  }
  const deepest = path[path.length - 1] ?? null
  // A form field, not the document editor: the editor holds focus nearly all
  // the time, and counting it refused Rename from the menu while writing.
  const textEntry = deepest instanceof HTMLInputElement
    || deepest instanceof HTMLTextAreaElement
  // A dialog may hold focus in its own shadow tree, so test each host on the
  // focus path and each element's ancestors within its own tree.
  const modalOpen = path.some(element => element.closest(MODAL_SELECTOR) !== null)
  return { modalOpen, textEntry }
}

/**
 * The guards the keyboard path already had (keyboard-shortcuts.ts), for the
 * menu. macOS gives menu key equivalents first refusal, so without them a
 * menu accelerator fires where the keydown handler would have refused. While
 * a dialog has focus, only Select All runs (it acts on the dialog's own field).
 * In a text field, a bare function key (F2 Rename) is left to the field; Mod
 * combinations still run, as they did from the keyboard.
 */
/** The menu commands a dialog's text field still needs while the dialog is up. */
const MODAL_EDIT_COMMANDS = new Set(['edit.select-all', 'edit.undo', 'edit.redo'])

export function menuCommandAllowed(command: Pick<Command, 'id' | 'shortcut'>, focus: MenuFocusState): boolean {
  // Text editing in a dialog still needs the Edit menu's own keys.
  if (focus.modalOpen) return MODAL_EDIT_COMMANDS.has(command.id)
  const accelerator = toAccelerator(command.shortcut)
  const bareFunctionKey = accelerator !== undefined ? /^F\d+$/.test(accelerator) : false
  if (focus.textEntry ? bareFunctionKey : false) return false
  return true
}

export interface NativeMenuOptions {
  readonly registry: Pick<CommandRegistry, 'get' | 'getAll' | 'exec'>
  /** A last check when a menu item fires; a refused command does nothing. */
  readonly canRun?: (command: Command) => boolean
  readonly layout?: NativeMenuLayout
  /** The context commands see from the menu: the open document, not a sidebar pick. */
  readonly context: () => CommandContext
  readonly bridge: NativeMenuBridge
  readonly onError?: (error: unknown) => void
}

export interface NativeMenuHandle {
  /** Resend the menu if anything it shows changed. Cheap; call it after state changes. */
  sync(): void
  dispose(): void
}

export const APP_MENU_EVENT = 'app-menu'

/** Install the menu bar and route its clicks to the registry. */
export function installNativeMenu(options: NativeMenuOptions): NativeMenuHandle {
  const layout = options.layout ?? GARDEN_NATIVE_MENU
  const onError = options.onError ?? (() => undefined)
  let lastSent = ''
  let queued = false
  let disposed = false
  let unlisten: (() => void) | null = null

  const send = (): void => {
    queued = false
    if (disposed) return
    const spec = buildNativeMenuSpec(layout, options.registry, options.context())
    const serialized = JSON.stringify(spec)
    if (serialized === lastSent) return
    lastSent = serialized
    void options.bridge.invoke('set_app_menu', { spec }).catch((error: unknown) => {
      lastSent = ''
      onError(error)
    })
  }

  void options.bridge.listen(APP_MENU_EVENT, (event) => {
    const id = (event.payload as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || disposed) return
    const command = options.registry.get(id)
    if (!command || (options.canRun ? !options.canRun(command) : false)) return
    void options.registry.exec(id, options.context()).catch(onError)
  }).then((stop) => {
    if (disposed) stop()
    else unlisten = stop
  }, onError)

  send()
  return {
    sync(): void {
      if (queued || disposed) return
      queued = true
      queueMicrotask(send)
    },
    dispose(): void {
      disposed = true
      unlisten?.()
    },
  }
}
