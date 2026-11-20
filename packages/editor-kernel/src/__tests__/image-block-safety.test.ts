import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import {
  classifyImageSrc,
  kernelExtensions,
  myclArtifactSrc,
  parseMyclArtifactSrc,
  parseUploadedImageSrc,
  MAX_DATA_IMAGE_SRC_LENGTH,
  type ImageResolver,
  type KernelOptions,
} from '../index'

const editors: Editor[] = []
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.innerHTML = ''
})

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const ART = 'mycl-artifact://my-graph/artifact-be40'

function mount(src: string, opts: KernelOptions = {}) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: kernelExtensions(opts) })
  editors.push(editor)
  editor.commands.setContent({
    type: 'doc',
    content: [{ type: 'image', attrs: { src, alt: 'A heron' } }],
  })
  return editor
}

const wrapper = (editor: Editor) => editor.view.dom.querySelector('.image-block') as HTMLElement
const img = (editor: Editor) => wrapper(editor).querySelector('img')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function setSrc(editor: Editor, src: string) {
  let pos = -1
  editor.state.doc.descendants((node, p) => { if (node.type.name === 'image') pos = p })
  editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'src', src))
}

describe('parseMyclArtifactSrc', () => {
  it('accepts exactly two encoded id segments', () => {
    expect(parseMyclArtifactSrc('mycl-artifact://g1/a-1')).toEqual({ graphId: 'g1', artifactId: 'a-1' })
    expect(parseMyclArtifactSrc('mycl-artifact://default_x1/artifact.be40')).toEqual({ graphId: 'default_x1', artifactId: 'artifact.be40' })
    expect(parseMyclArtifactSrc('mycl-artifact://g1/a%2D1')).toEqual({ graphId: 'g1', artifactId: 'a-1' })
    expect(myclArtifactSrc({ graphId: 'g1', artifactId: 'a-1' })).toBe('mycl-artifact://g1/a-1')
  })

  it.each([
    'mycl-artifact://g1',
    'mycl-artifact://g1/',
    'mycl-artifact:///a1',
    'mycl-artifact://g1/a1/extra',
    'mycl-artifact://g1/a1?token=x',
    'mycl-artifact://g1/a1#frag',
    'mycl-artifact://g1/..',
    'mycl-artifact://g1/a%2F1',
    'mycl-artifact://g1/a%ZZ',
    'mycl-artifact://g 1/a1',
    'mycl-artifact://-g/a1',
    'mycl-artifact://g1/a1\\x',
    'MYCL-ARTIFACT://g1/a1',
    'http://g1/a1',
  ])('rejects %s', src => {
    expect(parseMyclArtifactSrc(src)).toBeNull()
  })

  it('rejects an id over 128 characters', () => {
    expect(parseMyclArtifactSrc(`mycl-artifact://g/${'a'.repeat(129)}`)).toBeNull()
  })
})

describe('parseUploadedImageSrc', () => {
  it('keeps only the graph and image ids', () => {
    expect(parseUploadedImageSrc('http://127.0.0.1:61234/artifacts/g1/images/b7ec-1?token=x&exp=1&fn=a.png')).toEqual({ graphId: 'g1', imageId: 'b7ec-1' })
    expect(parseUploadedImageSrc('/artifacts/g1/images/b7ec-1')).toEqual({ graphId: 'g1', imageId: 'b7ec-1' })
    expect(parseUploadedImageSrc('http://localhost:5203/cell/artifacts/g1/images/b7ec-1#x')).toEqual({ graphId: 'g1', imageId: 'b7ec-1' })
  })

  it.each([
    '/artifacts/g1/images/',
    '/artifacts/g1/images/a/b',
    '/artifacts/g1/a1/download',
    '/x/y/artifacts/g1/images/a',
    '//evil/artifacts/g1/images/a',
    'file:///artifacts/g1/images/a',
    'javascript:/artifacts/g1/images/a',
    '/artifacts/g%2F1/images/a',
    '/artifacts/../images/a',
    '/artifacts/g1/images/a b',
  ])('rejects %s', src => {
    expect(parseUploadedImageSrc(src)).toBeNull()
  })
})

