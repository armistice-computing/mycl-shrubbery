/**
 * The Files page in Settings: the read model.
 *
 * A file here is a workspace artifact record (gardend writes it with
 * `workspace.putArtifact`). The page never says "artifact": a person sees files.
 *
 * Two sources, in order:
 *   1. gardend's Files route, `GET /artifacts/{graph}` (artifact_storage.rs
 *      artifact_list_with_pointers): the navigation record plus `wireCount`
 *      and `documentIds`. Its first call per graph backfills older records,
 *      so their mode and size are filled in. "Used by" is documentIds.
 *      Each row's state comes later from `GET /artifacts/{graph}/{id}/status`.
 *   2. An older gardend has no such route (404 or 405). The page then reads
 *      the workspace projection, as below, and asks for no states.
 *
 * Shapes, as the projection writes them (rdf_workspace_entity_triples.rs):
 *   - name:  nfo:fileName (the record's label)
 *   - kind:  doc:fileType, else the mime subtype, else doc:kind
 *   - mode:  doc:mode (attached, referenced, digested); older records lack it
 *   - size:  nfo:fileSize (the record's sizeBytes)
 *   - state: doc:status; "ready" is the quiet default and shows nothing
 *
 * "Used by" counts distinct documents that point at the file: the source
 * document of a wire whose wire:targetArtifact is the file, the document the
 * record names in doc:ingestedDocId, and a document whose
 * doc:sourceStorageKey equals the record's doc:storageKey. The projection has
 * no wire:sourceArtifact, so a wire from a file is not counted.
 *
 * Only documents that still exist count. An older delete left its file
 * behind with the dead document's id (seen on default_x1: two originals
 * pointed at documents gone from the workspace), so `liveFileDocumentsSparql`
 * names the live documents that touch a file, with their titles, and the
 * rows drop every other id. A file a live document was made from is that
 * document's original, and says so.
 *
 * Pure functions only. Effects live in files-settings-api.ts.
 */

import { workspaceProjectionGraphIri } from '@shrubbery/runtime'
import {
  bareWorkspaceId,
  isPdfAnnotationCompanionDocumentId,
  optionalNumber,
  unquoteLiteral,
} from './sidebar-documents.js'

export type FileMode = 'attached' | 'referenced' | 'digested'

/** Where a listing came from (see the header). */
export type FilesListSource = 'route' | 'projection'

export interface FileRecord {
  readonly id: string
  readonly label: string
  readonly originalFilename: string | null
  readonly fileType: string | null
  readonly mimeType: string | null
  readonly kind: string | null
  readonly mode: FileMode | null
  readonly sizeBytes: number | null
  readonly status: string | null
  /** The document this file was made into (doc:ingestedDocId), if any. */
  readonly originOf: string | null
}

/** One document that points at one file. */
export interface FileUse {
  readonly fileId: string
  readonly documentId: string
}

export interface FilesListRow {
  readonly id: string
  readonly name: string
  /** The name to save the bytes under. */
  readonly filename: string
  readonly kind: string
  readonly mode: string
  readonly size: string
  readonly usedBy: number
  readonly usedByLabel: string
  /** The live document this file is the original of; usedByLabel then reads "Original of <title>". */
  readonly origin: { readonly documentId: string; readonly title: string } | null
  /** Empty when the backend reports nothing worth saying. */
  readonly state: string
}

/** One folder agents may link to (gardend artifact_roots.rs, camelCase). */
export interface FileRoot {
  readonly path: string
  readonly recursive: boolean
  readonly includeHidden: boolean
}

export interface FileRootsReport {
  readonly roots: readonly FileRoot[]
  /** Why the stored list could not be read, when gardend says so. */
  readonly fileError: string | null
}

const PREFIXES = [
  'PREFIX doc: <http://mnemosyne.dev/doc#>',
  'PREFIX nfo: <http://www.semanticdesktop.org/ontologies/2007/03/22/nfo#>',
  'PREFIX nie: <http://www.semanticdesktop.org/ontologies/2007/01/19/nie#>',
  'PREFIX wire: <http://mnemosyne.ai/vocab#>',
  'PREFIX dcterms: <http://purl.org/dc/terms/>',
]

export function filesListSparql(graphId: string): string {
  const ws = workspaceProjectionGraphIri(graphId)
  return [
    ...PREFIXES,
    'SELECT ?artifact ?label ?originalFilename ?fileType ?mimeType ?kind ?mode ?size ?status ?ingested',
    `WHERE { GRAPH <${ws}> {`,
    '  ?artifact a doc:Artifact .',
    '  OPTIONAL { ?artifact nfo:fileName ?label }',
    '  OPTIONAL { ?artifact doc:originalFilename ?originalFilename }',
    '  OPTIONAL { ?artifact doc:fileType ?fileType }',
    '  OPTIONAL { ?artifact nie:mimeType ?mimeType }',
    '  OPTIONAL { ?artifact doc:kind ?kind }',
    '  OPTIONAL { ?artifact doc:mode ?mode }',
    '  OPTIONAL { ?artifact nfo:fileSize ?size }',
    '  OPTIONAL { ?artifact doc:status ?status }',
    '  OPTIONAL { ?artifact doc:ingestedDocId ?ingested }',
    '} }',
  ].join('\n')
}

