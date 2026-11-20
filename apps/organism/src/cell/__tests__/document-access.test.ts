/**
 * document-access.test.ts — who owns this document, and can that be revoked?
 *
 * THE BUG THIS EXISTS FOR, found by Eschaton in about two minutes of clicking.
 * The frontend decided editability from `doc:readOnly`, the mutable WORKSPACE
 * FLAG. She opened her Song, was offered "Make Editable", clicked it, and typed.
 * The flag cleared, the typing was accepted, and every save was refused by
 * gardend. Nothing was lost — the backend guard held — but it LOOKED like it had
 * worked, which is worse than a disabled control and much worse than an error.
 *
 * The fix is not a better flag, it is a different question. gardend now answers
 * with EFFECTIVE access (garden docs/workspace-derived-access.md):
 *
 *     readOnly       effective, not the raw workspace flag
 *     derived        server-owned view, from registration/capabilities
 *     readOnlyOwner  'geist' for Song/archive views, null otherwise
 *
 * The cases below are the ones measured against a real cell built from
 * epsilon/workspace-derived-access, not invented:
 *
 *     geist-song    readOnly=true   derived=true   owner=geist
 *     doc-welcome   readOnly=false  derived=false  owner=null
 *
 * and, after `make_document_editable` is attempted and refused, geist-song
 * still reads readOnly=true / derived=true / owner=geist.
 */
import { describe, it, expect } from 'vitest'
import {
  loadDocumentAccess,
  parseDocumentAccess,
  OPEN_ACCESS,
} from '../document-access.js'

describe('parseDocumentAccess', () => {
  it('reads a derived Geist view exactly as the cell reports it', () => {
    expect(parseDocumentAccess({
      graph_id: 'g', document_id: 'geist-song',
      readOnly: true, derived: true, readOnlyOwner: 'geist',
    })).toEqual({ readOnly: true, derived: true, readOnlyOwner: 'geist' })
  })

  it('reads an ordinary writable document', () => {
    expect(parseDocumentAccess({
      readOnly: false, derived: false, readOnlyOwner: null,
    })).toEqual({ readOnly: false, derived: false, readOnlyOwner: null })
  })

  it('an ordinary IMPORTED document is read-only but NOT derived', () => {
    // The distinction the whole feature turns on: Make Editable is a
    // legitimate offer here and must stay available.
    expect(parseDocumentAccess({
      readOnly: true, derived: false, readOnlyOwner: null,
    })).toEqual({ readOnly: true, derived: false, readOnlyOwner: null })
  })

  it('an older cell, carrying none of the fields, reads as open', () => {
    // Deliberate direction to fail in. The backend refuses writes either way;
    // guessing "locked" would make an older cell an app that edits nothing.
    expect(parseDocumentAccess({ graph_id: 'g', document_id: 'd' })).toEqual(OPEN_ACCESS)
    expect(parseDocumentAccess(null)).toEqual(OPEN_ACCESS)
    expect(parseDocumentAccess('nonsense')).toEqual(OPEN_ACCESS)
  })

  it('only the exact boolean true counts — no truthiness', () => {
    // A forged or coerced value must not claim ownership. 'false', 0 and 1 are
    // all things a loosely-typed payload can carry.
    expect(parseDocumentAccess({ readOnly: 'true', derived: 1 }))
      .toEqual({ readOnly: false, derived: false, readOnlyOwner: null })
  })

  it('an empty owner string normalizes to null', () => {
    expect(parseDocumentAccess({ readOnly: true, derived: true, readOnlyOwner: '' }).readOnlyOwner)
      .toBeNull()
  })
})

describe('loadDocumentAccess', () => {
  it('asks for the CLIPPED envelope — the whole point of the call being cheap', async () => {
    // markdown is paginated, so maxChars:1 returns the envelope whole with the
    // body clipped: about a kilobyte no matter how long the document is. Losing
    // this argument would make opening a pane fetch an entire document.
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    await loadDocumentAccess(async (name, args) => {
      calls.push({ name, args })
      return { readOnly: true, derived: true, readOnlyOwner: 'geist' }
    }, 'g', 'geist-song')

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('read_document')
    expect(calls[0].args.format).toBe('markdown')
    expect(calls[0].args.maxChars).toBe(1)
    expect(calls[0].args.documentId).toBe('geist-song')
  })

  it('returns the cell answer', async () => {
    const facts = await loadDocumentAccess(
      async () => ({ readOnly: true, derived: true, readOnlyOwner: 'geist' }),
      'g', 'geist-song',
    )
    expect(facts).toEqual({ readOnly: true, derived: true, readOnlyOwner: 'geist' })
  })

  it('a FAILED read leaves the document editable rather than freezing it', async () => {
    // A network blip must not lock someone out of their own writing. The
    // backend is the enforcement; this is only the affordance.
    const facts = await loadDocumentAccess(async () => { throw new Error('cell down') }, 'g', 'd')
    expect(facts).toEqual(OPEN_ACCESS)
  })

  it('asks nothing at all without a graph and a document', async () => {
    let called = false
    const call = async (): Promise<unknown> => { called = true; return {} }
    expect(await loadDocumentAccess(call, '', 'd')).toEqual(OPEN_ACCESS)
    expect(await loadDocumentAccess(call, 'g', '')).toEqual(OPEN_ACCESS)
    expect(called).toBe(false)
  })
})
