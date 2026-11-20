import type { MnTerminalSize, MnTerminalStatus } from '@shrubbery/components'

export interface TerminalOpenResult {
  readonly session: string
  readonly generation: number
  readonly replay: ArrayBuffer
}

export type TerminalChannelFrame = {
  readonly type: 'data'
  readonly session: string
  readonly bytes: ArrayBuffer
} | {
  readonly type: 'exit'
  readonly session: string
  readonly code: number | null
}

export interface TerminalView {
  readonly size: MnTerminalSize
  reset(): void
  write(data: Uint8Array, replay?: boolean): void
  focusTerminal?(): void
}

export interface TerminalIpc {
  settingsGet(): Promise<boolean>
  settingsSet(enabled: boolean): Promise<void>
  open(cols: number, rows: number, onFrame: (frame: TerminalChannelFrame) => void): Promise<TerminalOpenResult>
  write(sessionId: string, data: string): Promise<void>
  resize(sessionId: string, cols: number, rows: number): Promise<void>
  close(sessionId: string): Promise<void>
}

export interface TerminalSnapshot {
  readonly available: boolean
  readonly enabled: boolean
  readonly status: MnTerminalStatus
  readonly error: string
  readonly exitCode: number | null
}

interface OrganismTerminalControllerOptions {
  readonly ipc?: TerminalIpc | null
  readonly requestRender?: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class OrganismTerminalController {
  private view: TerminalView | null = null
  private sessionId: string | null = null
  private available = false
  private enabled = false
  private status: MnTerminalStatus = 'idle'
  private error = ''
  private exitCode: number | null = null
  private operation = 0
  private destroyed = false

  constructor(private readonly options: OrganismTerminalControllerOptions = {}) {}

  snapshot(): TerminalSnapshot {
    return {
      available: this.available,
      enabled: this.enabled,
      status: this.status,
      error: this.error,
      exitCode: this.exitCode,
    }
  }

  async loadSettings(): Promise<boolean> {
    const ipc = this.options.ipc
    if (!ipc || this.destroyed) {
      this.available = false
      this.enabled = false
      this.options.requestRender?.()
      return false
    }
    try {
      const enabled = await ipc.settingsGet()
      if (this.destroyed) return enabled
      this.available = true
      this.enabled = enabled
      this.error = ''
      if (!enabled && this.status !== 'idle') {
        this.sessionId = null
        this.status = 'idle'
        this.exitCode = null
      }
      this.options.requestRender?.()
      return enabled
    } catch {
      if (!this.destroyed) {
        this.available = false
        this.enabled = false
        this.options.requestRender?.()
      }
      return false
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const ipc = this.options.ipc
    if (!ipc || this.destroyed) throw new Error('Terminal is unavailable in this runtime')
    this.operation += 1
    try {
      await ipc.settingsSet(enabled)
      if (this.destroyed) return
      this.available = true
      this.enabled = enabled
      this.error = ''
      this.exitCode = null
      if (!enabled) {
        this.sessionId = null
        this.status = 'idle'
      }
      this.options.requestRender?.()
    } catch (error) {
      if (!this.destroyed) {
        this.error = errorMessage(error)
        this.options.requestRender?.()
      }
      throw error
    }
  }

  attach(view: TerminalView): void {
    if (this.destroyed) return
    const previous = this.view
    this.view = view
    if (previous !== view && this.status === 'live' && this.sessionId) {
      void this.open(view.size)
    }
  }

  detach(view: TerminalView): void {
    if (this.view === view) this.view = null
  }

  async open(size: MnTerminalSize): Promise<void> {
    const ipc = this.options.ipc
    if (!ipc || this.destroyed || !this.available || !this.enabled) return
    if (this.status === 'opening') return
    const operation = ++this.operation
    const queued: TerminalChannelFrame[] = []
    let opened = false
    this.status = 'opening'
    this.error = ''
    this.exitCode = null
    this.options.requestRender?.()
    const onFrame = (frame: TerminalChannelFrame): void => {
      if (this.destroyed || operation !== this.operation) return
      if (!opened) {
        queued.push(frame)
        return
      }
      this.applyFrame(frame)
    }
    try {
      const openedSession = await ipc.open(size.cols, size.rows, onFrame)
      if (this.destroyed || operation !== this.operation) {
        await ipc.close(openedSession.session).catch(() => undefined)
        return
      }
      this.sessionId = openedSession.session
      this.status = 'live'
      opened = true
      this.view?.reset()
      if (openedSession.replay.byteLength > 0) this.view?.write(new Uint8Array(openedSession.replay), true)
      for (const frame of queued) this.applyFrame(frame)
      this.options.requestRender?.()
    } catch (error) {
      if (this.destroyed || operation !== this.operation) return
      this.sessionId = null
      this.status = 'error'
      this.error = errorMessage(error)
      this.options.requestRender?.()
    }
  }

  async write(data: string): Promise<void> {
    const ipc = this.options.ipc
    const sessionId = this.sessionId
    if (!ipc || !sessionId || this.status !== 'live' || this.destroyed) return
    const operation = this.operation
    try {
      await ipc.write(sessionId, data)
    } catch (error) {
      if (!this.destroyed && operation === this.operation) {
        this.status = 'error'
        this.error = errorMessage(error)
        this.options.requestRender?.()
      }
    }
  }

  async resize(size: MnTerminalSize): Promise<void> {
    const ipc = this.options.ipc
    const sessionId = this.sessionId
    if (!ipc || !sessionId || this.status !== 'live' || this.destroyed) return
    await ipc.resize(sessionId, size.cols, size.rows).catch(error => {
      if (!this.destroyed) {
        this.error = errorMessage(error)
        this.options.requestRender?.()
      }
    })
  }

  async end(): Promise<void> {
    const ipc = this.options.ipc
    const sessionId = this.sessionId
    const operation = ++this.operation
    this.sessionId = null
    this.status = 'idle'
    this.exitCode = null
    this.error = ''
    this.options.requestRender?.()
    if (!ipc || !sessionId) return
    try {
      await ipc.close(sessionId)
    } catch (error) {
      if (!this.destroyed && operation === this.operation) {
        this.status = 'error'
        this.error = errorMessage(error)
        this.options.requestRender?.()
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.operation += 1
    const sessionId = this.sessionId
    this.sessionId = null
    this.view = null
    if (sessionId && this.options.ipc) void this.options.ipc.close(sessionId).catch(() => undefined)
  }

  private applyFrame(frame: TerminalChannelFrame): void {
    if (frame.session !== this.sessionId) return
    if (frame.type === 'exit') {
      this.sessionId = null
      this.status = 'exited'
      this.exitCode = frame.code
      this.options.requestRender?.()
      return
    }
    this.view?.write(new Uint8Array(frame.bytes), false)
  }
}