export function fileUsesSparql(graphId: string): string {
  const ws = workspaceProjectionGraphIri(graphId)
  return [
    ...PREFIXES,
    'SELECT DISTINCT ?artifact ?doc',
    `WHERE { GRAPH <${ws}> {`,
    '  ?artifact a doc:Artifact .',
    '  {',
    '    ?wire a wire:Wire ; wire:targetArtifact ?artifact ; wire:sourceDocument ?doc .',
    '  } UNION {',
    '    ?artifact doc:ingestedDocId ?doc .',
    '  } UNION {',
    '    ?artifact doc:storageKey ?key .',
    '    ?doc doc:sourceStorageKey ?key .',
    '  }',
    '} }',
  ].join('\n')
}

/** The live documents that touch any file, with their titles. */
export function liveFileDocumentsSparql(graphId: string): string {
  const ws = workspaceProjectionGraphIri(graphId)
  return [
    ...PREFIXES,
    'SELECT DISTINCT ?doc ?title',
    `WHERE { GRAPH <${ws}> {`,
    '  ?artifact a doc:Artifact .',
    '  {',
    '    ?wire a wire:Wire ; wire:targetArtifact ?artifact ; wire:sourceDocument ?doc .',
    '  } UNION {',
    '    ?artifact doc:ingestedDocId ?doc .',
    '  } UNION {',
    '    ?artifact doc:storageKey ?key .',
    '    ?doc doc:sourceStorageKey ?key .',
    '  }',
    '  ?doc a doc:TipTapDocument .',
    '  OPTIONAL { ?doc dcterms:title ?title }',
    '} }',
  ].join('\n')
}

/** Live document id → title (an untitled document maps to "Untitled"). */
export function liveDocumentTitles(rows: ReadonlyArray<Record<string, string>>): Map<string, string> {
  const titles = new Map<string, string>()
  for (const row of rows) {
    const id = row.doc ? bareWorkspaceId(row.doc, 'document') : null
    if (!id) continue
    titles.set(id, text(row.title) ?? titles.get(id) ?? 'Untitled')
  }
  return titles
}

function documentIdFrom(value: string | null): string | null {
  if (!value) return null
  return value.includes(':') ? bareWorkspaceId(value, 'document') : value
}

function text(term: string | undefined): string | null {
  if (!term) return null
  const value = unquoteLiteral(term).trim()
  return value || null
}

export function fileModeFrom(value: string | null | undefined): FileMode | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'attached':
    case 'attach':
      return 'attached'
    case 'referenced':
    case 'reference':
      return 'referenced'
    case 'digested':
    case 'digest':
    case 'ingested':
      return 'digested'
    default:
      return null
  }
}

export function fileRecordFromRow(row: Record<string, string>): FileRecord | null {
  const id = row.artifact ? bareWorkspaceId(row.artifact, 'artifact') : null
  if (!id) return null
  const size = optionalNumber(row.size)
  return {
    id,
    label: text(row.label) ?? text(row.originalFilename) ?? id,
    originalFilename: text(row.originalFilename),
    fileType: text(row.fileType),
    mimeType: text(row.mimeType),
    kind: text(row.kind),
    mode: fileModeFrom(text(row.mode)),
    sizeBytes: size === undefined || size < 0 ? null : size,
    status: text(row.status),
    originOf: row.ingested ? bareWorkspaceId(row.ingested, 'document') : null,
  }
}

function routeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function routeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** One record from gardend's Files route. */
export function fileRecordFromRoute(value: unknown): FileRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = routeText(record.id) ?? routeText(record.artifactId)
  if (!id) return null
  const index = record.index && typeof record.index === 'object' ? record.index as Record<string, unknown> : {}
  return {
    id,
    label: routeText(record.label) ?? routeText(index.title) ?? routeText(record.originalFilename) ?? id,
    originalFilename: routeText(record.originalFilename),
    fileType: routeText(record.fileType),
    mimeType: routeText(record.mimeType),
    kind: routeText(index.kind),
    mode: fileModeFrom(routeText(record.mode)),
    sizeBytes: routeNumber(record.sizeBytes) ?? routeNumber(index.sizeBytes),
    status: routeText(record.status),
    originOf: documentIdFrom(routeText(record.ingestedDocId)),
  }
}

/** The documents the Files route says point at one record. */
export function fileUsesFromRoute(value: unknown): FileUse[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const fileId = routeText(record.id) ?? routeText(record.artifactId)
  if (!fileId || !Array.isArray(record.documentIds)) return []
  return record.documentIds
    .map(routeText)
    .filter((documentId): documentId is string => documentId !== null)
    .map(documentId => ({ fileId, documentId }))
}

/**
 * The status route's word for a file, said plainly. "ok" says nothing; an
 * unknown word says nothing rather than guess.
 */
