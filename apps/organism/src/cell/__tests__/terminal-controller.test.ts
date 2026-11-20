import { describe, expect, it, vi } from 'vitest'
import { OrganismTerminalController, type TerminalChannelFrame, type TerminalIpc, type TerminalOpenResult, type TerminalView } from '../terminal-controller.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function fakeIpc(): TerminalIpc & {
  frames: Array<(frame: TerminalChannelFrame) => void>
  open: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const frames: Array<(frame: TerminalChannelFrame) => void> = []
  let generation = 0
  return {
    frames,
    settingsGet: vi.fn(async () => true),
    settingsSet: vi.fn(async () => undefined),
    open: vi.fn(async (_cols: number, _rows: number, onFrame: (frame: TerminalChannelFrame) => void) => {
      frames.push(onFrame)
      generation += 1
      return { session: `session-${generation}`, generation, replay: new ArrayBuffer(0) }
    }),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
}

function fakeView(): TerminalView & { resets: number; writes: Array<{ data: Uint8Array; replay: boolean }> } {
  return {
    size: { cols: 100, rows: 30 },
    resets: 0,
    writes: [],
    reset() { this.resets += 1 },
    write(data, replay = false) { this.writes.push({ data, replay }) },
  }
}

async function readyController(ipc = fakeIpc()) {
  const controller = new OrganismTerminalController({ ipc })
  await controller.loadSettings()
  const view = fakeView()
  controller.attach(view)
  return { controller, ipc, view }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('OrganismTerminalController', () => {
  it('is unavailable without native IPC and never opens', async () => {
    const controller = new OrganismTerminalController()
    expect(await controller.loadSettings()).toBe(false)
    await controller.open({ cols: 80, rows: 24 })
    expect(controller.snapshot()).toMatchObject({ available: false, enabled: false, status: 'idle' })
  })

  it('loads and writes the native enabled setting', async () => {
    const { controller, ipc } = await readyController()
    expect(controller.snapshot()).toMatchObject({ available: true, enabled: true })
    await controller.setEnabled(false)
    expect(ipc.settingsSet).toHaveBeenCalledWith(false)
    expect(controller.snapshot()).toMatchObject({ enabled: false, status: 'idle' })
  })

  it('marks a missing native backend unavailable', async () => {
    const ipc = fakeIpc()
    vi.mocked(ipc.settingsGet).mockRejectedValue(new Error('unknown command'))
    const controller = new OrganismTerminalController({ ipc })
    expect(await controller.loadSettings()).toBe(false)
    expect(controller.snapshot().available).toBe(false)
  })

  it('opens with initial dimensions and queues frames until the generation is ready', async () => {
    const ipc = fakeIpc()
    const pending = deferred<TerminalOpenResult>()
    let onFrame!: (frame: TerminalChannelFrame) => void
    vi.mocked(ipc.open).mockImplementation((_cols, _rows, callback) => {
      onFrame = callback
      return pending.promise
    })
    const { controller, view } = await readyController(ipc)

    const opening = controller.open(view.size)
    onFrame({ type: 'data', session: 'session-a', bytes: new Uint8Array([65]).buffer })
    expect(view.writes).toEqual([])
    pending.resolve({ session: 'session-a', generation: 1, replay: new ArrayBuffer(0) })
    await opening

    expect(ipc.open).toHaveBeenCalledWith(100, 30, onFrame)
    expect(controller.snapshot()).toMatchObject({ status: 'live' })
    expect(view.writes).toEqual([{ data: new Uint8Array([65]), replay: false }])
  })

  it('writes the returned replay before live frames and passes string input through', async () => {
    const { controller, ipc, view } = await readyController()
    vi.mocked(ipc.open).mockImplementation(async (_cols, _rows, onFrame) => {
      ipc.frames.push(onFrame)
      return { session: 'session-1', generation: 1, replay: new Uint8Array([65]).buffer }
    })
    await controller.open(view.size)
    ipc.frames[0]!({ type: 'data', session: 'session-1', bytes: new Uint8Array([66]).buffer })
    await controller.write('printf marker\r')
    await controller.resize({ cols: 120, rows: 40 })

    expect(view.resets).toBe(1)
    expect(view.writes).toEqual([
      { data: new Uint8Array([65]), replay: true },
      { data: new Uint8Array([66]), replay: false },
    ])
    expect(ipc.write).toHaveBeenCalledWith('session-1', 'printf marker\r')
    expect(ipc.resize).toHaveBeenCalledWith('session-1', 120, 40)
  })

  it('closes a late shell instead of letting a stale open replace a newer state', async () => {
    const ipc = fakeIpc()
    const pending = deferred<TerminalOpenResult>()
    vi.mocked(ipc.open).mockReturnValue(pending.promise)
    const { controller, view } = await readyController(ipc)

    const opening = controller.open(view.size)
    await controller.setEnabled(false)
    pending.resolve({ session: 'stale-session', generation: 1, replay: new ArrayBuffer(0) })
    await opening

    expect(ipc.close).toHaveBeenCalledWith('stale-session')
    expect(controller.snapshot()).toMatchObject({ enabled: false, status: 'idle' })
  })

  it('drops stale frames and keeps a hidden session alive', async () => {
    const { controller, ipc, view } = await readyController()
    await controller.open(view.size)
    const staleFrame = ipc.frames[0]!
    controller.detach(view)
    staleFrame({ type: 'data', session: 'session-1', bytes: new Uint8Array([67]).buffer })

    expect(ipc.close).not.toHaveBeenCalled()
    expect(view.writes).toEqual([])
    expect(controller.snapshot().status).toBe('live')

    const replacement = fakeView()
    controller.attach(replacement)
    await flush()
    expect(ipc.open).toHaveBeenCalledTimes(2)
    staleFrame({ type: 'data', session: 'session-1', bytes: new Uint8Array([68]).buffer })
    expect(replacement.writes).toEqual([])
  })

  it('records shell exit and opens a fresh generation next time', async () => {
    const { controller, ipc, view } = await readyController()
    await controller.open(view.size)
    ipc.frames[0]!({ type: 'exit', session: 'session-1', code: 0 })
    expect(controller.snapshot()).toMatchObject({ status: 'exited', exitCode: 0 })

    await controller.open(view.size)
    expect(ipc.open).toHaveBeenCalledTimes(2)
    expect(view.resets).toBe(2)
    expect(controller.snapshot().status).toBe('live')
    await controller.write('fresh')
    expect(ipc.write).toHaveBeenCalledWith('session-2', 'fresh')
  })

  it('End session kills while pane detach alone does not', async () => {
    const { controller, ipc, view } = await readyController()
    await controller.open(view.size)
    controller.detach(view)
    expect(ipc.close).not.toHaveBeenCalled()
    await controller.end()
    expect(ipc.close).toHaveBeenCalledWith('session-1')
    expect(controller.snapshot().status).toBe('idle')
  })

  it('destroy closes the live generation and ignores its later frames', async () => {
    const { controller, ipc, view } = await readyController()
    await controller.open(view.size)
    const frame = ipc.frames[0]!
    controller.destroy()
    frame({ type: 'data', session: 'session-1', bytes: new Uint8Array([69]).buffer })

    expect(ipc.close).toHaveBeenCalledWith('session-1')
    expect(view.writes).toEqual([])
  })
})
