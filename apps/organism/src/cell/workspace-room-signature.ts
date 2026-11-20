/**
 * What the file list shows, read from the cell's workspace room: the
 * `documents` and `folders` maps' ids, titles, folders, sections and
 * read-only flags.
 *
 * Not `order` or `updatedAt`: every content write moves those, and keying on
 * them made each pause in typing re-read the whole list. A reorder alone
 * therefore does not refresh the list live (2026-10-09).
 */

export interface WorkspaceRoomMaps {
  getMap(name: string): { toJSON(): Record<string, unknown> }
}

function field(value: unknown, key: string): string {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const raw = record[key]
  return raw === undefined || raw === null ? '' : String(raw)
}

export function workspaceRoomSignature(doc: WorkspaceRoomMaps): string {
  const documents = Object.entries(doc.getMap('documents').toJSON())
    .map(([id, value]) => [id, field(value, 'title'), field(value, 'parentId'), field(value, 'section'), field(value, 'readOnly')].join('\u0000'))
  const folders = Object.entries(doc.getMap('folders').toJSON())
    .map(([id, value]) => [id, field(value, 'name'), field(value, 'parentId'), field(value, 'section')].join('\u0000'))
  return [...documents.sort(), '\u0001', ...folders.sort()].join('\u0002')
}
