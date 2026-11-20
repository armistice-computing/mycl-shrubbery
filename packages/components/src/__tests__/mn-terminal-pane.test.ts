import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import '../mn-terminal-pane.js'
import type { MnTerminalPane, MnTerminalInputDetail, MnTerminalSize } from '../mn-terminal-pane.js'

async function mount(values: Partial<MnTerminalPane> = {}): Promise<MnTerminalPane> {
  const element = document.createElement('mn-terminal-pane') as MnTerminalPane
  Object.assign(element, { available: true, enabled: true, ...values })
  document.body.appendChild(element)
  await element.updateComplete
  return element
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('mn-terminal-pane', () => {
  beforeAll(() => expect(customElements.get('mn-terminal-pane')).toBeDefined())

  it('tells the truth when native terminal support is absent', async () => {
    const element = await mount({ available: false, enabled: false })
    expect(element.shadowRoot?.textContent).toContain('Terminal is unavailable')
    expect(element.shadowRoot?.querySelector('.xterm')).toBeNull()
    expect(element.shadowRoot?.querySelector('button:not([hidden])')).toBeNull()
  })

  it('does not start a session while disabled', async () => {
    const element = await mount({ enabled: false })
    expect(element.shadowRoot?.textContent).toContain('Terminal is off')
    expect(element.shadowRoot?.querySelector('.xterm')).toBeNull()
  })

  it('emits the initial size only after an explicit Open', async () => {
    const element = await mount()
    const seen: MnTerminalSize[] = []
    element.addEventListener('mn-terminal-open', event => seen.push((event as CustomEvent<MnTerminalSize>).detail))
    expect(seen).toEqual([])

    const open = Array.from(element.shadowRoot?.querySelectorAll('button') ?? [])
      .find(button => button.textContent === 'Open')!
    open.click()

    expect(seen).toEqual([{ cols: 80, rows: 24 }])
  })

  it('writes raw bytes and resets once at the start of a replay', async () => {
    const element = await mount({ status: 'live' })
    const write = vi.spyOn(Terminal.prototype, 'write')
    const reset = vi.spyOn(Terminal.prototype, 'reset')
    const first = new Uint8Array([104, 105])
    const second = new Uint8Array([33])

    element.write(first, true)
    element.write(second, true)
    element.write(second, false)

    expect(reset).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenNthCalledWith(1, first, expect.any(Function))
    expect(write).toHaveBeenNthCalledWith(2, second, expect.any(Function))
    expect(write).toHaveBeenNthCalledWith(3, second)
  })

  it('does not type the answers to questions found in replayed output', async () => {
    const element = await mount({ status: 'live' })
    const typed: string[] = []
    element.addEventListener('mn-terminal-input', event => typed.push((event as CustomEvent<MnTerminalInputDetail>).detail.data))
    const settle = () => new Promise(resolve => setTimeout(resolve, 50))
    // "What kind of terminal are you?" and "where is the cursor?"
    const questions = new TextEncoder().encode('\u001b[c\u001b[6n')

    element.write(questions, true)
    await settle()
    expect(typed).toEqual([])

    element.write(questions, false)
    await settle()
    expect(typed.join('')).toContain('\u001b[')
  })

  it('emits string input and End session without owning the native process', async () => {
    const element = await mount({ status: 'live' })
    const inputs: MnTerminalInputDetail[] = []
    let ended = 0
    element.addEventListener('mn-terminal-input', event => inputs.push((event as CustomEvent<MnTerminalInputDetail>).detail))
    element.addEventListener('mn-terminal-end', () => { ended += 1 })
    const terminal = (element as unknown as { terminal: Terminal }).terminal

    terminal.input('printf hello')
    element.shadowRoot?.querySelector<HTMLButtonElement>('.end')?.click()
    element.remove()

    expect(inputs).toEqual([{ data: 'printf hello' }])
    expect(ended).toBe(1)
  })

  it('shows exits and permits a fresh explicit open', async () => {
    const element = await mount({ status: 'exited', exitCode: 0 })
    expect(element.shadowRoot?.textContent).toContain('Shell exited')
    expect(element.shadowRoot?.textContent).toContain('Exit code 0')
    expect(element.shadowRoot?.textContent).toContain('Open a fresh shell')
  })
})
