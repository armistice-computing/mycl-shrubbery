import { afterEach, describe, expect, it } from 'vitest'
import { canTakeFocus, focusWhenReady, installFocusRescue } from '../focus-return.js'

afterEach(() => {
  document.body.innerHTML = ''
})

function editorStub() {
  const element = document.createElement('div')
  element.tabIndex = 0
  element.className = 'ProseMirror'
  document.body.appendChild(element)
  let ready = true
  return {
    element,
    setReady(value: boolean) { ready = value },
    focusEditor(): boolean {
      if (!ready) return false
      element.focus()
      return true
    },
  }
}

describe('focusWhenReady', () => {
  it('waits for the editor to mount, then focuses it', () => {
    const editor = editorStub()
    editor.setReady(false)
    const frames: Array<() => void> = []
    focusWhenReady(() => editor, { requestFrame: cb => { frames.push(cb); return frames.length } })
    expect(document.activeElement).toBe(document.body)
    editor.setReady(true)
    frames.shift()?.()
    expect(document.activeElement).toBe(editor.element)
  })

  it('never takes focus from a text field the person moved to', () => {
    const editor = editorStub()
    const search = document.createElement('input')
    search.type = 'text'
    document.body.appendChild(search)
    search.focus()
    expect(canTakeFocus()).toBe(false)
    focusWhenReady(() => editor, { requestFrame: () => 0 })
    expect(document.activeElement).toBe(search)
  })

  it('takes focus from a button or tree row (the click that opened the document)', () => {
    const editor = editorStub()
    const row = document.createElement('button')
    document.body.appendChild(row)
    row.focus()
    focusWhenReady(() => editor, { requestFrame: () => 0 })
    expect(document.activeElement).toBe(editor.element)
  })
})

describe('installFocusRescue', () => {
  it('returns focus to the editor when a closing transient takes the focused element with it', async () => {
    const editor = editorStub()
    const uninstall = installFocusRescue({ getEditor: () => editor })
    const picker = document.createElement('input')
    document.body.appendChild(picker)
    picker.focus()
    // Browsers move focus to <body> silently on removal; the rescue hears the DOM change.
    picker.remove()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(document.activeElement).toBe(editor.element)
    uninstall()
  })

  it('leaves focus alone when the person just clicked empty space', async () => {
    const editor = editorStub()
    const uninstall = installFocusRescue({ getEditor: () => editor })
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    button.blur()
    document.body.appendChild(document.createElement('span'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(document.activeElement).not.toBe(editor.element)
    uninstall()
  })

  it('waits while something modal owns focus', async () => {
    const editor = editorStub()
    const uninstall = installFocusRescue({ getEditor: () => editor, isBlocked: () => true })
    const dialogInput = document.createElement('input')
    document.body.appendChild(dialogInput)
    dialogInput.focus()
    dialogInput.remove()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(document.activeElement).not.toBe(editor.element)
    uninstall()
  })
})
