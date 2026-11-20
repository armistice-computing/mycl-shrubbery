import { beforeAll, describe, expect, it } from 'vitest'
import '../mn-pdf-annotation-view.js'
import type { MnPdfAnnotation, MnPdfAnnotationSelectDetail } from '../mn-pdf-reader.js'
import type {
  MnPdfAnnotationOpenOriginalDetail,
  MnPdfAnnotationView,
} from '../mn-pdf-annotation-view.js'

const ANNOTATIONS: MnPdfAnnotation[] = [
  { id: 'ann-2', pageNumber: 2, quote: 'second page', note: 'agent note\n\nsecond note', label: 'Agent', kind: 'note', source: 'reader', rects: [] },
  { id: 'ann-1', pageNumber: 1, quote: 'first page', label: 'Reviewer', kind: 'highlight', source: 'embedded', rects: [] },
  { id: 'ann-3', pageNumber: 1, quote: '', note: 'sticky note', kind: 'note', source: 'embedded', rects: [] },
]

async function mount(setup?: (el: MnPdfAnnotationView) => void): Promise<MnPdfAnnotationView> {
  const el = document.createElement('mn-pdf-annotation-view') as MnPdfAnnotationView
  setup?.(el)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('mn-pdf-annotation-view', () => {
  beforeAll(() => {
    expect(customElements.get('mn-pdf-annotation-view')).toBeDefined()
  })

  it('renders the empty state without inventing a companion write', async () => {
    const el = await mount()
    const empty = el.shadowRoot!.querySelector('mn-empty-state')!
    expect(empty.getAttribute('title')).toBe('No annotations yet')
    expect(empty.getAttribute('description')).toContain('Select text in Original')
  })

  it('groups annotations by page and renders quote, note, kind, and source', async () => {
    const el = await mount(node => {
      node.annotations = ANNOTATIONS
    })
    const headings = Array.from(el.shadowRoot!.querySelectorAll('.page-heading')).map(node => node.textContent?.replace(/\s+/g, ' ').trim())
    expect(headings).toEqual(['Page 1 · 2 annotations', 'Page 2 · 1 annotation'])
    const text = el.shadowRoot!.textContent!
    expect(text).toContain('first page')
    expect(text).toContain('second page')
    expect(text).toContain('agent note')
    expect(text).toContain('second note')
    expect(el.shadowRoot!.querySelectorAll('.annotation-note')).toHaveLength(3)
    expect(text).toContain('Imported')
    expect(text).toContain('Mycl')
    expect(text).toContain('No text recovered')
  })

  it('emits select and open-original intents separately', async () => {
    const el = await mount(node => {
      node.annotations = ANNOTATIONS
      node.activeAnnotationId = 'ann-1'
    })
    const selected: MnPdfAnnotationSelectDetail[] = []
    const opened: MnPdfAnnotationOpenOriginalDetail[] = []
    el.addEventListener('mn-pdf-annotation-select', event => {
      selected.push((event as CustomEvent<MnPdfAnnotationSelectDetail>).detail)
    })
    el.addEventListener('mn-pdf-annotation-open-original', event => {
      opened.push((event as CustomEvent<MnPdfAnnotationOpenOriginalDetail>).detail)
    })
    const item = el.shadowRoot!.querySelector('.annotation-item[data-active="true"]')!
    expect(item).not.toBeNull()
    ;(item.querySelector('.annotation-main') as HTMLButtonElement).click()
    expect(selected).toHaveLength(1)
    expect(selected[0]?.annotationId).toBe('ann-1')
    expect(opened).toHaveLength(0)

    ;(item.querySelector('.annotation-open') as HTMLButtonElement).click()
    expect(opened).toHaveLength(1)
    expect(opened[0]?.annotationId).toBe('ann-1')
    expect(selected).toHaveLength(1)
  })
})
