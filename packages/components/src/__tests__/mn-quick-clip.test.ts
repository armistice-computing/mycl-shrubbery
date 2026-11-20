import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import '../mn-quick-clip.js'
import type { MnQuickClip, MnQuickClipRequestDetail } from '../mn-quick-clip.js'

async function mount(): Promise<MnQuickClip> {
  const element = document.createElement('mn-quick-clip') as MnQuickClip
  document.body.appendChild(element)
  await element.updateComplete
  return element
}

async function open(element: MnQuickClip): Promise<ShadowRoot> {
  element.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Quick clip"]')!.click()
  await new Promise(resolve => setTimeout(resolve, 0))
  await element.updateComplete
  return element.shadowRoot!
}

async function enterUrl(element: MnQuickClip, value: string): Promise<void> {
  const input = element.shadowRoot!.querySelector<HTMLInputElement>('input')!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  await element.updateComplete
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('mn-quick-clip', () => {
  beforeAll(() => expect(customElements.get('mn-quick-clip')).toBeDefined())

  it('says why Clip is unavailable until the text is a web address', async () => {
    const element = document.createElement('mn-quick-clip') as HTMLElement & { updateComplete: Promise<unknown>; status: string }
    document.body.appendChild(element)
    await element.updateComplete
    const submit = element.shadowRoot!.querySelector<HTMLButtonElement>('.submit')!
    expect(submit.disabled).toBe(true)
    expect(submit.title).toMatch(/http/)
    element.remove()
  })

  it('opens an accessible dialog, focuses its URL input, and closes with Escape', async () => {
    const element = await mount()
    const root = await open(element)

    const dialog = root.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Quick clip')
    expect(dialog.hidden).toBe(false)
    expect(root.querySelector('[aria-label="Quick clip"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(root.activeElement).toBe(root.querySelector('input'))

    root.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
    }))
    await element.updateComplete
    expect(dialog.hidden).toBe(true)
    expect(root.querySelector('[aria-label="Quick clip"]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('validates locally and emits normalized web clip requests across the shadow boundary', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const element = document.createElement('mn-quick-clip') as MnQuickClip
    host.appendChild(element)
    await element.updateComplete
    await open(element)
    const seen: MnQuickClipRequestDetail[] = []
    host.addEventListener('mn-quick-clip-request', event => {
      seen.push((event as CustomEvent<MnQuickClipRequestDetail>).detail)
    })

    await enterUrl(element, 'file:///etc/passwd')
    element.shadowRoot!.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await element.updateComplete
    expect(seen).toEqual([])
    expect(element.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain('valid http:// or https://')

    await enterUrl(element, ' https://example.com/article?q=roots ')
    element.shadowRoot!.querySelector<HTMLFormElement>('form')!.requestSubmit()
    expect(seen).toEqual([{
      url: 'https://example.com/article?q=roots',
      kind: 'web',
    }])
    expect(element.status).toBe('idle')
  })

  it('clips pages as web pages, and refuses videos until YouTube is offered', async () => {
    const element = await mount()
    await open(element)
    const details: MnQuickClipRequestDetail[] = []
    element.addEventListener('mn-quick-clip-request', event => {
      details.push((event as CustomEvent<MnQuickClipRequestDetail>).detail)
    })
    expect(element.shadowRoot!.querySelector('.disclosure')?.textContent).toContain('article or page')
    expect(element.shadowRoot!.querySelector('.disclosure')?.textContent).not.toContain('YouTube')
    await enterUrl(element, 'https://youtu.be/abc123')
    element.shadowRoot!.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain("Videos can't be clipped yet")
    await enterUrl(element, 'https://example.com/essay')
    element.shadowRoot!.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await enterUrl(element, 'https://youtu.be/abc123')
    element.youtube = true
    await element.updateComplete
    element.shadowRoot!.querySelector<HTMLFormElement>('form')!.requestSubmit()
    expect(details).toEqual([
      { url: 'https://example.com/essay', kind: 'web' },
      { url: 'https://youtu.be/abc123', kind: 'youtube' },
    ])
  })

  it('enables Clip only for an http(s) link', async () => {
    const element = await mount()
    await open(element)
    const submit = () => element.shadowRoot!.querySelector<HTMLButtonElement>('.submit')!
    expect(submit().disabled).toBe(true)
    await enterUrl(element, 'not a link')
    expect(submit().disabled).toBe(true)
    await enterUrl(element, 'ftp://example.com/file')
    expect(submit().disabled).toBe(true)
    await enterUrl(element, 'https://example.com/essay')
    expect(submit().disabled).toBe(false)
  })

  it('shows exactly one state at a time, with the host\'s caveat under Clipped', async () => {
    const element = await mount()
    await open(element)
    let reset = 0
    element.addEventListener('mn-quick-clip-reset', () => { reset += 1 })
    const root = element.shadowRoot!
    const shown = () => ['.status.processing', '.status.complete', '.notice', '[role="alert"]']
      .filter(selector => !root.querySelector<HTMLElement>(selector)!.hidden)
    // The stylesheet must let [hidden] win over the rows' own display.
    const styles = (element.constructor as unknown as { elementStyles: { cssText: string }[] }).elementStyles
      .map(sheet => sheet.cssText).join('\n')
    expect(styles).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
    expect(shown()).toEqual([])

    element.status = 'processing'
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('.status.processing')?.textContent).toContain('Clipping')
    expect(element.shadowRoot!.querySelector<HTMLFormElement>('form')!.hidden).toBe(true)

    expect(shown()).toEqual(['.status.processing'])

    element.status = 'complete'
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('.status.complete')?.textContent).toContain('Clipped')
    expect(shown()).toEqual(['.status.complete'])
    element.notice = 'Clipped, but only a little text came through.'
    await element.updateComplete
    expect(shown()).toEqual(['.status.complete', '.notice'])
    element.shadowRoot!.querySelector<HTMLButtonElement>('.another')!.click()
    await element.updateComplete
    expect(reset).toBe(1)
  })

  it('surfaces host errors and closes on an outside pointer interaction', async () => {
    const element = await mount()
    await open(element)
    element.status = 'error'
    element.error = 'The cell could not extract that page.'
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('[role="alert"]')?.textContent).toContain('could not extract')

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    await element.updateComplete
    expect(element.shadowRoot!.querySelector<HTMLElement>('[role="dialog"]')!.hidden).toBe(true)
  })

  it('removes its document listener when disconnected', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const element = await mount()
    expect(add).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    element.remove()
    expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function))
  })
})
