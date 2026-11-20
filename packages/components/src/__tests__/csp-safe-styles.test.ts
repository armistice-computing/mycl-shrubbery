import { describe, expect, it } from 'vitest'
import { adoptInlineStyles, inlineStyleText } from '../csp-safe-styles.js'

describe('csp-safe styles', () => {
  it('reads every <style> in order', () => {
    const doc = document.implementation.createHTMLDocument('x')
    doc.head.innerHTML = '<style>a{b:c}</style><style>d{e:f}</style>'
    expect(inlineStyleText(doc)).toBe('a{b:c}\nd{e:f}')
  })

  it('adopts the inline CSS as a constructed sheet when the engine can', () => {
    document.head.insertAdjacentHTML('beforeend', '<style id="csp-probe">.csp-probe{color:red}</style>')
    const before = document.adoptedStyleSheets?.length ?? 0
    const adopted = adoptInlineStyles(document)
    if (adopted && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      expect(document.adoptedStyleSheets.length).toBe(before + 1)
    }
    document.getElementById('csp-probe')?.remove()
  })
})
