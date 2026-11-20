/**
 * file-link.ts — the `[[path#L10-L20]]` link form, the editor's half (artifact step 3).
 *
 * A `[[` query that reads as a file path offers a link to lines (or a page) of that
 * file. On select the picker glue wires the block to the file through the cell's
 * create_wires `{ artifactPath, region }` form; the cell finds or makes the file's
 * record under the owner's allowed folders, refuses a region the file does not have,
 * and stores the region's text and hashes beside the wire. A click reads the region
 * now through read_artifact `{ wireId }`.
 *
 * Pure functions only: detection, region parsing, labels, the refusal's plain words,
 * and the popover's view of the cell's read.
 *
 * The UI parses only L<n>, L<n>-L<m>, L<n>-<m> and p<n>. Any other fragment (b100-200,
 * m:member, j:/pointer) passes to the cell untouched, which parses or refuses it.
 */

export type FileLinkRegion =
  | { readonly kind: 'lines'; readonly start: number; readonly end: number }
  | { readonly kind: 'page'; readonly page: number }
  | { readonly kind: 'other'; readonly fragment: string }

export interface FileLinkTarget {
  /** The path as typed, without the fragment. */
  readonly path: string
  /** The file's own name, for labels. */
  readonly fileName: string
  /** Absent: the whole file. */
  readonly region: FileLinkRegion | null
  /** The short form sent to the cell (L10-L20, p12, or the fragment as typed). */
  readonly regionShort: string | null
}

/** The picker row's id for the file candidate; never a real document id. */
export const FILE_LINK_CANDIDATE_PREFIX = 'file-link:'

const EXTENSION = /\.[A-Za-z0-9]{1,8}$/

/** Parse a fragment the UI understands; anything else is `other`, passed through. */
export function parseFileLinkRegion(fragment: string): FileLinkRegion | null {
  const value = fragment.trim()
  if (!value) return null
  const lines = /^L(\d+)(?:-L?(\d+))?$/i.exec(value)
  if (lines) {
    const start = Number(lines[1])
    const end = lines[2] === undefined ? start : Number(lines[2])
    if (start >= 1 && end >= start) return { kind: 'lines', start, end }
    return { kind: 'other', fragment: value }
  }
  const page = /^p(\d+)$/i.exec(value)
  if (page) {
    const n = Number(page[1])
    return n >= 1 ? { kind: 'page', page: n } : { kind: 'other', fragment: value }
  }
  return { kind: 'other', fragment: value }
}

export function regionShortForm(region: FileLinkRegion | null): string | null {
  if (!region) return null
  switch (region.kind) {
    case 'lines': return region.start === region.end ? `L${region.start}` : `L${region.start}-L${region.end}`
    case 'page': return `p${region.page}`
    case 'other': return region.fragment
  }
}

/**
 * Does this `[[` query read as a file path? It does when it starts with `/` or `~/`,
 * when it holds a `/` and a `#L…`/`#p…` fragment, or when it ends in a file extension
 * and carries a fragment. A trailing `]]` (typed in full) is ignored.
 */
export function detectFileLink(query: string): FileLinkTarget | null {
  const raw = query.trim().replace(/\]\]$/, '').trim()
  if (!raw) return null
  const hash = raw.indexOf('#')
  const path = (hash >= 0 ? raw.slice(0, hash) : raw).trim()
  const fragment = hash >= 0 ? raw.slice(hash + 1).trim() : ''
  if (!path) return null
  const absolute = path.startsWith('/') || path.startsWith('~/')
  const lineOrPage = /^(L\d|p\d)/i.test(fragment)
  const looksLikePath = absolute
    || (path.includes('/') && lineOrPage)
    || (EXTENSION.test(path) && fragment.length > 0)
  if (!looksLikePath) return null
  // A bare directory is not a file.
  if (path.endsWith('/')) return null
  const fileName = path.split('/').filter(Boolean).pop() ?? path
  const region = parseFileLinkRegion(fragment)
  return { path, fileName, region, regionShort: regionShortForm(region) }
}

