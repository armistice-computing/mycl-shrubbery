/**
 * Styles for a document the app's CSP would otherwise leave unstyled.
 *
 * The desktop app's style-src carries a nonce that Tauri injects, and a nonce
 * makes 'unsafe-inline' inert, so a <style> element without that nonce is
 * refused (apps/organism/scripts/csp-inline-style-webkit.mts measures this).
 * A srcdoc iframe inherits the parent's policy, which is why the export
 * preview showed no theme while the exported file, opened on its own, did.
 * Constructed stylesheets are not inline styles, so the CSS goes in through
 * adoptedStyleSheets instead.
 */

/** The CSS text of every <style> element in a document, in order. */
export function inlineStyleText(doc: Document): string {
  return Array.from(doc.querySelectorAll('style'), style => style.textContent ?? '').join('\n')
}

/**
 * Adopts the document's own <style> CSS as one constructed sheet. Returns
 * false when the engine has no constructable stylesheets (the <style>
 * elements are left as they are, which is all an engine without a nonce
 * needs).
 */
export function adoptInlineStyles(doc: Document): boolean {
  const view = doc.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null
  const Sheet = view?.CSSStyleSheet
  if (!Sheet || typeof Sheet.prototype.replaceSync !== 'function' || !('adoptedStyleSheets' in doc)) return false
  const text = inlineStyleText(doc)
  if (!text.trim()) return true
  const sheet = new Sheet()
  sheet.replaceSync(text)
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
  return true
}
