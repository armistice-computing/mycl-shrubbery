import { describe, expect, it } from 'vitest'
import { rightPanelAfterLeftCollapse } from '../left-panel-collapse.js'

describe('closing the expanded left panel', () => {
  it('keeps the right panel closed when the Graph rolled out from a closed right panel', () => {
    // Graph → Graph with the right panel closed: preExpandRightPanel holds the
    // default panel, the roll-out record holds 'none'.
    expect(rightPanelAfterLeftCollapse({ rightPanel: 'none' }, 'wires')).toBe('none')
  })

  it('brings back the right panel the Graph rolled out from', () => {
    expect(rightPanelAfterLeftCollapse({ rightPanel: 'comments' }, 'wires')).toBe('comments')
  })

  it('uses the remembered panel when the left panel was widened by hand', () => {
    expect(rightPanelAfterLeftCollapse(null, 'wires')).toBe('wires')
  })
})