/** "lines 10–20", "line 4", "page 12", or the fragment as typed. */
export function regionPhrase(region: FileLinkRegion | null): string | null {
  if (!region) return null
  switch (region.kind) {
    case 'lines': return region.start === region.end ? `line ${region.start}` : `lines ${region.start}–${region.end}`
    case 'page': return `page ${region.page}`
    case 'other': return region.fragment
  }
}

/** The picker row: "Link to lines 10–20 of notes.md", or "Link to notes.md". */
export function fileLinkCandidateLabel(target: FileLinkTarget): string {
  const phrase = regionPhrase(target.region)
  return phrase ? `Link to ${phrase} of ${target.fileName}` : `Link to ${target.fileName}`
}

/** The chip's words: "notes.md · lines 10–20", or the file name alone. */
export function fileLinkChipLabel(fileName: string, regionShort: string | null): string {
  const phrase = regionPhrase(regionShort ? parseFileLinkRegion(regionShort) : null)
  return phrase ? `${fileName} · ${phrase}` : fileName
}

/**
 * The cell's refusal, in plain words. The cell's own reason is kept when it is already
 * plain (it names the line count, for example); the known machine shapes are rephrased.
 */
export function fileLinkRefusalMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const message = raw.replace(/^MCP error for [a-z_]+:\s*/i, '').replace(/^wire \d+:\s*/i, '').replace(/;\s*no wires were created\.?$/i, '').trim()
  const lower = message.toLowerCase()
  if (/outside|not under|no root|allowed folder|roots?\b.*(not|no)|denied/.test(lower)) {
    return 'That file is outside the folders agents may link to. Add its folder in Settings → Files.'
  }
  if (/not found|no such file|does not exist|missing/.test(lower)) {
    return "That file can't be found. Check the path."
  }
  if (/has \d+ lines?/.test(lower)) {
    const lines = /has (\d+) lines?/.exec(lower)
    return lines ? `That file has only ${lines[1]} lines.` : message
  }
  if (/pdf-page|member|json pointer|json-pointer|wrong kind|not a pdf|not a zip/.test(lower)) {
    return "That part can't be linked in this kind of file."
  }
  return message ? `Couldn't link that file: ${message}` : "Couldn't link that file."
}

/** What the popover shows for one file link, read from the cell's read_artifact payload. */
export interface FileLinkReadView {
  /** The region's text now, capped; null when the cell gave none. */
  readonly text: string | null
  /** True when the text was cut at the popover's cap. */
  readonly truncated: boolean
  /** One plain sentence about how the lines stand, or null when nothing changed. */
  readonly status: string | null
  /** Set when the file itself can't be read (missing, outside the folders). */
  readonly error: string | null
  /** The lines the linked text moved to, when the cell found them in one place. */
  readonly movedTo: { readonly start: number; readonly end: number } | null
}

export const FILE_LINK_POPOVER_MAX_LINES = 40

export function fileLinkReadView(payload: unknown, maxLines = FILE_LINK_POPOVER_MAX_LINES): FileLinkReadView {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const rawText = typeof record.regionText === 'string' ? record.regionText : null
  let text: string | null = rawText
  let truncated = record.complete === false
  if (text !== null) {
    const lines = text.split('\n')
    if (lines.length > maxLines) {
      text = lines.slice(0, maxLines).join('\n')
      truncated = true
    }
  }
  const stale = record.stale && typeof record.stale === 'object' ? record.stale as Record<string, unknown> : null
  const reanchored = record.reanchored && typeof record.reanchored === 'object'
    ? record.reanchored as Record<string, unknown>
    : null
  const regionError = typeof record.regionError === 'string' ? record.regionError : null
  let status: string | null = null
  let movedTo: { start: number; end: number } | null = null
  if (record.anchorLost === true) {
    // The cell says anchorLost whenever the linked text appears nowhere, which
    // includes lines edited in place. Lines still there have changed; lines the
    // file no longer has are gone.
    status = rawText !== null && !regionError
      ? 'Changed since it was linked.'
      : "These lines can't be found any more."
  } else if (reanchored && typeof reanchored.start === 'number' && typeof reanchored.end === 'number') {
    movedTo = { start: reanchored.start, end: reanchored.end }
    status = reanchored.start === reanchored.end
      ? `Moved to line ${reanchored.start}.`
      : `Moved to lines ${reanchored.start}–${reanchored.end}.`
  } else if (record.ambiguous === true) {
    status = 'Changed since it was linked. The original lines now appear in more than one place.'
  } else if (stale?.region === true) {
    status = 'Changed since it was linked.'
  } else if (stale?.file === true) {
    status = 'The file changed since it was linked; these lines did not.'
  }
  return {
    text,
    truncated,
    status,
    error: regionError && rawText === null && record.anchorLost !== true ? fileLinkRefusalMessage(regionError) : null,
    movedTo,
  }
}

