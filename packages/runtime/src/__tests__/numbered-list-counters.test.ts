import { describe, expect, it } from 'vitest'
import { LIST_COUNTER_MAX_INDENT, numberedListCounterCss } from '../editor-host.js'

const css = numberedListCounterCss()
const rule = (selectorPart: string): string => {
  const line = css.split('\n').find(candidate => candidate.startsWith(`.editor-mount .ProseMirror > ${selectorPart} {`))
  if (!line) throw new Error(`no rule for ${selectorPart}`)
  return line
}

describe('numbered-list counters (flat list model)', () => {
  it('starts every depth over at a block that is not a list item', () => {
    const reset = css.split('\n')[0]
    expect(reset).toContain(':not(li)')
    for (let depth = 0; depth <= LIST_COUNTER_MAX_INDENT; depth++) expect(reset).toContain(`list-counter-${depth}`)
  })

  it('counts each depth on its own counter and starts the depths below over', () => {
    const top = rule("li[data-list-type='ordered']:not([data-indent])")
    expect(top).toContain('counter-increment: list-counter-0;')
    expect(top).toContain('counter-reset: list-counter-1')
    expect(top).not.toMatch(/counter-reset:[^;]*list-counter-0/)
    const nested = rule("li[data-list-type='ordered'][data-indent='1']")
    expect(nested).toContain('counter-increment: list-counter-1;')
    expect(nested).not.toMatch(/counter-reset:[^;]*list-counter-1\b/)
  })

  it('a bullet or task item starts its own depth over', () => {
    expect(rule("li:not([data-list-type='ordered']):not([data-indent])")).toContain('counter-reset: list-counter-0')
    expect(rule("li:not([data-list-type='ordered'])[data-indent='2']")).toMatch(/counter-reset: list-counter-2 /)
  })

  it('shows each depth its own number', () => {
    expect(rule("li[data-list-type='ordered'][data-indent='3'] .list-item-number::before")).toContain("counter(list-counter-3) '.'")
  })
})