describe('classifyImageSrc', () => {
  it('sorts srcs into artifact, direct and blocked', () => {
    expect(classifyImageSrc(ART)).toEqual({ kind: 'resolve', ref: { source: 'artifact', graphId: 'my-graph', id: 'artifact-be40' } })
    expect(classifyImageSrc('http://127.0.0.1:9999/artifacts/g/images/i?token=old')).toEqual({ kind: 'resolve', ref: { source: 'upload', graphId: 'g', id: 'i' } })
    expect(classifyImageSrc('/cell/artifacts/g/images/i')).toEqual({ kind: 'resolve', ref: { source: 'upload', graphId: 'g', id: 'i' } })
    expect(classifyImageSrc(PNG).kind).toBe('direct')
    expect(classifyImageSrc('data:image/webp;base64,UklGR').kind).toBe('direct')
    expect(classifyImageSrc('blob:http://localhost/abc').kind).toBe('direct')
    expect(classifyImageSrc('https://example.com/x.png')).toEqual({ kind: 'blocked', reason: 'web' })
    expect(classifyImageSrc('//example.com/x.png')).toEqual({ kind: 'blocked', reason: 'web' })
    expect(classifyImageSrc('http://127.0.0.1:9999/artifacts/g/images/i/x')).toEqual({ kind: 'blocked', reason: 'web' })
    expect(classifyImageSrc('https://host/a/b/artifacts/g/images/i')).toEqual({ kind: 'blocked', reason: 'web' })
    expect(classifyImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toEqual({ kind: 'blocked', reason: 'unsupported' })
    expect(classifyImageSrc('data:text/html,<b>x</b>')).toEqual({ kind: 'blocked', reason: 'unsupported' })
    expect(classifyImageSrc('file:///etc/x.png')).toEqual({ kind: 'blocked', reason: 'unsupported' })
    expect(classifyImageSrc('attachments/x.png')).toEqual({ kind: 'blocked', reason: 'unsupported' })
    expect(classifyImageSrc('mycl-artifact://g/a?x=1')).toEqual({ kind: 'blocked', reason: 'unsupported' })
    expect(classifyImageSrc('mycl-unresolved-image:https%3A%2F%2Fexample.com%2Fx.png')).toEqual({ kind: 'blocked', reason: 'not-imported' })
  })
})

describe('image node view', () => {
  it('renders a raster data: image directly and keeps the stored src', () => {
    const editor = mount(PNG)
    expect(img(editor)?.getAttribute('src')).toBe(PNG)
    expect(wrapper(editor).getAttribute('data-image-state')).toBe('shown')
    expect(editor.getJSON().content?.[0]?.attrs?.src).toBe(PNG)
  })

  it('never puts a web src into an img and shows a placeholder with the alt', () => {
    const resolveImage = vi.fn<ImageResolver>()
    const editor = mount('https://example.com/heron.png', { resolveImage })
    expect(img(editor)).toBeNull()
    expect(wrapper(editor).getAttribute('data-image-state')).toBe('blocked-web')
    expect(wrapper(editor).textContent).toContain('A heron')
    expect(wrapper(editor).textContent).toContain('from the web')
    expect(resolveImage).not.toHaveBeenCalled()
    // The persisted src and the serialized HTML are unchanged.
    expect(editor.getJSON().content?.[0]?.attrs?.src).toBe('https://example.com/heron.png')
    expect(editor.getHTML()).toContain('src="https://example.com/heron.png"')
  })

  it('refuses an SVG data URL and an oversize data URL', () => {
    const svg = mount('data:image/svg+xml;base64,PHN2Zz4=')
    expect(img(svg)).toBeNull()
    expect(wrapper(svg).getAttribute('data-image-state')).toBe('unsupported')
    const big = mount(`data:image/png;base64,${'A'.repeat(MAX_DATA_IMAGE_SRC_LENGTH)}`)
    expect(img(big)).toBeNull()
  })

  it('never puts an uploaded-image URL into an img; it goes to the resolver as stored', async () => {
    const upload = 'http://127.0.0.1:4100/artifacts/g/images/i1?token=t&exp=1&fn=x.png'
    expect(img(mount(upload))).toBeNull()
    const resolveImage = vi.fn<ImageResolver>(async () => ({ url: 'blob:upload', revoke: () => undefined }))
    const editor = mount(upload, { resolveImage })
    expect(resolveImage).toHaveBeenCalledWith(upload)
    expect(img(editor)).toBeNull()
    await flush()
    expect(img(editor)?.getAttribute('src')).toBe('blob:upload')
    expect(editor.getJSON().content?.[0]?.attrs?.src).toBe(upload)
  })

  it('resolves a mycl-artifact src through the host and revokes on destroy', async () => {
    const revoke = vi.fn()
    const resolveImage = vi.fn<ImageResolver>(async () => ({ url: 'blob:resolved-1', revoke }))
    const editor = mount(ART, { resolveImage })
    expect(resolveImage).toHaveBeenCalledWith(ART)
    await flush()
    expect(img(editor)?.getAttribute('src')).toBe('blob:resolved-1')
    expect(editor.getJSON().content?.[0]?.attrs?.src).toBe(ART)
    editors.splice(editors.indexOf(editor), 1)
    editor.destroy()
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it('revokes the old object URL when the src changes', async () => {
    const revokes: string[] = []
    let n = 0
    const resolveImage: ImageResolver = async () => {
      const url = `blob:r${++n}`
      return { url, revoke: () => revokes.push(url) }
    }
    const editor = mount(ART, { resolveImage })
    await flush()
    setSrc(editor, 'mycl-artifact://my-graph/artifact-other')
    expect(revokes).toEqual(['blob:r1'])
    await flush()
    expect(img(editor)?.getAttribute('src')).toBe('blob:r2')
  })

  it('revokes a resolve that lands after the editor is gone', async () => {
    let finish!: (value: { url: string; revoke(): void }) => void
    const revoke = vi.fn()
    const resolveImage: ImageResolver = () => new Promise(resolve => { finish = resolve })
    const editor = mount(ART, { resolveImage })
    editors.splice(editors.indexOf(editor), 1)
    editor.destroy()
    finish({ url: 'blob:late', revoke })
    await flush()
    expect(revoke).toHaveBeenCalledTimes(1)
  })

  it('revokes a stale resolve when the src changed before it landed', async () => {
    const finishes: Array<(value: { url: string; revoke(): void }) => void> = []
    const revoked: string[] = []
    const resolveImage: ImageResolver = () => new Promise(resolve => { finishes.push(resolve) })
    const editor = mount(ART, { resolveImage })
    setSrc(editor, 'mycl-artifact://my-graph/artifact-other')
    finishes[0]!({ url: 'blob:old', revoke: () => revoked.push('blob:old') })
    finishes[1]!({ url: 'blob:new', revoke: () => revoked.push('blob:new') })
    await flush()
    expect(revoked).toEqual(['blob:old'])
    expect(img(editor)?.getAttribute('src')).toBe('blob:new')
  })

  it('shows the resolver refusal as the placeholder reason', async () => {
    const resolveImage: ImageResolver = async () => { throw new Error('Not an image Mycl can show.') }
    const editor = mount(ART, { resolveImage })
    await flush()
    expect(img(editor)).toBeNull()
    expect(wrapper(editor).getAttribute('data-image-state')).toBe('failed')
    expect(wrapper(editor).textContent).toContain('Not an image Mycl can show.')
  })

  it('an image the import left out is a placeholder and never asks the resolver', () => {
    const resolveImage = vi.fn<ImageResolver>()
    const editor = mount('mycl-unresolved-image:attachments%2Fx.png', { resolveImage })
    expect(img(editor)).toBeNull()
    expect(wrapper(editor).getAttribute('data-image-state')).toBe('not-imported')
    expect(wrapper(editor).textContent).toContain('Image not displayed. The original reference is kept.')
    expect(resolveImage).not.toHaveBeenCalled()
  })

  it('without a resolver, a mycl-artifact image is a placeholder', () => {
    const editor = mount(ART)
    expect(img(editor)).toBeNull()
    expect(wrapper(editor).getAttribute('data-image-state')).toBe('unresolved')
  })
})