export function fileStatusLabel(state: string | null | undefined): string {
  switch ((state ?? '').trim().toLowerCase()) {
    case 'stale': return 'Changed since it was added'
    case 'missing': return 'Missing'
    case 'denied': return 'Outside the allowed folders'
    default: return ''
  }
}

export function fileUseFromRow(row: Record<string, string>): FileUse | null {
  const fileId = row.artifact ? bareWorkspaceId(row.artifact, 'artifact') : null
  const documentId = row.doc ? bareWorkspaceId(row.doc, 'document') : null
  if (!fileId || !documentId) return null
  return { fileId, documentId }
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/** Decimal units, as the Finder counts them. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return bytes === 1 ? '1 byte' : `${Math.round(bytes)} bytes`
  let value = bytes
  let unit = -1
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const shown = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '')
  return `${shown} ${SIZE_UNITS[unit]}`
}

export function fileModeLabel(mode: FileMode | null): string {
  switch (mode) {
    case 'attached': return 'Attached'
    case 'referenced': return 'Referenced'
    case 'digested': return 'Digested'
    default: return '—'
  }
}

export function fileKindLabel(record: Pick<FileRecord, 'fileType' | 'mimeType' | 'kind'>): string {
  // Older records store fileType "unknown"; that is no kind at all.
  const fileType = record.fileType?.trim()
  if (fileType && fileType.toLowerCase() !== 'unknown') return fileType.toUpperCase()
  const subtype = record.mimeType?.split('/')[1]?.split(/[+;]/)[0]?.trim()
  if (subtype && subtype !== 'octet-stream') return subtype.toUpperCase()
  const kind = record.kind?.trim()
  if (kind) return kind.charAt(0).toUpperCase() + kind.slice(1)
  return '—'
}

/** The backend's word for a file's state, said plainly. "ready" says nothing. */
export function fileStateLabel(status: string | null | undefined): string {
  const value = (status ?? '').trim().toLowerCase()
  switch (value) {
    case '':
    case 'ready':
      return ''
    case 'uploading': return 'Uploading'
    case 'processing':
    case 'ingesting':
      return 'Processing'
    case 'error':
    case 'failed':
      return 'Failed'
    case 'missing': return 'Missing'
    case 'stale':
    case 'changed':
      return 'Changed since it was added'
    default:
      return value.charAt(0).toUpperCase() + value.slice(1).replace(/[-_]+/g, ' ')
  }
}

export function usedByLabel(count: number): string {
  if (count === 0) return 'Not used'
  return count === 1 ? 'Used by 1 document' : `Used by ${count} documents`
}

/**
 * `live` maps each still-existing document to its title. Without it (the
 * titles could not be read) every use counts and no row names an original.
 */
export function filesListRows(
  records: readonly FileRecord[],
  uses: readonly FileUse[],
  live: ReadonlyMap<string, string> | null = null,
): FilesListRow[] {
  const documentsByFile = new Map<string, Set<string>>()
  for (const use of uses) {
    if (isPdfAnnotationCompanionDocumentId(use.documentId)) continue
    if (live && !live.has(use.documentId)) continue
    const set = documentsByFile.get(use.fileId) ?? new Set<string>()
    set.add(use.documentId)
    documentsByFile.set(use.fileId, set)
  }
  const seen = new Set<string>()
  const rows: FilesListRow[] = []
  for (const record of records) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    const usedBy = documentsByFile.get(record.id)?.size ?? 0
    const originTitle = live && record.originOf ? live.get(record.originOf) : undefined
    const origin = record.originOf && originTitle !== undefined
      ? { documentId: record.originOf, title: originTitle }
      : null
    rows.push({
      id: record.id,
      name: record.label,
      filename: record.originalFilename ?? record.label,
      kind: fileKindLabel(record),
      mode: fileModeLabel(record.mode),
      size: formatFileSize(record.sizeBytes),
      usedBy,
      usedByLabel: origin ? `Original of ${origin.title}` : usedByLabel(usedBy),
      origin,
      state: fileStateLabel(record.status),
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    || a.id.localeCompare(b.id))
}

export function fileRootsFrom(value: unknown): FileRootsReport {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawRoots = Array.isArray(record.roots) ? record.roots : []
  const roots: FileRoot[] = []
  for (const entry of rawRoots) {
    if (!entry || typeof entry !== 'object') continue
    const root = entry as Record<string, unknown>
    const path = typeof root.path === 'string' ? root.path.trim() : ''
    if (!path) continue
    roots.push({
      path,
      recursive: root.recursive !== false,
      includeHidden: root.includeHidden === true,
    })
  }
  const fileError = typeof record.fileError === 'string' && record.fileError.trim() ? record.fileError.trim() : null
  return { roots, fileError }
}

/** The list with one more folder; a folder already there is not added twice. */
export function rootsWith(roots: readonly FileRoot[], path: string): FileRoot[] {
  const trimmedPath = path.trim()
  if (!trimmedPath || roots.some(root => root.path === trimmedPath)) return [...roots]
  return [...roots, { path: trimmedPath, recursive: true, includeHidden: false }]
}

export function rootsWithout(roots: readonly FileRoot[], path: string): FileRoot[] {
  return roots.filter(root => root.path !== path)
}
