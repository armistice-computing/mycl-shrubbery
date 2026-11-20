import { describe, expect, it } from 'vitest'
import { CLIP_THIN_NOTICE, clipFailureMessage, clipNotice } from '../clip-messages.js'
import { DocumentTransferError } from '../document-transfer.js'

const failed = (payload: unknown) => new DocumentTransferError('fetch library text the person never sees', 200, payload)

describe('clip messages', () => {
  it('says Beta\'s sentence for each failure kind the route reports', () => {
    expect(clipFailureMessage(failed({ status: 'error', kind: 'refused', errors: ['HTTP 403'] }))).toMatch(/^This site refused to share the page/)
    expect(clipFailureMessage(failed({ status: 'error', kind: 'unreachable' }))).toMatch(/^Couldn't reach that site/)
    expect(clipFailureMessage(failed({ status: 'error', kind: 'empty' }))).toMatch(/^Almost no text came back/)
    expect(clipFailureMessage(failed({ status: 'error', failureKind: 'too-large' }))).toMatch(/^That page is too large/)
    expect(clipFailureMessage(failed({ status: 'error', kind: 'invalid-url' }))).toMatch(/^That doesn't look like a web address/)
  })

  it('says the video and private-address sentences, keeping the general refusal for public hosts', () => {
    expect(clipFailureMessage(failed({ kind: 'video', errors: ['Videos can\'t be clipped yet'] }))).toBe("Videos can't be clipped yet: only articles and pages.")
    expect(clipFailureMessage(failed({ kind: 'refused', errors: ["This address can't be clipped from here."] }))).toBe("This address can't be clipped from here.")
    expect(clipFailureMessage(failed({ kind: 'refused', errors: ['HTTP 403: Forbidden'] }))).toMatch(/^This site refused to share the page/)
  })

  it('names a PDF link as a PDF', () => {
    expect(clipFailureMessage(failed({ kind: 'not-html', contentType: 'application/pdf' }))).toMatch(/^That link is a PDF/)
    expect(clipFailureMessage(failed({ kind: 'not-html', contentType: 'image/png' }))).toMatch(/^That link is a file, not a page/)
  })

  it('is neutral when the kind is missing or unknown, never echoing raw text', () => {
    for (const error of [failed({ errors: ['socket hang up'] }), new Error('boom'), 'nope', failed({ kind: 'mystery' })]) {
      const message = clipFailureMessage(error)
      expect(message).toBe("That page couldn't be clipped.")
      expect(message).not.toMatch(/socket|boom|mystery|our side/)
    }
    expect(clipFailureMessage(failed({ kind: 'internal' }))).toMatch(/^Something went wrong on our side/)
  })

  it('adds the thin-page caveat only when the route warned so', () => {
    expect(clipNotice(['This page came in thin (217 characters)'])).toBe(CLIP_THIN_NOTICE)
    expect(clipNotice(['Image skipped'])).toBe('')
    expect(clipNotice([])).toBe('')
  })
})
