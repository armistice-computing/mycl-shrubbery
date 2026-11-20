import { afterEach, describe, expect, it, vi } from 'vitest'
import '../mn-toast.js'
import type { MnToast } from '../mn-toast.js'

async function mount(set: (toast: MnToast) => void): Promise<MnToast> {
  const toast = document.createElement('mn-toast') as MnToast
  set(toast)
  document.body.appendChild(toast)
  await toast.updateComplete
  return toast
}

const box = (toast: MnToast) => toast.shadowRoot!.querySelector('.toast') as HTMLElement

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('mn-toast', () => {
  it('has one role per node: alert for errors, status otherwise, and no aria-live of its own', async () => {
    const error = await mount(t => { t.type = 'error'; t.message = 'Failed' })
    expect(box(error).getAttribute('role')).toBe('alert')
    expect(box(error).hasAttribute('aria-live')).toBe(false)
    const info = await mount(t => { t.type = 'success'; t.message = 'Done' })
    expect(box(info).getAttribute('role')).toBe('status')
  })

  it('stays quiet when its host speaks for it', async () => {
    const toast = await mount(t => { t.type = 'error'; t.message = 'Failed'; t.announce = false })
    expect(box(toast).getAttribute('role')).toBe('group')
    expect(box(toast).getAttribute('aria-label')).toBe('Failed')
  })

  it('waits while the pointer or focus is inside it, then finishes its time', async () => {
    vi.useFakeTimers()
    const toast = await mount(t => { t.message = 'Read me'; t.duration = 3000; t.autoShow = false })
    toast.show()
    vi.advanceTimersByTime(1000)
    toast.dispatchEvent(new MouseEvent('mouseenter'))
    vi.advanceTimersByTime(10_000)
    expect(toast.visible).toBe(true)
    toast.dispatchEvent(new MouseEvent('mouseleave'))
    vi.advanceTimersByTime(2100)
    vi.advanceTimersByTime(toast.animationMs + 10)
    expect(toast.isConnected).toBe(false)
  })
})
