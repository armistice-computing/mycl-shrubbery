/**
 * Who an Escape press belongs to.
 *
 * A running import listens for Escape on the window. Before Friction Triage
 * 2026-11-16 (item 9) it cancelled on ANY Escape, including the one that
 * closed a menu, the picker or a dialog. An import may take an Escape only
 * when nothing else is open and the key didn't come from the editor or a
 * text field, where Escape already means something.
 */

export interface EscapeContext {
  /** The Settings overlay, the quick-wire pin and the like, open right now. */
  readonly overlayOpen: boolean
  readonly doc?: Document
}

const CLAIMING_ORIGINS =
  '.ProseMirror, input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]'

export function escapeIsClaimedElsewhere(event: Event, context: EscapeContext): boolean {
  if (context.overlayOpen) return true
  const doc = context.doc ?? document
  if (doc.querySelector('dialog[open], [aria-modal="true"]:not([hidden])')) return true
  const origin = event.composedPath()[0]
  return origin instanceof Element && origin.closest(CLAIMING_ORIGINS) !== null
}
