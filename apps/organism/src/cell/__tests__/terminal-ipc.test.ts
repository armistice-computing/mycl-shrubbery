import { describe, expect, it } from 'vitest'
import { decodeTerminalFrame, decodeTerminalOpenResult } from '../terminal-ipc.js'

// The shapes here are what garden's terminal_commands.rs serializes:
// TerminalFrame (tag "type", lowercase) and TerminalOpenResponse, bytes in
// standard base64.
describe('terminal wire shapes', () => {
  it('decodes a data frame to the bytes the shell wrote', () => {
    const frame = decodeTerminalFrame({ type: 'data', session: 's1', bytes: 'aGkgG1szMW3DqQ==' })
    expect(frame.type).toBe('data')
    if (frame.type !== 'data') return
    expect([...new Uint8Array(frame.bytes)]).toEqual([104, 105, 32, 27, 91, 51, 49, 109, 195, 169])
  })

  it('passes an exit frame through', () => {
    expect(decodeTerminalFrame({ type: 'exit', session: 's1', code: 7 })).toEqual({ type: 'exit', session: 's1', code: 7 })
  })

  it('decodes the replay, and an empty replay to no bytes', () => {
    expect(new Uint8Array(decodeTerminalOpenResult({ session: 's', generation: 2, replay: 'QUI=' }).replay)).toEqual(new Uint8Array([65, 66]))
    expect(decodeTerminalOpenResult({ session: 's', generation: 2, replay: '' }).replay.byteLength).toBe(0)
  })
})
