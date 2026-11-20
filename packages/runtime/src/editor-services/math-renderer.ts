/**
 * Runtime-owned KaTeX renderer for the pure editor-kernel math seam.
 *
 * The kernel's math nodes render through an optional `renderMath` callback and
 * fall back to raw LaTeX text. Nothing supplied the callback, so math showed
 * as its source: `$$x^2$$` became a math node that said `x^2`. This module is
 * that callback, the only editor path that imports KaTeX (lazily, like
 * Mermaid in mermaid-renderer.ts).
 *
 * KaTeX's stylesheet goes to two places, adopted rather than injected (the
 * app's CSP refuses runtime <style> elements; see adoptStyleSheet):
 *   - the root the math lives in (the editor's shadow root), for layout;
 *   - the document, its @font-face rules only, because browsers ignore
 *     @font-face declared inside a shadow root, and without KaTeX's fonts the
 *     output is unreadable.
 * Vite's ?inline transform rewrites the font url()s to built asset URLs.
 */
import type { MathRenderCurrentCheck, MathRenderer, MathRenderRequest } from '@shrubbery/editor-kernel'
import { adoptStyleSheet, styleRootOf } from '@shrubbery/nucleus'

interface KatexEngine {
  render(src: string, element: HTMLElement, options: Record<string, unknown>): void
}

interface LoadedKatex {
  readonly katex: KatexEngine
  readonly cssText: string
}

const KATEX_STYLE_KEY = 'katex'
const KATEX_FONTS_KEY = 'katex-fonts'

/**
 * KaTeX rendering limits, set explicitly. Formulas come from anything that
 * writes documents, agents and imports included. `trust: false` keeps
 * \href, \url and \includegraphics from taking links (KaTeX's default, pinned
 * here). `maxSize` caps user-specified sizes in em: KaTeX's default is
 * Infinity, so \rule{99999em}{99999em} would lay out an enormous element.
 * `maxExpand` caps macro expansion (KaTeX's default, pinned).
 */
const KATEX_LIMITS = { trust: false, maxSize: 50, maxExpand: 1000 } as const

let loading: Promise<LoadedKatex> | null = null

function loadKatex(): Promise<LoadedKatex> {
  // Vite's ?inline transform returns the stylesheet as a string. TypeScript
  // has no declaration for the query, hence the explicit module shape.
  // @ts-ignore -- resolved by Vite's CSS inline plugin (as in excalidraw-runtime.ts).
  const cssModule: Promise<{ default: string }> = import('katex/dist/katex.min.css?inline')
  loading ??= Promise.all([import('katex'), cssModule]).then(([module, css]) => ({
    katex: (module.default ?? module) as KatexEngine,
    cssText: css.default,
  }))
  return loading
}

/**
 * Only the @font-face rules, for the document. The whole stylesheet there
 * would also carry KaTeX's one unscoped rule, body{counter-reset:...}, onto
 * the app's own body.
 */
export function fontFaceRules(cssText: string): string {
  return (cssText.match(/@font-face\s*\{[^}]*\}/g) ?? []).join('\n')
}

/**
 * Render `request` into `target` with KaTeX. Rejects on a LaTeX error. Writes
 * nothing once `isCurrent()` is false: a newer render, or a destroyed view,
 * owns the target by then.
 */
export async function renderMathWithKatex(
  target: HTMLElement,
  request: MathRenderRequest,
  isCurrent: MathRenderCurrentCheck = () => true,
): Promise<void> {
  const { katex, cssText } = await loadKatex()
  // The node view renders before ProseMirror attaches it. ProseMirror attaches
  // it in the same update, so after the load it is normally connected; if not,
  // give it one task so the sheet lands on the editor's shadow root and not
  // the document.
  if (!target.isConnected) await new Promise(resolve => setTimeout(resolve, 0))
  if (!isCurrent()) return
  adoptStyleSheet(styleRootOf(target), KATEX_STYLE_KEY, cssText)
  const doc = target.ownerDocument
  if (doc) adoptStyleSheet(doc, KATEX_FONTS_KEY, fontFaceRules(cssText))
  // throwOnError: a malformed expression rejects, and the kernel writes the
  // source in its error style instead of KaTeX's red inline message. (KaTeX
  // empties `target` before it parses, so a failure leaves it empty for the
  // kernel to fill.)
  katex.render(request.src.trim(), target, {
    displayMode: request.displayMode,
    throwOnError: true,
    output: 'htmlAndMathml',
    ...KATEX_LIMITS,
  })
  target.parentElement?.removeAttribute('data-math-error')
}

export const defaultMathRenderer: MathRenderer = renderMathWithKatex
