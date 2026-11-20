import { describe, expect, it } from 'vitest'
import { EXPANDED_MIN_CENTER_PX, expandedLeftWidth } from '../render-workspace.js'

describe('expandedLeftWidth (the Graph tab roll-out)', () => {
  it('takes 70% of a wide main area', () => {
    expect(expandedLeftWidth(2000)).toBe(1400)
  })

  it('leaves the editor at least 480px on a smaller window', () => {
    expect(1280 - expandedLeftWidth(1280)).toBeGreaterThanOrEqual(EXPANDED_MIN_CENTER_PX)
    expect(expandedLeftWidth(960)).toBe(480)
  })

  it('keeps the rail usable on a very narrow window', () => {
    expect(expandedLeftWidth(700)).toBe(280)
    expect(expandedLeftWidth(0)).toBe(0)
  })
})
