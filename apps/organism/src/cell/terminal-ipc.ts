import { isTauriHost } from './tauri-local-bootstrap.js'
import type { TerminalChannelFrame, TerminalIpc, TerminalOpenResult } from './terminal-controller.js'

/** A frame as the app sends it: JSON, with the bytes as base64. */
export type TerminalWireFrame = {
  readonly type: 'data'
  readonly session: string
  readonly bytes: string
} | {
  readonly type: 'exit'
  readonly session: string
  readonly code: number | null
}

export interface TerminalWireOpenResult {
  readonly session: string
  readonly generation: number
  readonly replay: string
}

export function decodeBase64(text: string): ArrayBuffer {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

export function decodeTerminalFrame(frame: TerminalWireFrame): TerminalChannelFrame {
  return frame.type === 'data'
    ? { type: 'data', session: frame.session, bytes: decodeBase64(frame.bytes) }
    : frame
}

export function decodeTerminalOpenResult(result: TerminalWireOpenResult): TerminalOpenResult {
  return { session: result.session, generation: result.generation, replay: decodeBase64(result.replay) }
}

export async function createTauriTerminalIpc(): Promise<TerminalIpc | null> {
  if (!isTauriHost()) return null
  const core = await import('@tauri-apps/api/core')
  return {
    settingsGet: () => core.invoke<boolean>('terminal_settings_get'),
    settingsSet: enabled => core.invoke<void>('terminal_settings_set', { enabled }),
    open: async (cols, rows, onFrame) => {
      const channel = new core.Channel<TerminalWireFrame>()
      channel.onmessage = frame => onFrame(decodeTerminalFrame(frame))
      return decodeTerminalOpenResult(
        await core.invoke<TerminalWireOpenResult>('terminal_open', { cols, rows, output: channel }),
      )
    },
    // The app's commands name the argument `session` (garden terminal_commands.rs).
    write: (session, data) => core.invoke<void>('terminal_write', { session, data }),
    resize: (session, cols, rows) => core.invoke<void>('terminal_resize', { session, cols, rows }),
    close: session => core.invoke<void>('terminal_close', { session }),
  }
}
