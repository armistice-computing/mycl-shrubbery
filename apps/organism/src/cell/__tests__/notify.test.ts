import { afterEach, describe, expect, it } from 'vitest'
import { createNotifier, plainErrorNotice } from '../notify.js'

type Toast = HTMLElement & { type: string; message: string; description: string; duration: number; announce: boolean; dismiss(): void }

/** Toasts still on show: a retired one animates out (closing) before it leaves. */
function toasts(): Toast[] {
  return (Array.from(document.querySelectorAll('mn-toast')) as Toast[]).filter(toast => !(toast as Toast & { closing?: boolean }).closing)
}

// The organism tests run without the component registry; a stand-in with the
// same surface keeps these tests about the notifier, not the element.
if (!customElements.get('mn-toast')) {
  customElements.define('mn-toast', class extends HTMLElement {
    type = ''
    message = ''
    description = ''
    duration = 0
    announce = true
    dismiss(): void {
      this.remove()
      this.dispatchEvent(new CustomEvent('mn-dismiss'))
    }
  })
}

afterEach(() => {
  for (const toast of Array.from(document.querySelectorAll('mn-toast'))) toast.remove()
  document.getElementById('mn-announcer')?.remove()
})

describe('plain error notices', () => {
  it('says what failed in plain words and keeps the reason, without the stack', () => {
    expect(plainErrorNotice('document import error:\nError: HTTP 500\n    at fetch (main.js:1:1)')).toEqual({
      message: "Couldn't import",
      description: 'HTTP 500',
    })
    expect(plainErrorNotice('image upload error:\nThe file is too large')).toEqual({
      message: "Couldn't add the image",
      description: 'The file is too large',
    })
  })

  it('keeps background diagnostics on the status line only', () => {
    for (const noise of [
      'wire bundle read error:\nHTTP 503',
      'wire refresh ignored: no open cell store for w1',
      'render error:\nboom',
      'Organism boot failed:\nx',
      'native menu: missing',
    ]) {
      expect(plainErrorNotice(noise)).toBeNull()
    }
  })

  it('says something neutral for a failure it has no sentence for', () => {
    expect(plainErrorNotice('artifact "Plan" is not ready for image editing.')).toEqual({
      message: "Something didn't work",
      description: 'artifact "Plan" is not ready for image editing.',
    })
  })
})

describe('the notifier', () => {
  it('shows a toast that stays quiet and speaks once through the live region', async () => {
    const notifier = createNotifier(document)
    notifier.error("Couldn't import", { description: 'HTTP 500' })
    const [toast] = toasts()
    expect(toast?.type).toBe('error')
    expect(toast?.announce).toBe(false)
    const region = document.getElementById('mn-announcer')!
    expect(region.getAttribute('aria-live')).toBe('polite')
    // Text arrives after the region exists, so it is announced.
    expect(region.textContent).toBe('')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(region.textContent).toBe("Couldn't import. HTTP 500")
  })

  it('shows the same notice once within the dedupe window, and again after it', () => {
    let t = 0
    const notifier = createNotifier(document, { now: () => t, dedupeMs: 1000 })
    notifier.error('Same')
    notifier.error('Same')
    expect(toasts()).toHaveLength(1)
    t = 1500
    notifier.error('Same')
    expect(toasts()).toHaveLength(2)
  })

  it('keeps at most three at a time, retiring the oldest', () => {
    const notifier = createNotifier(document, { max: 3 })
    for (const message of ['one', 'two', 'three', 'four']) notifier.info(message)
    expect(toasts().map(toast => toast.message)).toEqual(['two', 'three', 'four'])
  })

  it('replaces a keyed notice in place: an import becomes its result', () => {
    const notifier = createNotifier(document)
    notifier.info('Importing 3 files…', { key: 'import', duration: 0 })
    notifier.success('Imported 3 documents', { key: 'import' })
    expect(toasts().map(toast => toast.message)).toEqual(['Imported 3 documents'])
    notifier.clear('import')
    expect(toasts()).toHaveLength(0)
  })
})
