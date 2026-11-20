import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { kernelExtensions, type MathRenderer } from '../index'

const editors: Editor[] = []
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy() })

/** An async renderer whose renders finish only when the test says so. */
function controllableRenderer() {
  const pending: Array<{ src: string; finish: () => void; fail: () => void }> = []
  const renderMath: MathRenderer = (target, request, isCurrent) =>
    new Promise<void>((resolve, reject) => {
      pending.push({
        src: request.src,
        finish: () => {
          if (isCurrent()) target.textContent = `rendered:${request.src}`
          resolve()
        },
        fail: () => reject(new Error('bad LaTeX')),
      })
    })
  return { renderMath, pending }
}

function mount(renderMath: MathRenderer): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: kernelExtensions({ renderMath }) })
  editors.push(editor)
  editor.commands.setContent('<p>x <span data-math-inline="OLD"></span></p>')
  return editor
}

const mathPos = (editor: Editor): number => {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'mathInline') found = pos
  })
  return found
}

const setSrc = (editor: Editor, src: string): void => {
  editor.view.dispatch(editor.state.tr.setNodeMarkup(mathPos(editor), null, { src }))
}

const rendered = (editor: Editor): Element | null => editor.view.dom.querySelector('.math-rendered')

describe('math renders, when they finish out of order', () => {
  it('lets only the newest render write: a stale one finishing last changes nothing', async () => {
    const { renderMath, pending } = controllableRenderer()
    const editor = mount(renderMath)
    setSrc(editor, 'NEW')
    const oldRender = pending.find(p => p.src === 'OLD')!
    const newRender = pending.find(p => p.src === 'NEW')!
    newRender.finish()
    oldRender.finish()
    await Promise.resolve()
    expect(rendered(editor)?.textContent).toBe('rendered:NEW')
  })

  it('a stale render that fails does not mark the newer one as an error', async () => {
    const { renderMath, pending } = controllableRenderer()
    const editor = mount(renderMath)
    setSrc(editor, 'NEW')
    pending.find(p => p.src === 'NEW')!.finish()
    pending.find(p => p.src === 'OLD')!.fail()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(rendered(editor)?.textContent).toBe('rendered:NEW')
    expect(editor.view.dom.querySelector('[data-math-error]')).toBeNull()
  })

  it('a failing current render shows the source in the error style', async () => {
    const { renderMath, pending } = controllableRenderer()
    const editor = mount(renderMath)
    pending.find(p => p.src === 'OLD')!.fail()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(rendered(editor)?.textContent).toBe('OLD')
    expect(editor.view.dom.querySelector('[data-math-error]')).not.toBeNull()
  })

  it('never hands an empty formula to the host renderer', () => {
    const { renderMath, pending } = controllableRenderer()
    const editor = mount(renderMath)
    setSrc(editor, '')
    expect(pending.map(p => p.src)).toEqual(['OLD'])
    expect(rendered(editor)?.textContent).toBe('math')
  })
})
