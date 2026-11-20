import { describe, expect, it } from 'vitest'
import { untitledDocumentTitle } from '../new-document-title.js'

describe('untitledDocumentTitle', () => {
  it('names a document for when it was made, month.day.year.hour.minute', () => {
    expect(untitledDocumentTitle(new Date(2026, 10, 18, 9, 55))).toBe('11.18.26.9.55')
  })

  it('keeps a morning and an evening apart, and pads the minute', () => {
    expect(untitledDocumentTitle(new Date(2026, 10, 18, 21, 5))).toBe('11.18.26.21.05')
    expect(untitledDocumentTitle(new Date(2030, 0, 2, 0, 0))).toBe('1.2.30.0.00')
  })
})
