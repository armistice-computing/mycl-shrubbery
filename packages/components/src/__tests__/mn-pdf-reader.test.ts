/**
 * REAL component test — mn-pdf-reader controlled PDF surface (Phase 2 slice 1).
 *
 * The element renders caller-owned page + annotation models and emits composed
 * intents. It does not fetch bytes, run a PDF engine, or create annotations by
 * itself. No mocks of the component: the only stubs are browser APIs happy-dom
 * does not implement (IntersectionObserver is a happy-dom no-op stub, so a
 * recording fake is installed; geometry math itself is tested through the
 * component's exported pure helpers).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import '../mn-pdf-reader.js'
import {
  clampZoom,
  clientRectsToPageQuads,
  fitWidthScale,
  pageNumberAtScroll,
  pageScrollTop,
  type MnPdfAnnotation,
  type MnPdfAnnotationSelectDetail,
  type MnPdfAnnotateDetail,
  type MnPdfFileIntentDetail,
  type MnPdfPage,
  type MnPdfPageChangeDetail,
  type MnPdfPageVisibleDetail,
  type MnPdfReader,
  type MnPdfSelectionDetail,
  type MnPdfZoomChangeDetail,
} from '../mn-pdf-reader.js'

async function mount(setup?: (el: MnPdfReader) => void): Promise<MnPdfReader> {
  const el = document.createElement('mn-pdf-reader') as MnPdfReader
  setup?.(el)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

const sr = (el: MnPdfReader) => el.shadowRoot!

const PAGE_A: MnPdfPage = {
  pageNumber: 1,
  width: 612,
  height: 792,
  imageUrl: 'data:image/png;base64,page-a',
  textItems: [
    { id: 't1', text: 'hello world', x: 10, y: 10, width: 80, height: 12 },
    { id: 't2', text: 'second line', x: 10, y: 30, width: 80, height: 12 },
  ],
}
const PAGE_B: MnPdfPage = { pageNumber: 2, width: 612, height: 792, textItems: [] }
const PAGE_C: MnPdfPage = { pageNumber: 3, width: 612, height: 396, textItems: [] }

function ready(el: MnPdfReader, extra?: (node: MnPdfReader) => void): void {
  el.status = 'ready'
  el.title = 'Paper'
  el.filename = 'paper.pdf'
  el.mimeType = 'application/pdf'
  el.pages = [PAGE_A, PAGE_B]
  extra?.(el)
}

/** A recording IntersectionObserver fake (happy-dom's own is a no-op stub). */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  readonly callback: IntersectionObserverCallback
  readonly observed: Element[] = []
  disconnected = false
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeIntersectionObserver.instances.push(this)
  }
  observe(target: Element): void {
    this.observed.push(target)
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeIntersectionObserver.instances = []
  document.getSelection()?.removeAllRanges()
  document.querySelectorAll('.pdf-light-selection-root').forEach(root => { root.remove() })
})

function fireVisible(target: Element): void {
  const observer = FakeIntersectionObserver.instances[0]
  expect(observer).toBeDefined()
  observer.callback(
    [{ isIntersecting: true, target } as IntersectionObserverEntry],
    observer as unknown as IntersectionObserver,
  )
}

