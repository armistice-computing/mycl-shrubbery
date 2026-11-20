import { describe, expect, it, vi } from 'vitest'
import { installWindowFileDrop } from '../window-file-drop.js'

function fileDrag(type: 'dragover' | 'drop', files: unknown[], kinds = ['Files']): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: kinds, files, dropEffect: 'none' },
  })
  return event
}

describe('installWindowFileDrop', () => {
  it('offers an unhandled file drop to the import and refuses navigation', () => {
    const onFiles = vi.fn()
    const remove = installWindowFileDrop({ onFiles })
    const over = fileDrag('dragover', [])
    window.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    const drop = fileDrag('drop', [{ name: 'a.md' }])
    window.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(onFiles).toHaveBeenCalledTimes(1)
    remove()
  })

  it('leaves a drop that a target already took', () => {
    const onFiles = vi.fn()
    const remove = installWindowFileDrop({ onFiles })
    const host = document.createElement('div')
    document.body.append(host)
    host.addEventListener('drop', event => event.preventDefault())
    host.dispatchEvent(fileDrag('drop', [{ name: 'a.md' }]))
    expect(onFiles).not.toHaveBeenCalled()
    host.remove()
    remove()
  })

  it('ignores drags that carry no files', () => {
    const onFiles = vi.fn()
    const remove = installWindowFileDrop({ onFiles })
    const over = fileDrag('dragover', [], ['text/plain'])
    window.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(false)
    remove()
  })
})
