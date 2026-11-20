import { describe, expect, it } from 'vitest'
import type { MnPdfAnnotateDetail } from '@shrubbery/components'
import {
  OrganismPdfAnnotationStore,
  type PdfSelector,
} from '../pdf-annotation-service.js'
import type { PdfEmbeddedAnnotation } from '../pdf-service.js'

const IDENTITY = {
  graphId: 'graph-a',
  artifactId: 'artifact-a',
  ingestedDocumentId: 'doc-a',
  filename: 'paper.pdf',
}

const DETAIL: MnPdfAnnotateDetail = {
  pageNumber: 2,
  exact: 'exact "quote" & more',
  prefix: 'before',
  suffix: 'after',
  quads: [[10, 20, 30, 40]],
  mode: 'highlight',
}

function selector(overrides: Partial<PdfSelector> = {}): PdfSelector {
  return {
    page: 1,
    exact: 'hello',
    prefix: '',
    suffix: 'world',
    quads: [[1, 2, 3, 4]],
    kind: 'highlight',
    source: 'reader',
    artifactId: 'artifact-a',
    ...overrides,
  }
}

function projection(selectorValue: PdfSelector, comments: readonly unknown[] = []) {
  return {
    content: JSON.stringify({
      tiptapJson: {
        type: 'doc',
        content: [{
          type: 'paragraph',
          attrs: {
            'data-block-id': 'block-pdf-a',
            'data-pdf-selector': JSON.stringify(selectorValue),
          },
          content: [{ type: 'text', text: selectorValue.exact }],
        }],
      },
    }),
    comments,
    nextOffset: null,
  }
}

