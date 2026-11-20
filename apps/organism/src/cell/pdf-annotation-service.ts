import type { MnPdfAnnotation, MnPdfAnnotateDetail, MnPdfRect } from '@shrubbery/components'
import type { PdfEmbeddedAnnotation } from './pdf-service.js'

export interface PdfAnnotationMcp {
  callTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>
}

export interface PdfCompanionIdentity {
  readonly graphId: string
  readonly artifactId: string
  readonly ingestedDocumentId?: string | null
  readonly filename: string
}

export type PdfAnnotationKind = 'highlight' | 'note'
export type PdfAnnotationSource = 'reader' | 'embedded'

export interface PdfSelector {
  readonly page: number
  readonly exact: string
  readonly prefix: string
  readonly suffix: string
  readonly quads: readonly MnPdfRect[]
  readonly color?: string
  readonly kind: PdfAnnotationKind
  readonly source: PdfAnnotationSource
  readonly artifactId: string
  readonly contentHash?: string
  readonly importedId?: string
}

export interface PdfAnnotationWriteResult {
  readonly annotationId: string
  readonly annotations: readonly MnPdfAnnotation[]
}

export interface PdfAnnotationStore {
  readonly warnings?: readonly string[]
  load(embedded?: readonly PdfEmbeddedAnnotation[]): Promise<readonly MnPdfAnnotation[]>
  add(detail: MnPdfAnnotateDetail, note?: { readonly text: string; readonly author: string }): Promise<PdfAnnotationWriteResult>
}

interface DocumentComment {
  readonly id?: string
  readonly text?: string
  readonly author?: string
  readonly blockId?: string
  readonly resolved?: boolean
}

