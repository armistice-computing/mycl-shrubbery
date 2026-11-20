import { afterEach, describe, expect, it } from 'vitest'
import { createKernelEditor } from '../index'
import { openableHref, opensLink } from '../extensions/external-links'

const mounted: Array<ReturnType<typeof createKernelEditor>> = []
afterEach(() => {
  for (const editor of mounted.splice(0)) editor.destroy()
  document.body.innerHTML = ''
})

describe('external links', () => {
  it('opens web and mail links only', () => {
    const a = document.createElement('a')
    a.setAttribute('href', 'https://example.com/x')
    const span = document.createElement('span')
    a.appendChild(span)
    expect(openableHref(span)).toBe('https://example.com/x')
    a.setAttribute('href', 'mailto:me@example.com')
    expect(openableHref(a)).toBe('mailto:me@example.com')
    a.setAttribute('href', 'javascript:alert(1)')
    expect(openableHref(a)).toBeNull()
    a.setAttribute('href', 'file:///etc/hosts')
    expect(openableHref(a)).toBeNull()
  })

  it('Command-click opens; a plain click opens only in a read-only document', () => {
    expect(opensLink({ metaKey: true, ctrlKey: false, button: 0 }, true)).toBe(true)
    expect(opensLink({ metaKey: false, ctrlKey: false, button: 0 }, true)).toBe(false)
    expect(opensLink({ metaKey: false, ctrlKey: false, button: 0 }, false)).toBe(true)
    expect(opensLink({ metaKey: true, ctrlKey: false, button: 2 }, true)).toBe(false)
  })

  it('a Command-click on a link in the editor hands its href to the host', () => {
    const opened: string[] = []
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = createKernelEditor(element, { onExternalLinkOpen: (href) => opened.push(href) })
    mounted.push(editor)
    editor.commands.setContent('<p>see <a href="https://example.com/page">the page</a></p>')
    const link = element.querySelector('a[href]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    // handleClick reads event.target, so give the synthetic click the link as its target.
    const event = new MouseEvent('click', { metaKey: true, button: 0, bubbles: true, cancelable: true })
    Object.defineProperty(event, 'target', { value: link })
    const handled = editor.view.someProp('handleClick', (fn) => fn(editor.view, 6, event))
    expect(handled).toBe(true)
    expect(opened).toEqual(['https://example.com/page'])
  })
})
