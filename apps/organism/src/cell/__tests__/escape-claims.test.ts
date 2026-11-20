import { afterEach, describe, expect, it } from 'vitest'
import { escapeIsClaimedElsewhere } from '../escape-claims.js'

afterEach(() => {
  document.body.innerHTML = ''
})

/** Asks the question during dispatch, as the import's keydown listener does. */
function claimedFrom(target: Element, overlayOpen = false): boolean {
  let answer: boolean | null = null
  const listener = (event: Event) => { answer = escapeIsClaimedElsewhere(event, { overlayOpen }) }
  document.addEventListener('keydown', listener, { once: true })
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }))
  document.removeEventListener('keydown', listener)
  return answer!
}

describe('escapeIsClaimedElsewhere', () => {
  it('lets an import have Escape pressed on the page itself', () => {
    const page = document.createElement('main')
    document.body.appendChild(page)
    expect(claimedFrom(page)).toBe(false)
  })

  it('leaves Escape to an open overlay, a modal, the editor and text fields', () => {
    const page = document.createElement('main')
    document.body.appendChild(page)
    expect(claimedFrom(page, true)).toBe(true)

    const editor = document.createElement('div')
    editor.className = 'ProseMirror'
    const inner = document.createElement('p')
    editor.appendChild(inner)
    document.body.appendChild(editor)
    expect(claimedFrom(inner)).toBe(true)

    const field = document.createElement('input')
    document.body.appendChild(field)
    expect(claimedFrom(field)).toBe(true)

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.appendChild(menu)
    expect(claimedFrom(menu)).toBe(true)

    menu.remove()
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    expect(claimedFrom(page)).toBe(true)
  })
})