interface CompanionRead {
  readonly root: Record<string, unknown>
  readonly comments: readonly DocumentComment[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = record(value)
  if (object) {
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function sha256(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('PDF annotations require Web Crypto SHA-256')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!)
}

function nodeText(node: Record<string, unknown>): string {
  const own = text(node.text)
  const children = Array.isArray(node.content) ? node.content : []
  return own + children.map(child => record(child) ? nodeText(record(child)!) : '').join('')
}

function rects(value: unknown): readonly MnPdfRect[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(candidate => {
    if (!Array.isArray(candidate) || candidate.length !== 4 || !candidate.every(number => typeof number === 'number')) return []
    return [[candidate[0], candidate[1], candidate[2], candidate[3]] as MnPdfRect]
  })
}

function selectorFrom(value: unknown): PdfSelector | null {
  const raw = typeof value === 'string' ? (() => {
    try { return JSON.parse(value) as unknown } catch { return null }
  })() : value
  const object = record(raw)
  if (!object) return null
  const page = Number(object.page)
  const artifactId = text(object.artifactId)
  const kind = text(object.kind)
  const source = text(object.source)
  if (!Number.isInteger(page) || page < 1 || !artifactId) return null
  if (kind !== 'highlight' && kind !== 'note') return null
  if (source !== 'reader' && source !== 'embedded') return null
  return {
    page,
    exact: text(object.exact),
    prefix: text(object.prefix),
    suffix: text(object.suffix),
    quads: rects(object.quads),
    color: text(object.color) || undefined,
    kind,
    source,
    artifactId,
    contentHash: text(object.contentHash) || undefined,
    importedId: text(object.importedId) || undefined,
  }
}

export class OrganismPdfAnnotationStore implements PdfAnnotationStore {
  readonly companionId: string

  constructor(
    private readonly mcp: PdfAnnotationMcp,
    private readonly identity: PdfCompanionIdentity,
  ) {
    this.companionId = `pdf-ann-${identity.artifactId}`
  }

  private _warnings: readonly string[] = []

  get warnings(): readonly string[] {
    return this._warnings
  }

  async load(embedded: readonly PdfEmbeddedAnnotation[] = []): Promise<readonly MnPdfAnnotation[]> {
    this._warnings = []
    const status = record(await this.mcp.callTool('check_document', {
      graphId: this.identity.graphId,
      documentId: this.companionId,
    }))
    const exists = text(status?.status) === 'exists'
    if (!exists && embedded.length === 0) return []
    if (embedded.length > 0) {
      const before = exists ? await this.readCompanion() : { root: {}, comments: [] }
      await this.importEmbedded(embedded, before)
    }
    const companion = await this.readCompanion()
    return this.project(companion)
  }

  async add(
    detail: MnPdfAnnotateDetail,
    note?: { readonly text: string; readonly author: string },
  ): Promise<PdfAnnotationWriteResult> {
    await this.ensureCompanion()
    const selector = await this.selectorFor(detail)
    const blockId = `block-pdf-${selector.contentHash!.slice(0, 32)}`
    const content = `<paragraph data-block-id="${xml(blockId)}" data-pdf-page="${selector.page}" data-pdf-selector="${xml(JSON.stringify(selector))}">${xml(selector.exact)}</paragraph>`
    await this.mcp.callTool('insert_blocks', {
      graphId: this.identity.graphId,
      documentId: this.companionId,
      content,
      format: 'xml',
    })
    if (note?.text.trim()) {
      const commentHash = await sha256({
        version: 1,
        companion: this.companionId,
        blockId,
        author: note.author,
        text: note.text,
      })
      await this.mcp.callTool('edit_comment', {
        graphId: this.identity.graphId,
        documentId: this.companionId,
        commentId: `pdf-comment-${commentHash.slice(0, 32)}`,
        action: 'set',
        text: note.text,
        author: note.author.trim() || 'You',
        blockId,
        find: selector.exact,
        quotedText: selector.exact,
        occurrence: 1,
      })
    }
    return { annotationId: blockId, annotations: await this.load() }
  }

  private async selectorFor(detail: MnPdfAnnotateDetail): Promise<PdfSelector> {
    const base = {
      version: 1,
      page: detail.pageNumber,
      exact: detail.exact,
      prefix: detail.prefix,
      suffix: detail.suffix,
      quads: detail.quads,
      kind: detail.mode,
      source: 'reader' as const,
      artifactId: this.identity.artifactId,
    }
    const contentHash = await sha256(base)
    return { ...base, contentHash }
  }

  private async importEmbedded(
    embedded: readonly PdfEmbeddedAnnotation[],
    before: CompanionRead,
  ): Promise<void> {
    const existing = new Map<string, { readonly selector: PdfSelector; readonly blockId: string }>()
    const tiptap = record(before.root.tiptapJson)
    const content = Array.isArray(tiptap?.content) ? tiptap.content : []
    for (const candidate of content) {
      const node = record(candidate)
      const attrs = record(node?.attrs)
      const selector = selectorFrom(attrs?.['data-pdf-selector'])
      const blockId = text(attrs?.['data-block-id']) || text(attrs?.blockId)
      if (selector?.importedId && blockId) existing.set(selector.importedId, { selector, blockId })
    }

    let ensured = false
    const ensure = async (): Promise<void> => {
      if (ensured) return
      await this.ensureCompanion()
      ensured = true
    }
    for (const annotation of embedded) {
      const fallbackId = annotation.id.trim()
        ? annotation.id.trim()
        : (await sha256({ version: 1, annotation })).slice(0, 32)
      const importedId = `pdf-embedded:v1:${this.identity.artifactId}:${fallbackId}`
      const contentHash = await sha256({
        version: 1,
        importedId,
        kind: annotation.kind,
        page: annotation.pageNumber,
        quote: annotation.quote,
        prefix: annotation.prefix,
        suffix: annotation.suffix,
        quads: annotation.rects,
        color: annotation.color,
        note: annotation.note ?? '',
        label: annotation.label ?? '',
      })
      const previous = existing.get(importedId)
      if (previous?.selector.contentHash === contentHash) {
        if (annotation.note?.trim() && !before.comments.some(comment =>
          comment.blockId === previous.blockId,
        )) {
          await ensure()
          await this.writeEmbeddedComment(annotation, previous.blockId)
        }
        continue
      }
      if (previous) {
        this._warnings = [...this._warnings,
          `Embedded annotation ${annotation.id || importedId} changed; the local annotation was left unchanged.`,
        ]
        continue
      }
      if (annotation.kind === 'highlight' && !annotation.quote) {
        this._warnings = [...this._warnings,
          `Page ${annotation.pageNumber} highlight has no recoverable quote; its geometry was imported without text.`,
        ]
      }
      const selector: PdfSelector = {
        page: annotation.pageNumber,
        exact: annotation.quote,
        prefix: annotation.prefix,
        suffix: annotation.suffix,
        quads: annotation.rects,
        color: annotation.color,
        kind: annotation.kind,
        source: 'embedded',
        artifactId: this.identity.artifactId,
        contentHash,
        importedId,
      }
      const blockHash = await sha256({ version: 1, importedId })
      const blockId = `block-pdf-${blockHash.slice(0, 32)}`
      const blockContent = `<paragraph data-block-id="${xml(blockId)}" data-pdf-page="${selector.page}" data-pdf-selector="${xml(JSON.stringify(selector))}">${xml(selector.exact)}</paragraph>`
      await ensure()
      await this.mcp.callTool('insert_blocks', {
        graphId: this.identity.graphId,
        documentId: this.companionId,
        content: blockContent,
        format: 'xml',
      })
      if (annotation.note?.trim()) await this.writeEmbeddedComment(annotation, blockId)
    }
  }

  private async writeEmbeddedComment(annotation: PdfEmbeddedAnnotation, blockId: string): Promise<void> {
    const note = annotation.note?.trim()
    if (!note) return
    const commentHash = await sha256({ version: 1, companion: this.companionId, blockId })
    const args: Record<string, unknown> = {
      graphId: this.identity.graphId,
      documentId: this.companionId,
      commentId: `pdf-comment-${commentHash.slice(0, 32)}`,
      action: 'set',
      text: annotation.note,
      author: annotation.label?.trim() || 'Imported PDF',
      blockId,
    }
    if (annotation.quote) {
      args.find = annotation.quote
      args.quotedText = annotation.quote
      args.occurrence = 1
    }
    await this.mcp.callTool('edit_comment', args)
  }

  private async ensureCompanion(): Promise<void> {
    const { graphId, artifactId, ingestedDocumentId, filename } = this.identity
    await this.mcp.callTool('create_document', {
      graphId,
      documentId: this.companionId,
      title: `PDF annotations — ${filename || artifactId}`,
      parentId: null,
    })
    const artifactWireId = await sha256({ version: 1, companion: this.companionId, targetArtifactId: artifactId, predicate: 'annotates' })
    const wires: Record<string, unknown>[] = [{
      wireId: `w-pdf-ann-${artifactWireId.slice(0, 24)}`,
      sourceDocumentId: this.companionId,
      targetArtifactId: artifactId,
      targetGraphId: graphId,
      predicate: 'annotates',
      bidirectional: false,
    }]
    if (ingestedDocumentId) {
      const documentWireId = await sha256({ version: 1, companion: this.companionId, targetDocumentId: ingestedDocumentId, predicate: 'annotates' })
      wires.push({
        wireId: `w-pdf-ann-${documentWireId.slice(0, 24)}`,
        sourceDocumentId: this.companionId,
        targetDocumentId: ingestedDocumentId,
        targetGraphId: graphId,
        predicate: 'annotates',
        bidirectional: false,
      })
    }
    await this.mcp.callTool('create_wires', { graphId, wires })
  }

  private async readCompanion(): Promise<CompanionRead> {
    let offset = 0
    let content = ''
    let comments: readonly DocumentComment[] = []
    while (true) {
      const page = record(await this.mcp.callTool('read_document', {
        graphId: this.identity.graphId,
        documentId: this.companionId,
        format: 'json',
        maxChars: 262144,
        offset,
      }))
      if (!page) throw new Error(`Could not read ${this.companionId}`)
      content += text(page.content)
      if (offset === 0 && Array.isArray(page.comments)) comments = page.comments as DocumentComment[]
      const next = page.nextOffset
      if (typeof next !== 'number' || next <= offset) break
      offset = next
    }
    const parsed = record(JSON.parse(content))
    if (!parsed) throw new Error(`Invalid JSON projection for ${this.companionId}`)
    return { root: parsed, comments }
  }

  private project(companion: CompanionRead): readonly MnPdfAnnotation[] {
    const tiptap = record(companion.root.tiptapJson)
    const content = Array.isArray(tiptap?.content) ? tiptap.content : []
    const annotations: MnPdfAnnotation[] = []
    for (const candidate of content) {
      const node = record(candidate)
      const attrs = record(node?.attrs)
      const selector = selectorFrom(attrs?.['data-pdf-selector'])
      const blockId = text(attrs?.['data-block-id']) || text(attrs?.blockId)
      if (!node || !selector || !blockId || selector.artifactId !== this.identity.artifactId) continue
      const comments = companion.comments.filter(item => item.blockId === blockId && item.resolved !== true)
      const authors = Array.from(new Set(comments.map(item => item.author?.trim()).filter((author): author is string => Boolean(author))))
      const note = comments.map(item => item.text?.trim()).filter((value): value is string => Boolean(value)).join('\n\n') || undefined
      annotations.push({
        id: blockId,
        pageNumber: selector.page,
        label: authors.join(', ') || (selector.source === 'embedded' ? 'Imported' : undefined),
        quote: selector.exact || nodeText(node),
        note,
        color: selector.color,
        kind: selector.kind,
        source: selector.source,
        rects: selector.quads,
      })
    }
    return annotations
  }
}
