import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { fontFaceRules } from '../editor-services/math-renderer.js'

const require = createRequire(import.meta.url)
const katexCss = readFileSync(require.resolve('katex/dist/katex.min.css'), 'utf8')

describe('KaTeX styles on the document', () => {
  it('carry only the @font-face rules, never KaTeX global body rule', () => {
    // The shipped stylesheet has one unscoped rule, body{counter-reset:...}.
    // Adopted whole onto the document it would land on the app's own body.
    expect(katexCss).toMatch(/body\s*\{\s*counter-reset/)
    const fonts = fontFaceRules(katexCss)
    expect(fonts).toMatch(/@font-face/)
    expect(fonts).toMatch(/KaTeX_Main/)
    expect(fonts).not.toMatch(/(^|[}\s])body\s*\{/)
    expect(fonts).not.toMatch(/\.katex\b/)
    // Every @font-face in the sheet survives.
    const all = katexCss.match(/@font-face/g)?.length ?? 0
    expect(fonts.match(/@font-face/g)?.length).toBe(all)
    expect(all).toBeGreaterThan(10)
  })
})
