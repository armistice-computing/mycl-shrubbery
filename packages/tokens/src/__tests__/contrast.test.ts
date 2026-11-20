import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../css')
const read = (file: string) => readFileSync(resolve(CSS_DIR, file), 'utf8')

describe('@shrubbery/tokens — Increase Contrast', () => {
  it('loads after every skin, so its tokens win where the person asked for more contrast', () => {
    const imports = [...read('tokens.css').matchAll(/@import '\.\/([^']+)'/g)].map(match => match[1])
    expect(imports.at(-1)).toBe('contrast.css')
  })

  it('only acts under prefers-contrast: more, and reaches skins in both themes', () => {
    const css = read('contrast.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css.trim().startsWith('@media (prefers-contrast: more)')).toBe(true)
    expect(css).toMatch(/\[data-theme\]\[data-skin\]\s*\{/)
    expect(css).toMatch(/\[data-theme="dark"\]\[data-skin\]\s*\{/)
    expect(css).toMatch(/--mn-focus-ring-width:\s*2px/)
  })
})
