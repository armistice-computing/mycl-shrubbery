import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearExportPrint, printExportedHtml, scopeExportCss } from '../export-print.js'

const EXPORTED = '<!doctype html><html><head><style>body{color:#1f2937;max-width:760px}.theme-dusk{background:#111827}pre{padding:16px}</style></head><body class="theme-dusk"><h1>Notes</h1><p>Hello</p></body></html>'

afterEach(() => {
  clearExportPrint()
  vi.restoreAllMocks()
})

describe('export printing', () => {
  it('moves body and html rules onto the page wrapper so the app is not restyled', () => {
    expect(scopeExportCss('body{color:red}html,body{margin:0}.theme-dusk pre{x:y}')).toBe(
      '.mn-export-print-page{color:red}.mn-export-print-page,.mn-export-print-page{margin:0}.theme-dusk pre{x:y}',
    )
    expect(scopeExportCss('.tbody{a:b} tbody{c:d}')).toBe('.tbody{a:b} tbody{c:d}')
  })

  it('lays the export into a print-only host with its theme, then prints the top window', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    await printExportedHtml(EXPORTED)
    const host = document.getElementById('mn-export-print-host')
    const page = host?.shadowRoot?.querySelector('.mn-export-print-page')
    expect(page?.classList.contains('theme-dusk')).toBe(true)
    expect(page?.querySelector('h1')?.textContent).toBe('Notes')
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('replaces the previous print host, and rejects when printing is refused', async () => {
    vi.spyOn(window, 'print').mockImplementation(() => undefined)
    await printExportedHtml(EXPORTED)
    await printExportedHtml(EXPORTED)
    expect(document.querySelectorAll('#mn-export-print-host')).toHaveLength(1)
    vi.spyOn(window, 'print').mockImplementation((() => Promise.reject(new Error('not allowed'))) as unknown as () => void)
    await expect(printExportedHtml(EXPORTED)).rejects.toThrow('not allowed')
  })
})