/** What the popover's pull button says and pulls, or null when it offers none. */
export interface FileLinkPullOffer {
  readonly label: string
  /** The region to pull: where the lines are now when they moved. Absent: the whole file. */
  readonly region: string | null
}

const PDF_PATH = /\.pdf$/i

/**
 * The popover offers to pull a link's lines into the document unless the link is
 * to a PDF (the cell has no page text to pull yet) or the read failed. Lines that
 * changed since linking pull as they read now, and the button says so; lines
 * that moved pull from where they are now.
 */
export function fileLinkPullOffer(input: {
  readonly region: string | null
  readonly filePath: string | null
  /** The chip's file name, for a link made by name (it has no path). */
  readonly fileName?: string | null
  readonly readError: string | null
  readonly status: string | null
  readonly movedTo: { readonly start: number; readonly end: number } | null
}): FileLinkPullOffer | null {
  if (input.readError) return null
  const parsed = input.region ? parseFileLinkRegion(input.region) : null
  if (parsed?.kind === 'page') return null
  if (input.region && /^page=/i.test(input.region)) return null
  if (input.filePath && PDF_PATH.test(input.filePath)) return null
  if (input.fileName && PDF_PATH.test(input.fileName)) return null
  if (!input.region) return { label: 'Pull this file into the document', region: null }
  if (input.movedTo) {
    const { start, end } = input.movedTo
    return { label: 'Pull these lines into the document', region: start === end ? `L${start}` : `L${start}-L${end}` }
  }
  if (input.status) return { label: 'Pull the lines as they are now', region: input.region }
  return { label: 'Pull these lines into the document', region: input.region }
}

/** The toast after a pull: lines for a line region, blocks otherwise. */
export function fileLinkPulledMessage(region: string | null, blockCount: number): string {
  const parsed = region ? parseFileLinkRegion(region) : null
  if (parsed?.kind === 'lines') {
    const n = parsed.end - parsed.start + 1
    return n === 1 ? 'Pulled 1 line' : `Pulled ${n} lines`
  }
  return blockCount === 1 ? 'Pulled 1 block' : `Pulled ${blockCount} blocks`
}

// ── Known files: the graph's own files, offered by name in the [[ picker ──────
//
// The files the Files settings page lists (attached, referenced, digested) are
// matched by name as the person types, below the document matches (Eschaton,
// 2026-11-11). `name#L10-L20` or `name#p12` carries a region; a bare name links
// the whole file. The record already exists, so the wire names it by id.

/** One file the graph keeps or links to, as the host lists it. */
export interface KnownFile {
  readonly id: string
  /** The name the Files page shows. */
  readonly name: string
  readonly fileName: string | null
  readonly fileType: string | null
  readonly mimeType: string | null
}

/** The host-side seam: the graph's files, read once per picker open. */
export interface KnownFilesSource {
  list(): Promise<readonly KnownFile[]>
}

/** The picker row's id for a known file: the prefix, the file's id, then `#region`. */
export const KNOWN_FILE_CANDIDATE_PREFIX = 'known-file:'

/** File rows shown under the document matches. */
export const KNOWN_FILE_ROW_LIMIT = 3

const KIND_PHRASES: Readonly<Record<string, string>> = {
  md: 'Markdown file',
  markdown: 'Markdown file',
  txt: 'Text file',
  pdf: 'PDF',
  epub: 'EPUB book',
  docx: 'Word document',
  html: 'Web page',
  htm: 'Web page',
  csv: 'Spreadsheet',
  json: 'JSON file',
  ipynb: 'Notebook',
}

