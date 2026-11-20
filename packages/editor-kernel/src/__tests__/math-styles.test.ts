import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { kernelExtensions } from '../index'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy() })

const hasMathRules = (sheets: readonly CSSStyleSheet[]): boolean =>
  sheets.some(sheet => Array.from(sheet.cssRules).some(rule => rule.cssText.includes('.math-node')))

describe('math styles', () => {
  it('reach the shadow root the editor lives in, where a sheet on the document never would', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const element = document.createElement('div')
    shadow.appendChild(element)
    const editor = new Editor({ element, extensions: kernelExtensions({}) })
    editors.push(editor)
    editor.commands.setContent('<p>x <span data-math-inline="a^2"></span></p>')
    expect(shadow.querySelector('.math-node')).not.toBeNull()
    expect(hasMathRules(shadow.adoptedStyleSheets)).toBe(true)
  })

  it('show the raw source when the host supplies no renderer', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = new Editor({ element, extensions: kernelExtensions({}) })
    editors.push(editor)
    editor.commands.setContent('<p>x <span data-math-inline="a^2"></span></p>')
    expect(element.querySelector('.math-rendered')?.textContent).toBe('a^2')
  })
})
