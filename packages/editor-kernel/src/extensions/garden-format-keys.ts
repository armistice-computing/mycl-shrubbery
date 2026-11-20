/**
 * Garden's own formatting keys, restored from Eschaton's cloud-1 set
 * (2026-10-14):
 *
 * - Mod-Shift-x: strikethrough, as Google Docs and Notion bind it. TipTap's
 *   own Mod-Shift-s stays bound.
 * - Mod-Shift-e: one key cycles a block's alignment, left → center → right.
 *   TextAlign's four keys are removed in base.ts: Mod-Shift-l belongs to
 *   read-aloud, and alignment is too rare to spend four keys on.
 */

import { Extension } from '@tiptap/core'

export const GardenFormatKeys = Extension.create({
  name: 'gardenFormatKeys',

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-x': () => this.editor.commands.toggleStrike(),
      'Mod-Shift-e': () => {
        const commands = this.editor.commands
        if (this.editor.isActive({ textAlign: 'center' })) return commands.setTextAlign('right')
        if (this.editor.isActive({ textAlign: 'right' })) return commands.unsetTextAlign()
        return commands.setTextAlign('center')
      },
    }
  },
})
