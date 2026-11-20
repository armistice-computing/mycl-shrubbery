import { afterEach, describe, expect, it } from 'vitest'
import { createKernelEditor } from '../index'
import { inlineMarkdownToHtml, looksLikeMarkdown, markdownToHtml, stripForeignStyles } from '../extensions/markdown-paste'

const mounted: Array<ReturnType<typeof createKernelEditor>> = []
afterEach(() => {
  for (const editor of mounted.splice(0)) editor.destroy()
  document.body.innerHTML = ''
})

describe('markdown paste', () => {
  it('reads Markdown, and leaves ordinary prose alone', () => {
    expect(looksLikeMarkdown('## Plan\n\n- one\n- two')).toBe(true)
    expect(looksLikeMarkdown('1. first\n2. second')).toBe(true)
    expect(looksLikeMarkdown('```\ncode\n```')).toBe(true)
    expect(looksLikeMarkdown('A plain sentence, nothing more.')).toBe(false)
    expect(looksLikeMarkdown('Price is 5 * 3 = 15')).toBe(false)
  })

  it('converts inline marks, keeps code literal, and drops unsafe links', () => {
    expect(inlineMarkdownToHtml('**bold** and *it* and `a<b>`')).toBe('<strong>bold</strong> and <em>it</em> and <code>a&lt;b&gt;</code>')
    expect(inlineMarkdownToHtml('[site](https://x.org)')).toBe('<a href="https://x.org">site</a>')
    expect(inlineMarkdownToHtml('[bad](javascript:alert(1))')).not.toContain('<a')
  })

  it('converts blocks into the shapes the editor reads', () => {
    const html = markdownToHtml('# Title\n\npara one\nline two\n\n- a\n  - b\n- [x] done\n1. first\n\n> quoted\n\n```ts\nconst x = 1\n```')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<p>para one<br>line two</p>')
    expect(html).toContain('<li data-list-type="bullet"><p>a</p></li>')
    expect(html).toContain('<li data-list-type="bullet" data-indent="1"><p>b</p></li>')
    expect(html).toContain('<li data-list-type="task" data-checked="true"><p>done</p></li>')
    expect(html).toContain('<li data-list-type="ordered"><p>first</p></li>')
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<pre><code class="language-ts">const x = 1</code></pre>')
  })

  it('strips foreign fonts and colours, but not the editor\'s own copy', () => {
    expect(stripForeignStyles('<p style="color:red"><font face="Comic">hi</font></p>')).toBe('<p>hi</p>')
    const own = '<p data-pm-slice="1 1 []" style="font-family: Piazzolla">hi</p>'
    expect(stripForeignStyles(own)).toBe(own)
  })

  it('a Markdown paste in the editor becomes a heading and list items', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = createKernelEditor(element, {})
    mounted.push(editor)
    editor.commands.setContent('<p></p>')
    editor.commands.focus('end')
    const data = new DataTransfer()
    data.setData('text/plain', '## Plan\n\n- one\n- two')
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(event, 'clipboardData', { value: data })
    const handled = editor.view.someProp('handlePaste', (fn) => fn(editor.view, event, null as never))
    expect(handled).toBe(true)
    const json = JSON.stringify(editor.getJSON())
    expect(json).toContain('"type":"heading"')
    expect(json).toContain('"listType":"bullet"')
    expect(editor.getText()).not.toContain('##')
    expect(editor.getText()).not.toContain('- one')
  })
})
