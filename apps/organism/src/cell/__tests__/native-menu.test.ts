import { describe, expect, it } from 'vitest'
import { CommandRegistryImpl, type Command, type CommandContext } from '@shrubbery/nucleus'
import { GARDEN_NATIVE_MENU,
  buildNativeMenuSpec,
  installNativeMenu,
  menuCommandAllowed,
  menuFocusState,
  toAccelerator,
  type NativeMenuLayout,
  type NativeMenuSpec,
} from '../native-menu.js'

const ctx: CommandContext = {
  selection: null,
  graphId: 'g',
  documentId: 'd',
  rightPanelMode: 'none',
  posture: 'application',
}

function command(id: string, extra: Partial<Command> = {}): Command {
  return { id, label: id, category: 'Test', surfaces: ['menu'], run: () => undefined, ...extra }
}

describe('the Mycl menu layout', () => {
  it('offers Import in File and the welcome and Start Here in Help', () => {
    const file = GARDEN_NATIVE_MENU.menus.find(menu => menu.title === 'File')!
    const help = GARDEN_NATIVE_MENU.menus.find(menu => menu.title === 'Help')!
    expect(file.items).toContain('file.import')
    expect(help.items).toEqual(['help.page', '-', 'help.welcome', 'help.start-here', '-', 'view.shortcuts'])
  })
})

describe('toAccelerator', () => {
  it('turns Mod combinations and function keys into Tauri accelerators', () => {
    expect(toAccelerator('Mod+Shift+D')).toBe('CmdOrCtrl+Shift+D')
    expect(toAccelerator('Mod+Alt+N')).toBe('CmdOrCtrl+Alt+N')
    expect(toAccelerator('Mod+,')).toBe('CmdOrCtrl+Comma')
    expect(toAccelerator('Mod+[')).toBe('CmdOrCtrl+BracketLeft')
    expect(toAccelerator('Mod+Shift+.')).toBe('CmdOrCtrl+Shift+Period')
    expect(toAccelerator('Mod+/')).toBe('CmdOrCtrl+Slash')
    expect(toAccelerator('F2')).toBe('F2')
  })

  it('refuses keys a menu would steal from every text field', () => {
    expect(toAccelerator('Enter')).toBeUndefined()
    expect(toAccelerator('Shift+A')).toBeUndefined()
    expect(toAccelerator(undefined)).toBeUndefined()
  })
})

describe('buildNativeMenuSpec', () => {
  const registry = new CommandRegistryImpl()
  registry.register([
    command('file.new', { label: 'New', shortcut: 'Mod+N' }),
    command('file.gone', { when: () => false }),
    command('panel.toggle.a', { label: 'A' }),
    command('panel.toggle.b', { label: 'B', shortcut: 'Mod+Shift+B' }),
    command('view.dark', { label: 'Dark', isChecked: () => true }),
  ])
  const layout: NativeMenuLayout = {
    appItems: ['missing.command'],
    menus: [
      { title: 'File', items: ['-', 'file.new', '-', '-', 'missing.command', '-', 'file.gone', '-'] },
      { title: 'View', items: ['native:undo', 'panel.toggle.*', 'view.dark'] },
    ],
  }
  const spec = buildNativeMenuSpec(layout, registry, ctx)

  it('maps commands to items with accelerator, enabled and checked state', () => {
    expect(spec.menus[0]!.items).toEqual([
      { kind: 'command', id: 'file.new', label: 'New', accelerator: 'CmdOrCtrl+N', enabled: true },
      { kind: 'separator' },
      { kind: 'command', id: 'file.gone', label: 'file.gone', enabled: false },
    ])
  })

  it('expands prefix slots in registration order, and passes native items through', () => {
    expect(spec.menus[1]!.items.map(item => (item.kind === 'command' ? item.id : item.kind))).toEqual([
      'native', 'panel.toggle.a', 'panel.toggle.b', 'view.dark',
    ])
    expect(spec.menus[1]!.items[3]).toMatchObject({ checked: true })
  })

  it('leaves out commands that are not registered', () => {
    expect(spec.appItems).toEqual([])
  })
})

describe('installNativeMenu', () => {
  it('sends the spec once, resends only on change, and runs clicked commands', async () => {
    const registry = new CommandRegistryImpl()
    let label = 'First'
    const ran: string[] = []
    // Built directly: a spread would read the label getter once and freeze it.
    registry.register({
      id: 'go.home',
      get label() { return label },
      category: 'Go',
      surfaces: ['menu'],
      run: () => { ran.push('go.home') },
    })
    const sent: NativeMenuSpec[] = []
    let handler: ((event: { payload: unknown }) => void) | null = null
    const menu = installNativeMenu({
      registry,
      layout: { appItems: [], menus: [{ title: 'Go', items: ['go.home'] }] },
      context: () => ctx,
      bridge: {
        invoke: async (_command, args) => { sent.push(args.spec as NativeMenuSpec) },
        listen: async (_event, h) => { handler = h; return () => { handler = null } },
      },
    })
    expect(sent).toHaveLength(1)
    menu.sync()
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    label = 'Second'
    menu.sync()
    await Promise.resolve()
    expect(sent).toHaveLength(2)
    expect(sent[1]!.menus[0]!.items[0]).toMatchObject({ label: 'Second' })

    await Promise.resolve()
    handler!({ payload: { id: 'go.home' } })
    await Promise.resolve()
    expect(ran).toEqual(['go.home'])
    menu.dispose()
    expect(handler).toBeNull()
  })
})