describe('OrganismPdfAnnotationStore', () => {
  it('does not create a companion merely by loading an unannotated PDF', async () => {
    const calls: string[] = []
    const store = new OrganismPdfAnnotationStore({
      callTool: async (name) => {
        calls.push(name)
        if (name === 'check_document') return { status: 'available' }
        throw new Error(`unexpected ${name}`)
      },
    }, IDENTITY)

    await expect(store.load()).resolves.toEqual([])
    expect(calls).toEqual(['check_document'])
  })

  it('reads every JSON page and projects quote blocks with their shared comment', async () => {
    const full = projection(selector(), [{
      id: 'comment-a', blockId: 'block-pdf-a', text: 'shared note', author: 'Eschaton', resolved: false,
    }, {
      id: 'comment-b', blockId: 'block-pdf-a', text: 'agent note', author: 'Agent', resolved: false,
    }])
    const midpoint = Math.floor(full.content.length / 2)
    const store = new OrganismPdfAnnotationStore({
      callTool: async (name, args) => {
        if (name === 'check_document') return { status: 'exists' }
        if (name === 'read_document') {
          const offset = Number(args.offset ?? 0)
          const end = offset === 0 ? midpoint : full.content.length
          return {
            content: full.content.slice(offset, end),
            comments: offset === 0 ? full.comments : [],
            nextOffset: end < full.content.length ? end : null,
          }
        }
        throw new Error(`unexpected ${name}`)
      },
    }, IDENTITY)

    await expect(store.load()).resolves.toEqual([{
      id: 'block-pdf-a',
      pageNumber: 1,
      label: 'Eschaton, Agent',
      quote: 'hello',
      note: 'shared note\n\nagent note',
      color: undefined,
      kind: 'highlight',
      source: 'reader',
      rects: [[1, 2, 3, 4]],
    }])
  })

  it('creates deterministic quote, comment, and provenance-wire writes on first annotation', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    let exists = false
    const store = new OrganismPdfAnnotationStore({
      callTool: async (name, args) => {
        calls.push({ name, args: { ...args } })
        if (name === 'check_document') return { status: exists ? 'exists' : 'available' }
        if (name === 'create_document') {
          exists = true
          return { documentId: IDENTITY.artifactId }
        }
        if (name === 'read_document') return projection(selector())
        return { success: true }
      },
    }, IDENTITY)

    const first = await store.add(DETAIL, { text: 'a note', author: 'Eschaton' })
    const second = await store.add(DETAIL, { text: 'a note', author: 'Eschaton' })
    expect(first.annotationId).toBe(second.annotationId)
    expect(first.annotationId).toMatch(/^block-pdf-[a-f0-9]{32}$/)

    const create = calls.find(call => call.name === 'create_document')
    expect(create?.args).toMatchObject({
      graphId: 'graph-a',
      documentId: 'pdf-ann-artifact-a',
      title: 'PDF annotations — paper.pdf',
    })
    const insert = calls.find(call => call.name === 'insert_blocks')
    expect(String(insert?.args.content)).toContain('exact &quot;quote&quot; &amp; more')
    expect(String(insert?.args.content)).toContain('data-pdf-page="2"')
    expect(String(insert?.args.content)).toContain('data-pdf-selector=')

    const comment = calls.find(call => call.name === 'edit_comment')
    expect(comment?.args).toMatchObject({
      action: 'set',
      blockId: first.annotationId,
      find: DETAIL.exact,
      text: 'a note',
      author: 'Eschaton',
    })
    const wireCall = calls.find(call => call.name === 'create_wires')
    const wires = wireCall?.args.wires as Array<Record<string, unknown>>
    expect(wires).toHaveLength(2)
    expect(wires[0]).toMatchObject({ targetArtifactId: 'artifact-a', predicate: 'annotates' })
    expect(wires[1]).toMatchObject({ targetDocumentId: 'doc-a', predicate: 'annotates' })
    expect(wires[0]?.wireId).not.toBe(wires[1]?.wireId)
  })

  it('imports embedded annotations idempotently and leaves changed source annotations untouched', async () => {
    const embedded: PdfEmbeddedAnnotation[] = [{
      id: '7R', kind: 'highlight', pageNumber: 1, label: 'Reviewer', note: 'embedded note',
      quote: 'Harness', prefix: '', suffix: ' Oracle', rects: [[10, 20, 30, 40]], color: 'rgba(255, 0, 0, 0.35)',
    }, {
      id: '8R', kind: 'note', pageNumber: 2, label: 'Reviewer', note: 'sticky note',
      quote: '', prefix: '', suffix: '', rects: [[50, 60, 12, 12]],
    }]
    const blocks: Array<{ id: string; selector: PdfSelector }> = []
    const comments: Array<Record<string, unknown>> = []
    let exists = false
    let ensureCount = 0
    const decodeXml = (value: string) => value
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    const store = new OrganismPdfAnnotationStore({
      callTool: async (name, args) => {
        if (name === 'check_document') return { status: exists ? 'exists' : 'available' }
        if (name === 'create_document') {
          ensureCount += 1
          exists = true
          return { documentId: 'pdf-ann-artifact-a' }
        }
        if (name === 'insert_blocks') {
          const content = String(args.content)
          const id = /data-block-id="([^"]+)"/.exec(content)?.[1] ?? ''
          const encoded = /data-pdf-selector="([^"]+)"/.exec(content)?.[1] ?? ''
          if (!id || !encoded) throw new Error('annotation block metadata missing')
          const parsed = JSON.parse(decodeXml(encoded)) as PdfSelector
          if (!blocks.some(block => block.id === id)) blocks.push({ id, selector: parsed })
          return { success: true }
        }
        if (name === 'edit_comment') {
          if (!comments.some(comment => comment.id === args.commentId)) {
            comments.push({ ...args, id: args.commentId })
          }
          return { success: true }
        }
        if (name === 'read_document') {
          return {
            content: JSON.stringify({ tiptapJson: { content: blocks.map(block => ({
              type: 'paragraph',
              attrs: {
                'data-block-id': block.id,
                'data-pdf-selector': JSON.stringify(block.selector),
              },
              content: block.selector.exact ? [{ type: 'text', text: block.selector.exact }] : [],
            })) } }),
            comments,
            nextOffset: null,
          }
        }
        return { success: true }
      },
    }, IDENTITY)

    const first = await store.load(embedded)
    expect(first).toHaveLength(2)
    expect(first[0]).toMatchObject({ quote: 'Harness', note: 'embedded note', label: 'Reviewer' })
    expect(first[1]).toMatchObject({ quote: '', note: 'sticky note' })
    expect(blocks).toHaveLength(2)
    expect(comments).toHaveLength(2)
    expect(comments[0]).toMatchObject({ find: 'Harness', quotedText: 'Harness' })
    expect(comments[1]).not.toHaveProperty('find')
    expect(blocks[0]?.selector).toMatchObject({
      source: 'embedded', importedId: 'pdf-embedded:v1:artifact-a:7R', exact: 'Harness',
    })

    await store.load(embedded)
    expect(blocks).toHaveLength(2)
    expect(comments).toHaveLength(2)

    comments[0]!.text = 'local edit'
    const edited = await store.load(embedded)
    expect(edited[0]?.note).toBe('local edit')
    expect(comments).toHaveLength(2)

    const changed = await store.load([{ ...embedded[0]!, note: 'changed upstream' }, embedded[1]!])
    expect(changed[0]?.note).toBe('local edit')
    expect(store.warnings).toHaveLength(1)
    expect(store.warnings[0]).toContain('changed')
    expect(blocks).toHaveLength(2)
    expect(comments).toHaveLength(2)
    expect(ensureCount).toBe(1)
  })
})