function extensionOf(name: string | null): string | null {
  const match = name ? /\.([A-Za-z0-9]{1,8})$/.exec(name) : null
  return match ? match[1]!.toLowerCase() : null
}

/** The row's quiet kind: "Markdown file", "PDF", or "CSV file" for anything else. */
export function knownFileKindPhrase(file: Pick<KnownFile, 'fileType' | 'fileName' | 'name' | 'mimeType'>): string {
  const type = (file.fileType && file.fileType.toLowerCase() !== 'unknown' ? file.fileType.toLowerCase() : null)
    ?? extensionOf(file.fileName)
    ?? extensionOf(file.name)
    ?? (file.mimeType?.split('/')[1]?.split(/[+;]/)[0]?.toLowerCase() || null)
  if (!type || type === 'octet-stream') return 'File'
  return KIND_PHRASES[type] ?? `${type.toUpperCase()} file`
}

/** A `[[` query read as a file name plus an optional region. */
export interface KnownFileQuery {
  readonly name: string
  readonly region: FileLinkRegion | null
  readonly regionShort: string | null
}

export function splitKnownFileQuery(query: string): KnownFileQuery {
  const raw = query.trim().replace(/\]\]$/, '').trim()
  const hash = raw.indexOf('#')
  const name = (hash >= 0 ? raw.slice(0, hash) : raw).trim()
  const region = hash >= 0 ? parseFileLinkRegion(raw.slice(hash + 1)) : null
  return { name, region, regionShort: regionShortForm(region) }
}

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** 0: the whole name starts with the query; 1: a word does; null: no match. */
function matchRank(field: string | null, query: string): number | null {
  if (!field) return null
  const lower = field.toLowerCase()
  if (lower.startsWith(query)) return 0
  const queryWords = words(query)
  if (queryWords.length === 0) return null
  const fieldWords = words(field)
  // Every word of the query starts some word of the name, in any order.
  return queryWords.every(q => fieldWords.some(w => w.startsWith(q))) ? 1 : null
}

/** The files whose name or file name matches, best first, at most `limit`. */
export function matchKnownFiles(files: readonly KnownFile[], name: string, limit = KNOWN_FILE_ROW_LIMIT): KnownFile[] {
  const query = name.trim().toLowerCase()
  if (!query) return []
  const ranked: Array<{ file: KnownFile; rank: number }> = []
  for (const file of files) {
    const ranks = [matchRank(file.name, query), matchRank(file.fileName, query)].filter((r): r is number => r !== null)
    if (ranks.length) ranked.push({ file, rank: Math.min(...ranks) })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.file.name.localeCompare(b.file.name, undefined, { sensitivity: 'base', numeric: true }))
  return ranked.slice(0, limit).map(entry => entry.file)
}

/** A known-file picker row: its id carries the file's id and the region. */
export interface KnownFileRow {
  readonly id: string
  readonly label: string
  readonly detail: string
}

export function knownFileRows(files: readonly KnownFile[], query: string): KnownFileRow[] {
  const parsed = splitKnownFileQuery(query)
  return matchKnownFiles(files, parsed.name).map(file => {
    const phrase = regionPhrase(parsed.region)
    return {
      id: `${KNOWN_FILE_CANDIDATE_PREFIX}${file.id}${parsed.regionShort ? `#${parsed.regionShort}` : ''}`,
      label: phrase ? `Link to ${phrase} of ${file.name}` : file.name,
      detail: knownFileKindPhrase(file),
    }
  })
}

/** Read a known-file row's id back: the file's id and the region's short form. */
export function parseKnownFileCandidateId(id: string): { readonly fileId: string; readonly regionShort: string | null } | null {
  if (!id.startsWith(KNOWN_FILE_CANDIDATE_PREFIX)) return null
  const rest = id.slice(KNOWN_FILE_CANDIDATE_PREFIX.length)
  const hash = rest.indexOf('#')
  const fileId = hash >= 0 ? rest.slice(0, hash) : rest
  if (!fileId) return null
  return { fileId, regionShort: hash >= 0 ? rest.slice(hash + 1) || null : null }
}
