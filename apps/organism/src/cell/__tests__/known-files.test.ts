import { describe, expect, it } from 'vitest'
import { knownFilesFromFilesApi } from '../files-settings-api.js'
import type { FileRecord } from '../files-settings-model.js'

const record = (over: Partial<FileRecord>): FileRecord => ({
  id: 'artifact-1',
  label: 'notes.md',
  originalFilename: 'notes.md',
  fileType: 'md',
  mimeType: 'text/markdown',
  kind: null,
  mode: 'attached',
  sizeBytes: 12,
  status: 'ready',
  originOf: null,
  ...over,
})

describe('the [[ picker\'s view of the graph\'s files', () => {
  it('maps the Files page records to name, file name and type', async () => {
    const source = knownFilesFromFilesApi({ listRecords: async () => [record({}), record({ id: 'artifact-2', label: 'Field notes', originalFilename: 'field.pdf', fileType: 'pdf', mimeType: 'application/pdf' })] })
    expect(await source.list()).toEqual([
      { id: 'artifact-1', name: 'notes.md', fileName: 'notes.md', fileType: 'md', mimeType: 'text/markdown' },
      { id: 'artifact-2', name: 'Field notes', fileName: 'field.pdf', fileType: 'pdf', mimeType: 'application/pdf' },
    ])
  })

  it('is no files, not an error, when the read fails', async () => {
    const source = knownFilesFromFilesApi({ listRecords: async () => { throw new Error('HTTP 500') } })
    expect(await source.list()).toEqual([])
  })
})
