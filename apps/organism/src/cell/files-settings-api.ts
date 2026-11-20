/**
 * The Files page in Settings: the effects.
 *
 * - The list reads gardend's Files route, `GET /artifacts/{graph}`. An older
 *   gardend answers 404 or 405 there; the list then reads the workspace
 *   projection through the shell's SPARQL rest client instead.
 * - A row's state comes from `GET /artifacts/{graph}/{id}/status`, asked
 *   only when the list came from the route.
 * - Download goes through gardend's `/artifacts/{graph}/{id}/download`.
 *   There is no "open in the default app" command in gardend today, so the
 *   bytes are saved through the browser download path.
 * - The allowed folders go through the owner control plane,
 *   `GET/PUT /owner/graphs/{graph}/artifact-roots`, which answers 401 to
 *   anyone but the owner.
 */

import type { ShrubberyContract } from '@shrubbery/nucleus'
import type { KnownFile } from '@shrubbery/runtime'
import { gardendResponseError, saveBlob } from './document-transfer.js'
import {
  fileRecordFromRoute,
  fileRecordFromRow,
  fileRootsFrom,
  fileUsesFromRoute,
  fileUseFromRow,
  fileUsesSparql,
  filesListSparql,
  liveDocumentTitles,
  liveFileDocumentsSparql,
  type FileRecord,
  type FileRoot,
  type FileRootsReport,
  type FileUse,
  type FilesListRow,
  type FilesListSource,
} from './files-settings-model.js'
import type { SidebarDocumentRest } from './sidebar-documents.js'

export interface FilesListing {
  readonly records: readonly FileRecord[]
  readonly uses: readonly FileUse[]
  /** Absent means the projection. Only a route listing can ask for states. */
  readonly source?: FilesListSource
  /** Live documents that touch a file, by id, with titles; null when unread. */
  readonly live?: ReadonlyMap<string, string> | null
}

/** The owner's folder list could not be read because this viewer is not the owner. */
export class FileRootsNotOwnerError extends Error {
  constructor() {
    super('Only the owner of this graph can see and change these folders.')
    this.name = 'FileRootsNotOwnerError'
  }
}

/** Matched by name, not by class: two copies of this module can be loaded. */
export function isFileRootsNotOwnerError(error: unknown): boolean {
  return error instanceof Error ? error.name === 'FileRootsNotOwnerError' : false
}

export interface FilesSettingsApi {
  listFiles(): Promise<FilesListing>
  /** The status route's state word for one file, or null when it can't say. */
  fileState(id: string): Promise<string | null>
  getRoots(): Promise<FileRootsReport>
  setRoots(roots: readonly FileRoot[]): Promise<FileRootsReport>
  download(row: Pick<FilesListRow, 'id' | 'filename'>): Promise<void>
  /**
   * Removes a file from the graph and deletes its stored original. A
   * document imported from it stays; only its Original view goes.
   */
  remove(row: Pick<FilesListRow, 'id' | 'name'>): Promise<void>
}

export interface GardendFilesSettingsApiOptions {
  readonly rest: SidebarDocumentRest
  readonly contract: Pick<ShrubberyContract, 'auth' | 'runtime'>
  readonly graphId: string
  readonly fetch?: typeof fetch
  readonly save?: (blob: Blob, filename: string) => void
}

interface QueryResult {
  readonly rows?: ReadonlyArray<Record<string, string>>
}

export class GardendFilesSettingsApi implements FilesSettingsApi {
  private readonly fetchImpl: typeof fetch
  private readonly save: (blob: Blob, filename: string) => void

  constructor(private readonly options: GardendFilesSettingsApiOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.save = options.save ?? ((blob, filename) => saveBlob(blob, filename))
  }

  async listFiles(): Promise<FilesListing> {
    const response = await this.fetchImpl(this.filesUrl(), { headers: this.headers(), cache: 'no-store' })
    if (response.status === 404 || response.status === 405) return this.listFromProjection()
    if (!response.ok) throw new Error(await gardendResponseError(response, 'Could not read the files.'))
    const body = await response.json() as { artifacts?: unknown }
    const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : []
    return {
      records: artifacts.map(fileRecordFromRoute).filter((value): value is FileRecord => value !== null),
      uses: artifacts.flatMap(fileUsesFromRoute),
      source: 'route',
      live: await this.liveDocuments(),
    }
  }

  /**
   * The records alone, with no uses and no titles: what the [[ picker matches by
   * name. Same route and the same projection fallback as listFiles, without its
   * two extra reads.
   */
  async listRecords(): Promise<FileRecord[]> {
    const response = await this.fetchImpl(this.filesUrl(), { headers: this.headers(), cache: 'no-store' })
    if (response.status === 404 || response.status === 405) {
      const { rest, graphId } = this.options
      const list = await rest.query(graphId, filesListSparql(graphId)) as QueryResult
      return (list.rows ?? []).map(fileRecordFromRow).filter((value): value is FileRecord => value !== null)
    }
    if (!response.ok) throw new Error(await gardendResponseError(response, 'Could not read the files.'))
    const body = await response.json() as { artifacts?: unknown }
    const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : []
    return artifacts.map(fileRecordFromRoute).filter((value): value is FileRecord => value !== null)
  }

