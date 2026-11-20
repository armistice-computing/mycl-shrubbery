/**
 * Printing an exported document.
 *
 * The export preview's iframe can't print in the desktop app. On macOS Tauri
 * replaces the TOP window's window.print with
 * invoke('plugin:webview|print'), which prints the whole app webview, and
 * an iframe's print reaches nothing. So the exported page is laid into the
 * main document in a print-only host, everything else is hidden from print,
 * and the top window prints. In a browser the same window.print shows the
 * browser's own print dialog.
 *
 * The node's printing needs the `core:webview:allow-print` permission in the
 * desktop app's capabilities. Without it the invoke is refused, and
 * printExportedHtml rejects so the dialog can say so.
 */

const HOST_ID = 'mn-export-print-host'
const PAGE_CLASS = 'mn-export-print-page'

/** Print-only visibility for the host page: only the export prints. */
const HOST_CSS = `
@media screen { #${HOST_ID} { display: none !important; } }
@media print {
  @page { margin: 0; }
  body > *:not(#${HOST_ID}) { display: none !important; }
  #${HOST_ID} { display: block !important; }
}
`

/**
 * The printed page keeps its theme. WebKit leaves background colors out of
 * print unless a page asks for them, so a Dusk export printed light text on
 * white paper (Eschaton, 2026-11-18). The page also fills the sheet edge to
 * edge, its padding standing in for the print margin.
 */
const PAGE_PRINT_CSS = `
@media print {
  .${PAGE_CLASS} {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    max-width: none;
    margin: 0;
    padding: 48px max(48px, calc((100% - 760px) / 2));
    min-height: 100vh;
    box-sizing: border-box;
  }
}
`

/**
 * The export's CSS, moved from its own <body> and <html> onto the page
 * wrapper inside the host's shadow root, so it can't restyle the app.
 */
export function scopeExportCss(css: string): string {
  return css.replace(/(^|[\s,}])(html|body)(?=[\s.{,:[#>~+]|$)/g, `$1.${PAGE_CLASS}`)
}

function sheetFor(doc: Document, css: string): CSSStyleSheet | null {
  const Sheet = (doc.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null)?.CSSStyleSheet
  if (!Sheet || typeof Sheet.prototype.replaceSync !== 'function') return null
  const sheet = new Sheet()
  sheet.replaceSync(css)
  return sheet
}

let hostSheet: CSSStyleSheet | null = null

/** Removes the print host, if one is there. */
export function clearExportPrint(doc: Document = document): void {
  doc.getElementById(HOST_ID)?.remove()
}

/**
 * Lays the exported HTML into a print host and prints the top window. The
 * host stays until the next print or clearExportPrint, because the desktop
 * print sheet renders after the call returns.
 */
export async function printExportedHtml(htmlText: string, doc: Document = document): Promise<void> {
  const parsed = new DOMParser().parseFromString(htmlText, 'text/html')
  const css = Array.from(parsed.querySelectorAll('style'), style => style.textContent ?? '').join('\n')

  clearExportPrint(doc)
  const host = doc.createElement('div')
  host.id = HOST_ID
  const root = host.attachShadow({ mode: 'open' })
  const page = doc.createElement('div')
  page.className = [PAGE_CLASS, parsed.body.className].filter(Boolean).join(' ')
  page.innerHTML = parsed.body.innerHTML
  root.append(page)
  const scoped = sheetFor(doc, `${scopeExportCss(css)}\n${PAGE_PRINT_CSS}`)
  if (scoped) root.adoptedStyleSheets = [scoped]
  doc.body.append(host)

  if (!hostSheet) hostSheet = sheetFor(doc, HOST_CSS)
  if (hostSheet && !doc.adoptedStyleSheets.includes(hostSheet)) {
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, hostSheet]
  }

  const view = doc.defaultView as (Window & { print(): unknown }) | null
  await view?.print()
}
