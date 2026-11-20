import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALL_EDITOR_SHORTCUTS, EDITOR_SHORTCUTS } from '../shortcut-catalog.js'

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const EXTENSIONS = resolve(PACKAGES, 'editor-kernel/src/extensions')

/**
 * Modifier keys an extension binds that the page deliberately leaves out,
 * each with its reason. Anything else bound must be in the catalog.
 */
const UNDOCUMENTED = new Map([
  ['Mod-a', 'select all: the platform key, listed from the menu command'],
  ['Shift-ArrowUp', 'extends a block selection: part of "Select the block"'],
  ['Shift-ArrowDown', 'extends a block selection: part of "Select the block"'],
  ['Shift-Enter', 'a soft break in a list item: listed as "Line break inside a block"'],
])

describe('EDITOR_SHORTCUTS', () => {
  it('names each binding where its source still binds it', () => {
    const missing: string[] = []
    for (const entry of ALL_EDITOR_SHORTCUTS) {
      if (!entry.source || !entry.binding) continue
      const text = readFileSync(resolve(PACKAGES, entry.source), 'utf8')
      const bound = text.includes(`'${entry.binding}'`)
        || text.includes(`"${entry.binding}"`)
        || new RegExp(`\\b${entry.binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(text)
        // A code fragment (a handler call) rather than a key string.
        || (/[ (]/.test(entry.binding) ? text.includes(entry.binding) : false)
      if (!bound) missing.push(`${entry.id}: ${entry.binding} in ${entry.source}`)
    }
    expect(missing).toEqual([])
  })

  it('lists every modifier key an editor extension binds', () => {
    const listed = new Set(ALL_EDITOR_SHORTCUTS.map(entry => entry.binding).filter(Boolean))
    const unlisted: string[] = []
    for (const file of readdirSync(EXTENSIONS).filter(name => name.endsWith('.ts'))) {
      const text = readFileSync(resolve(EXTENSIONS, file), 'utf8')
      for (const match of text.matchAll(/'((?:Mod|Shift|Alt|Ctrl)-[^']+)'\s*:/g)) {
        const key = match[1]!
        if (!listed.has(key) && !UNDOCUMENTED.has(key)) unlisted.push(`${key} (${file})`)
      }
    }
    expect(unlisted).toEqual([])
  })

  it('leaves the held-back citation key off the page', () => {
    expect(EDITOR_SHORTCUTS.some(entry => entry.id === 'editor.citation')).toBe(false)
    expect(ALL_EDITOR_SHORTCUTS.some(entry => entry.id === 'editor.citation')).toBe(true)
  })

  it('has unique ids and no shortcut listed twice', () => {
    expect(new Set(EDITOR_SHORTCUTS.map(entry => entry.id)).size).toBe(EDITOR_SHORTCUTS.length)
    const shortcuts = EDITOR_SHORTCUTS.map(entry => entry.shortcut.toLowerCase())
    expect(shortcuts.filter((value, index) => shortcuts.indexOf(value) !== index)).toEqual([])
  })
})