/** Select `from`..`to` of the first text item's text node on page 1. */
function selectText(el: MnPdfReader, from: number, to: number): void {
  const span = sr(el).querySelector('.pdf-text-layer span')!
  // Lit wraps bindings in marker comments; find the real Text node.
  const text = Array.from(span.childNodes).find((node) => node.nodeType === 3) as Text
  const range = document.createRange()
  range.setStart(text, from)
  range.setEnd(text, to)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function mouseUp(el: MnPdfReader): void {
  sr(el).querySelector('.pdf-scroll')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
}

describe('mn-pdf-reader — real custom element', () => {
  beforeAll(() => {
    expect(customElements.get('mn-pdf-reader')).toBeDefined()
  })

  describe('status + placeholder rendering', () => {
    it('renders loading and error states from the controlled status prop', async () => {
      const el = await mount((node) => {
        node.status = 'loading'
      })
      expect(sr(el).querySelector('mn-loading')).not.toBeNull()

      el.status = 'error'
      el.error = 'bytes missing'
      await el.updateComplete
      const empty = sr(el).querySelector('mn-empty-state')!
      expect(empty.getAttribute('title')).toBe('PDF failed to load')
      expect(empty.getAttribute('description')).toBe('bytes missing')
      expect(empty.getAttribute('mood')).toBe('danger')
    })

    it('shows annotation failures without hiding a ready PDF', async () => {
      const el = await mount((node) => ready(node, current => {
        current.annotationError = 'companion unavailable'
      }))
      expect(sr(el).querySelector('.annotation-error')?.textContent).toBe('companion unavailable')
      expect(sr(el).querySelectorAll('.pdf-page')).toHaveLength(2)
    })

    it('renders an aspect-correct box per page immediately, image only when provided', async () => {
      const el = await mount((node) => ready(node))
      const pages = sr(el).querySelectorAll('.pdf-page')
      expect(pages).toHaveLength(2)

      // Every page box is sized from page-space dims × zoom, image or not.
      for (const page of pages) {
        expect((page as HTMLElement).style.width).toBe('612px')
        expect((page as HTMLElement).style.height).toBe('792px')
      }
      // Page 1 has a shell-rendered image; page 2 shows the placeholder.
      expect(sr(el).querySelector('.pdf-image')?.getAttribute('src')).toBe('data:image/png;base64,page-a')
      expect(sr(el).querySelector('.pdf-placeholder')?.textContent).toContain('Page 2')
      // Zoom scales the boxes.
      el.zoom = 2
      await el.updateComplete
      expect((sr(el).querySelector('.pdf-page') as HTMLElement).style.width).toBe('1224px')
    })

    it('renders a transparent text layer with positioned spans', async () => {
      const el = await mount((node) => ready(node))
      const layer = sr(el).querySelector('.pdf-text-layer')!
      expect(layer.getAttribute('aria-hidden')).toBe('true')
      const spans = layer.querySelectorAll('span')
      expect(spans).toHaveLength(2)
      expect((spans[0] as HTMLElement).style.left).toBe('10px')
      expect((spans[0] as HTMLElement).style.top).toBe('10px')
      expect((spans[0] as HTMLElement).style.fontSize).toBe('12px')
      expect(spans[0].textContent).toBe('hello world')
    })
  })

  describe('pure geometry helpers', () => {
    it('converts client rects to page-space quads at scale, dropping zero-area rects', () => {
      const pageBox = { left: 100, top: 20, width: 1224, height: 1584 }
      const quads = clientRectsToPageQuads(
        [
          { left: 120, top: 60, width: 40, height: 10 },
          { left: 0, top: 0, width: 0, height: 12 }, // collapsed caret artifact
        ],
        pageBox,
        2,
      )
      expect(quads).toEqual([[10, 20, 20, 5]])
    })

    it('computes the current page from scroll position without DOM measurement', () => {
      const pages = [PAGE_A, PAGE_B, PAGE_C]
      expect(pageNumberAtScroll(pages, 1, 0, 0)).toBe(1)
      expect(pageNumberAtScroll(pages, 1, 900, 0)).toBe(2)
      expect(pageNumberAtScroll(pages, 1, 24 + 792 + 18 + 792 + 18, 0)).toBe(3)
      expect(pageNumberAtScroll(pages, 2, 900, 0)).toBe(1) // scaled pages are taller
      expect(pageNumberAtScroll([], 1, 0, 0)).toBeNull()
    })

    it('computes the scroll offset that tops a page', () => {
      expect(pageScrollTop([PAGE_A, PAGE_B], 1, 2)).toBe(24 + 792 + 18)
      expect(pageScrollTop([PAGE_A, PAGE_B], 1, 99)).toBe(0)
    })

    it('computes fit-width scale and refuses when the viewport is unmeasurable', () => {
      expect(fitWidthScale(612, 1000)).toBe(1.575) // (1000 - 36) / 612
      expect(fitWidthScale(612, 0)).toBeNull()
      expect(fitWidthScale(0, 1000)).toBeNull()
      expect(clampZoom(10)).toBe(5)
      expect(clampZoom(0.1)).toBe(0.25)
      expect(clampZoom(Number.NaN)).toBe(1)
    })
  })

  describe('lazy page visibility intent', () => {
    it('emits mn-pdf-page-visible for observed pages entering the viewport', async () => {
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
      const el = await mount((node) => {
        node.pages = [PAGE_A, PAGE_B, PAGE_C]
        node.status = 'ready'
      })
      const observer = FakeIntersectionObserver.instances[0]
      expect(observer.observed).toHaveLength(3)

      const visible: MnPdfPageVisibleDetail[] = []
      el.addEventListener('mn-pdf-page-visible', (event) => {
        visible.push((event as CustomEvent<MnPdfPageVisibleDetail>).detail)
      })

      const pageEls = sr(el).querySelectorAll('.pdf-page')
      fireVisible(pageEls[2])
      fireVisible(pageEls[0])
      expect(visible).toEqual([{ pageNumber: 3 }, { pageNumber: 1 }])
    })
  })

  describe('selection → anchor intent', () => {
    it('emits mn-pdf-selection with exact quote, context and page from a real selection', async () => {
      const el = await mount((node) => ready(node))
      const selections: Array<MnPdfSelectionDetail | null> = []
      el.addEventListener('mn-pdf-selection', (event) => {
        selections.push((event as CustomEvent<MnPdfSelectionDetail | null>).detail)
      })

      selectText(el, 6, 11) // "world" out of "hello world"
      mouseUp(el)

      expect(selections).toHaveLength(1)
      expect(selections[0]).toMatchObject({
        pageNumber: 1,
        exact: 'world',
        prefix: 'hello ',
        suffix: 'second line',
      })
      // happy-dom has no layout engine, so Range.getClientRects() is empty;
      // the quad math itself is covered by the pure-helper tests above.
      expect(selections[0]?.quads).toEqual([])
    })

    it('selects through the light-DOM fallback and removes it with the reader', async () => {
      const el = await mount((node) => ready(node))
      const light = document.querySelector('.pdf-light-selection-root') as HTMLElement
      expect(light).not.toBeNull()
      const span = light.querySelector('.pdf-text-layer span')!
      const text = Array.from(span.childNodes).find(node => node.nodeType === 3) as Text
      const range = document.createRange()
      range.setStart(text, 6)
      range.setEnd(text, 11)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      const selections: Array<MnPdfSelectionDetail | null> = []
      el.addEventListener('mn-pdf-selection', event => {
        selections.push((event as CustomEvent<MnPdfSelectionDetail | null>).detail)
      })

      span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      expect(selections[0]).toMatchObject({ pageNumber: 1, exact: 'world', prefix: 'hello ' })
      el.remove()
      expect(light.isConnected).toBe(false)
    })

    it('uses the light layer when ProseMirror patches shadow selection', async () => {
      const el = await mount((node) => ready(node))
      const prototype = Object.getPrototypeOf(sr(el)) as ShadowRoot & { getSelection?: () => Selection | null }
      const original = Object.getOwnPropertyDescriptor(prototype, 'getSelection')
      const usesLight = () => (el as unknown as { _usesLightDomSelection(): boolean })._usesLightDomSelection()
      try {
        prototype.getSelection = () => document.getSelection()
        expect(usesLight()).toBe(true)
        const native = () => null
        native.toString = () => 'function getSelection() { [native code] }'
        prototype.getSelection = native
        expect(usesLight()).toBe(false)
      } finally {
        if (original) Object.defineProperty(prototype, 'getSelection', original)
        else delete prototype.getSelection
      }
    })

    it('forwards wheel gestures over light text back to the PDF scroller', async () => {
      const el = await mount((node) => ready(node))
      const scroller = sr(el).querySelector('.pdf-scroll') as HTMLElement
      scroller.scrollTop = 24
      const span = document.querySelector('.pdf-light-selection-root .pdf-text-layer span')!
      span.dispatchEvent(new WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }))
      expect(scroller.scrollTop).toBe(624)
    })

    it('clears the selection with a null intent on collapsed/empty selections', async () => {
      const el = await mount((node) => ready(node))
      const selections: Array<MnPdfSelectionDetail | null> = []
      el.addEventListener('mn-pdf-selection', (event) => {
        selections.push((event as CustomEvent<MnPdfSelectionDetail | null>).detail)
      })

      selectText(el, 6, 11)
      mouseUp(el)
      document.getSelection()!.removeAllRanges()
      mouseUp(el)

      expect(selections).toHaveLength(2)
      expect(selections[1]).toBeNull()
    })

    it('ignores selections outside the text layer', async () => {
      const el = await mount((node) => ready(node))
      const selections: Array<MnPdfSelectionDetail | null> = []
      el.addEventListener('mn-pdf-selection', (event) => {
        selections.push((event as CustomEvent<MnPdfSelectionDetail | null>).detail)
      })

      // Select rail-free chrome text: the toolbar title lives in the shadow
      // root but not in a .pdf-text-layer.
      const titleSpan = sr(el).querySelector('.title')!
      const title = Array.from(titleSpan.childNodes).find((node) => node.nodeType === 3) as Text
      const range = document.createRange()
      range.setStart(title, 0)
      range.setEnd(title, 5)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      mouseUp(el)

      expect(selections).toHaveLength(0)
    })
  })

  describe('highlight / note intents (gated)', () => {
    const annotateEvents = (el: MnPdfReader) => {
      const highlights: MnPdfAnnotateDetail[] = []
      const notes: MnPdfAnnotateDetail[] = []
      el.addEventListener('mn-pdf-highlight', (event) => {
        highlights.push((event as CustomEvent<MnPdfAnnotateDetail>).detail)
      })
      el.addEventListener('mn-pdf-note', (event) => {
        notes.push((event as CustomEvent<MnPdfAnnotateDetail>).detail)
      })
      return { highlights, notes }
    }

    const highlightButton = (el: MnPdfReader) =>
      sr(el).querySelector('[aria-label="Highlight selection"]') as HTMLButtonElement
    const noteButton = (el: MnPdfReader) =>
      sr(el).querySelector('[aria-label="Add note to selection"]') as HTMLButtonElement

    it('keeps the annotate buttons disabled without a selection', async () => {
      const el = await mount((node) => ready(node, (n) => { n.canAnnotate = true }))
      const { highlights, notes } = annotateEvents(el)

      expect(highlightButton(el).disabled).toBe(true)
      expect(noteButton(el).disabled).toBe(true)
      highlightButton(el).click()
      noteButton(el).click()
      expect(highlights).toHaveLength(0)
      expect(notes).toHaveLength(0)
    })

    it('hides the annotate buttons when canAnnotate is false, selection or not', async () => {
      const el = await mount((node) => ready(node))
      const { highlights } = annotateEvents(el)

      selectText(el, 6, 11)
      mouseUp(el)
      await el.updateComplete

      expect(sr(el).querySelector('[aria-label="Highlight selection"]')).toBeNull()
      expect(sr(el).querySelector('[aria-label="Add note to selection"]')).toBeNull()
      expect(highlights).toHaveLength(0)
    })

    it('emits mn-pdf-highlight / mn-pdf-note carrying the selection when allowed', async () => {
      const el = await mount((node) => ready(node, (n) => { n.canAnnotate = true }))
      const { highlights, notes } = annotateEvents(el)

      selectText(el, 6, 11)
      mouseUp(el)
      await el.updateComplete

      expect(highlightButton(el).disabled).toBe(false)
      highlightButton(el).click()
      noteButton(el).click()

      expect(highlights).toEqual([
        { pageNumber: 1, exact: 'world', prefix: 'hello ', suffix: 'second line', quads: [], mode: 'highlight' },
      ])
      expect(notes).toEqual([
        { pageNumber: 1, exact: 'world', prefix: 'hello ', suffix: 'second line', quads: [], mode: 'note' },
      ])
    })
  })

  describe('annotations: overlays, rail, select', () => {
    const ANNOTATIONS: MnPdfAnnotation[] = [
      { id: 'ann-1', pageNumber: 1, quote: 'hello world', note: 'first note', rects: [[10, 10, 80, 12]] },
      { id: 'ann-2', pageNumber: 2, label: 'Second', quote: 'other quote', color: 'rgba(0,128,255,0.4)', rects: [[20, 40, 60, 12]] },
    ]

    it('paints rects as positioned overlays in the right page and selects on click', async () => {
      const el = await mount((node) => ready(node, (n) => { n.annotations = ANNOTATIONS }))
      const selected: MnPdfAnnotationSelectDetail[] = []
      el.addEventListener('mn-pdf-annotation-select', (event) => {
        selected.push((event as CustomEvent<MnPdfAnnotationSelectDetail>).detail)
      })

      const pageOne = sr(el).querySelector('[data-page-number="1"]')!
      const rects = pageOne.querySelectorAll('.anno-rect')
      expect(rects).toHaveLength(1)
      const rect = rects[0] as HTMLElement
      expect(rect.style.left).toBe('10px')
      expect(rect.style.top).toBe('10px')
      expect(rect.style.width).toBe('80px')

      const pageTwo = sr(el).querySelector('[data-page-number="2"]')!
      expect(pageTwo.querySelectorAll('.anno-rect')).toHaveLength(1)
      expect((pageTwo.querySelector('.anno-rect') as HTMLElement).style.background).toContain('rgba(0, 128, 255, 0.4)')

      ;(rects[0] as HTMLButtonElement).click()
      expect(selected).toHaveLength(1)
      expect(selected[0].annotationId).toBe('ann-1')
      expect(selected[0].annotation.quote).toBe('hello world')
    })

    it('renders the annotation rail (quote/page/note) and selects on rail click', async () => {
      const el = await mount((node) => ready(node, (n) => { n.annotations = ANNOTATIONS }))
      const selected: MnPdfAnnotationSelectDetail[] = []
      el.addEventListener('mn-pdf-annotation-select', (event) => {
        selected.push((event as CustomEvent<MnPdfAnnotationSelectDetail>).detail)
      })

      const rail = sr(el).querySelector('.annotation-rail')!
      expect(rail.textContent).toContain('hello world')
      expect(rail.textContent).toContain('first note')
      expect(rail.textContent).toContain('Second') // label
      const items = rail.querySelectorAll('.annotation-item')
      expect(items).toHaveLength(2)

      ;(items[1] as HTMLButtonElement).click()
      expect(selected[0]?.annotationId).toBe('ann-2')
    })

    it('drives active styling from the controlled activeAnnotationId prop', async () => {
      const el = await mount((node) =>
        ready(node, (n) => {
          n.annotations = ANNOTATIONS
          n.activeAnnotationId = 'ann-1'
        }),
      )
      const overlay = sr(el).querySelector('[data-page-number="1"] .anno-rect') as HTMLElement
      expect(overlay.dataset['active']).toBe('true')
      const railItem = sr(el).querySelector('.annotation-item[data-annotation-id="ann-1"]')!
      expect(railItem.getAttribute('aria-current')).toBe('true')

      el.activeAnnotationId = 'ann-2'
      await el.updateComplete
      expect((sr(el).querySelector('[data-page-number="1"] .anno-rect') as HTMLElement).dataset['active']).toBe('false')
      expect(sr(el).querySelector('.annotation-item[data-annotation-id="ann-2"]')!.getAttribute('aria-current')).toBe('true')
    })

    it('renders no rail when there are no annotations', async () => {
      const el = await mount((node) => ready(node))
      expect(sr(el).querySelector('.annotation-rail')).toBeNull()
    })
  })

  describe('zoom + paging intents', () => {
    it('emits mn-pdf-zoom-change for zoom in / out', async () => {
      const el = await mount((node) => ready(node))
      const zooms: MnPdfZoomChangeDetail[] = []
      el.addEventListener('mn-pdf-zoom-change', (event) => {
        zooms.push((event as CustomEvent<MnPdfZoomChangeDetail>).detail)
      })

      ;(sr(el).querySelector('[aria-label="Zoom in"]') as HTMLButtonElement).click()
      ;(sr(el).querySelector('[aria-label="Zoom out"]') as HTMLButtonElement).click()
      expect(zooms).toEqual([
        { zoom: 1.2, mode: 'in' },
        { zoom: 0.833, mode: 'out' },
      ])
    })

    it('emits fit-width with the computed scale when the viewport is measurable', async () => {
      const el = await mount((node) => ready(node))
      const zooms: MnPdfZoomChangeDetail[] = []
      el.addEventListener('mn-pdf-zoom-change', (event) => {
        zooms.push((event as CustomEvent<MnPdfZoomChangeDetail>).detail)
      })

      const scroller = sr(el).querySelector('.pdf-scroll') as HTMLElement
      Object.defineProperty(scroller, 'clientWidth', { value: 1000, configurable: true })
      ;(sr(el).querySelector('[aria-label="Fit width"]') as HTMLButtonElement).click()
      expect(zooms).toEqual([{ zoom: 1.575, mode: 'fit-width' }])
    })

    it('scrolls to a controlled initial page on first mount', async () => {
      const el = await mount((node) => ready(node, current => {
        current.pageNumber = 2
      }))
      const scroller = sr(el).querySelector('.pdf-scroll') as HTMLElement
      expect(scroller.scrollTop).toBe(834)
      expect(sr(el).querySelector('.page-indicator')?.textContent?.trim()).toBe('2 / 2')
    })

    it('emits mn-pdf-page-change on scroll and follows the controlled pageNumber prop', async () => {
      const el = await mount((node) => ready(node))
      const changes: MnPdfPageChangeDetail[] = []
      el.addEventListener('mn-pdf-page-change', (event) => {
        changes.push((event as CustomEvent<MnPdfPageChangeDetail>).detail)
      })

      const scroller = sr(el).querySelector('.pdf-scroll') as HTMLElement
      scroller.scrollTop = 900
      scroller.dispatchEvent(new Event('scroll'))
      await el.updateComplete

      expect(changes).toEqual([{ pageNumber: 2 }])
      expect(sr(el).querySelector('.page-indicator')?.textContent?.trim()).toBe('2 / 2')

      // Shell-driven page move: the reader follows and scrolls the page to top.
      el.pageNumber = 1
      await el.updateComplete
      expect(scroller.scrollTop).toBe(24)
      expect(sr(el).querySelector('.page-indicator')?.textContent?.trim()).toBe('1 / 2')
    })
  })

  describe('file actions: disabled states + intents', () => {
    it('disables download / open-external unless allowed, and emits when clicked', async () => {
      const el = await mount((node) => ready(node))
      const downloads: MnPdfFileIntentDetail[] = []
      const opens: MnPdfFileIntentDetail[] = []
      el.addEventListener('mn-pdf-download', (event) => {
        downloads.push((event as CustomEvent<MnPdfFileIntentDetail>).detail)
      })
      el.addEventListener('mn-pdf-open-external', (event) => {
        opens.push((event as CustomEvent<MnPdfFileIntentDetail>).detail)
      })

      const download = sr(el).querySelector('[aria-label="Download PDF"]') as HTMLButtonElement
      const open = sr(el).querySelector('[aria-label="Open PDF externally"]') as HTMLButtonElement
      expect(download.disabled).toBe(true)
      expect(open.disabled).toBe(true)
      download.click()
      open.click()
      expect(downloads).toHaveLength(0)
      expect(opens).toHaveLength(0)

      el.downloadable = true
      el.externalOpenable = true
      await el.updateComplete
      expect(download.disabled).toBe(false)
      expect(open.disabled).toBe(false)
      download.click()
      open.click()
      expect(downloads).toEqual([{ filename: 'paper.pdf' }])
      expect(opens).toEqual([{ filename: 'paper.pdf' }])
    })
  })
})