  /** Null when the projection can't be read: the rows then count every use. */
  private async liveDocuments(): Promise<Map<string, string> | null> {
    const { rest, graphId } = this.options
    try {
      const result = await rest.query(graphId, liveFileDocumentsSparql(graphId)) as QueryResult
      return liveDocumentTitles(result.rows ?? [])
    } catch {
      return null
    }
  }

  async fileState(id: string): Promise<string | null> {
    const response = await this.fetchImpl(`${this.filesUrl()}/${encodeURIComponent(id)}/status`, {
      headers: this.headers(),
      cache: 'no-store',
    })
    if (!response.ok) return null
    const body = await response.json() as { state?: unknown }
    return typeof body?.state === 'string' ? body.state : null
  }

  private async listFromProjection(): Promise<FilesListing> {
    const { rest, graphId } = this.options
    const [list, uses, live] = await Promise.all([
      rest.query(graphId, filesListSparql(graphId)) as Promise<QueryResult>,
      rest.query(graphId, fileUsesSparql(graphId)) as Promise<QueryResult>,
      this.liveDocuments(),
    ])
    return {
      records: (list.rows ?? []).map(fileRecordFromRow).filter((value): value is FileRecord => value !== null),
      uses: (uses.rows ?? []).map(fileUseFromRow).filter((value): value is FileUse => value !== null),
      source: 'projection',
      live,
    }
  }

  async getRoots(): Promise<FileRootsReport> {
    const response = await this.fetchImpl(this.rootsUrl(), { headers: this.headers(), cache: 'no-store' })
    return this.rootsResponse(response, 'Could not read the allowed folders.')
  }

  async setRoots(roots: readonly FileRoot[]): Promise<FileRootsReport> {
    const response = await this.fetchImpl(this.rootsUrl(), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roots: roots.map(root => ({ path: root.path, recursive: root.recursive, includeHidden: root.includeHidden })),
      }),
    })
    return this.rootsResponse(response, 'Could not save the allowed folders.')
  }

  async download(row: Pick<FilesListRow, 'id' | 'filename'>): Promise<void> {
    const { graphId } = this.options
    const url = `${this.base()}/artifacts/${encodeURIComponent(graphId)}/${encodeURIComponent(row.id)}/download`
    const response = await this.fetchImpl(url, { headers: this.headers(), cache: 'no-store' })
    if (!response.ok) throw new Error(await gardendResponseError(response, `Could not read ${row.filename}.`))
    this.save(await response.blob(), row.filename)
  }

  async remove(row: Pick<FilesListRow, 'id' | 'name'>): Promise<void> {
    const { graphId } = this.options
    const url = `${this.base()}/navigation/${encodeURIComponent(graphId)}/artifacts/${encodeURIComponent(row.id)}`
    const response = await this.fetchImpl(url, { method: 'DELETE', headers: this.headers() })
    if (!response.ok) throw new Error(await gardendResponseError(response, `Couldn't remove ${row.name}.`))
  }

  private async rootsResponse(response: Response, fallback: string): Promise<FileRootsReport> {
    if (response.status === 401 || response.status === 403) throw new FileRootsNotOwnerError()
    if (!response.ok) throw new Error(await gardendResponseError(response, fallback))
    return fileRootsFrom(await response.json())
  }

  private base(): string {
    return this.options.contract.runtime.graphBaseUrl(this.options.graphId).replace(/\/+$/, '')
  }

  private filesUrl(): string {
    return `${this.base()}/artifacts/${encodeURIComponent(this.options.graphId)}`
  }

  private rootsUrl(): string {
    return `${this.base()}/owner/graphs/${encodeURIComponent(this.options.graphId)}/artifact-roots`
  }

  private headers(): Record<string, string> {
    const { auth } = this.options.contract
    const headers: Record<string, string> = { 'X-User-ID': auth.userId() }
    const token = auth.token()
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }
}

/**
 * The [[ picker's view of the graph's files, through the Files page's own read.
 * A failed read is no files: the picker shows no file rows and no error.
 */
export function knownFilesFromFilesApi(api: Pick<GardendFilesSettingsApi, 'listRecords'>): { list(): Promise<KnownFile[]> } {
  return {
    async list() {
      try {
        const records = await api.listRecords()
        return records.map(record => ({
          id: record.id,
          name: record.label,
          fileName: record.originalFilename,
          fileType: record.fileType,
          mimeType: record.mimeType,
        }))
      } catch {
        return []
      }
    },
  }
}