describe('the menu keeps the keyboard path\'s guards', () => {
  it('lists only commands that declare the menu surface', () => {
    const registry = new CommandRegistryImpl()
    registry.register([
      command('doc.rename', { surfaces: ['context', 'shortcut'], shortcut: 'F2' }),
      command('doc.menu', { surfaces: ['menu'] }),
    ])
    const spec = buildNativeMenuSpec(
      { appItems: [], menus: [{ title: 'File', items: ['doc.rename', 'doc.menu'] }] },
      registry,
      ctx,
    )
    expect(spec.menus[0]!.items.map(item => (item.kind === 'command' ? item.id : item.kind))).toEqual(['doc.menu'])
  })

  it('runs only Select All, Undo and Redo while a dialog has focus', () => {
    const modal = { modalOpen: true, textEntry: true }
    expect(menuCommandAllowed({ id: 'document.rename', shortcut: 'F2' }, modal)).toBe(false)
    expect(menuCommandAllowed({ id: 'go.home', shortcut: 'Mod+Shift+D' }, modal)).toBe(false)
    expect(menuCommandAllowed({ id: 'edit.select-all', shortcut: 'Mod+A' }, modal)).toBe(true)
    expect(menuCommandAllowed({ id: 'edit.undo', shortcut: 'Mod+Z' }, modal)).toBe(true)
    expect(menuCommandAllowed({ id: 'edit.redo', shortcut: 'Mod+Shift+Z' }, modal)).toBe(true)
  })

  it('gives the Edit menu registry Undo and Redo, never the native items (Eschaton, 2026-11-17)', async () => {
    const { GARDEN_NATIVE_MENU } = await import('../native-menu.js')
    const edit = GARDEN_NATIVE_MENU.menus.find(menu => menu.title === 'Edit')!
    expect(edit.items).toContain('edit.undo')
    expect(edit.items).toContain('edit.redo')
    expect(edit.items).not.toContain('native:undo')
    expect(edit.items).not.toContain('native:redo')
    expect(toAccelerator('Mod+Z')).toBe('CmdOrCtrl+Z')
    expect(toAccelerator('Mod+Shift+Z')).toBe('CmdOrCtrl+Shift+Z')
  })

  it('leaves a bare function key to a focused text field, but not Mod combinations', () => {
    const typing = { modalOpen: false, textEntry: true }
    expect(menuCommandAllowed({ id: 'document.rename', shortcut: 'F2' }, typing)).toBe(false)
    expect(menuCommandAllowed({ id: 'edit.find', shortcut: 'Mod+F' }, typing)).toBe(true)
    expect(menuCommandAllowed({ id: 'document.rename', shortcut: 'F2' }, { modalOpen: false, textEntry: false })).toBe(true)
  })

  it('does not count the document editor as a text field', () => {
    const editor = document.body.appendChild(Object.assign(document.createElement('div'), { contentEditable: 'true', tabIndex: 0 }))
    // happy-dom leaves isContentEditable false; the browser would say true.
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    editor.focus()
    const focus = menuFocusState(document)
    expect(focus.textEntry).toBe(false)
    expect(menuCommandAllowed({ id: 'document.rename', shortcut: 'F2' }, focus)).toBe(true)
    editor.blur()
    editor.remove()
  })

  it('reads focus through shadow roots, and a dialog around it', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const input = document.createElement('input')
    dialog.appendChild(input)
    shadow.appendChild(dialog)
    input.focus()
    expect(menuFocusState(document)).toEqual({ modalOpen: true, textEntry: true })
    input.blur()
    host.remove()
  })

  it('refuses a click the guard refuses', async () => {
    const registry = new CommandRegistryImpl()
    const ran: string[] = []
    registry.register(command('document.rename', { shortcut: 'F2', run: () => { ran.push('rename') } }))
    let handler: ((event: { payload: unknown }) => void) | null = null
    installNativeMenu({
      registry,
      layout: { appItems: [], menus: [{ title: 'File', items: ['document.rename'] }] },
      context: () => ctx,
      canRun: () => false,
      bridge: {
        invoke: async () => undefined,
        listen: async (_event, h) => { handler = h; return () => undefined },
      },
    })
    await Promise.resolve()
    handler!({ payload: { id: 'document.rename' } })
    await Promise.resolve()
    expect(ran).toEqual([])
  })
})

describe('submenus', () => {
  it('nest a group, leave out what is unavailable, and vanish when empty', () => {
    const registry = new CommandRegistryImpl()
    registry.register([
      command('go.graph.default', { label: 'Default', isChecked: () => true }),
      command('go.graph.old', { label: 'Deleted', when: () => false }),
    ])
    const spec = buildNativeMenuSpec(
      {
        appItems: [],
        menus: [{ title: 'Go', items: [
          { submenu: 'Switch Graph', items: ['go.graph.*'] },
          { submenu: 'Nothing Here', items: ['go.none.*'] },
        ] }],
      },
      registry,
      ctx,
    )
    expect(spec.menus[0]!.items).toEqual([
      {
        kind: 'submenu',
        label: 'Switch Graph',
        items: [{ kind: 'command', id: 'go.graph.default', label: 'Default', enabled: true, checked: true }],
      },
    ])
  })
})
