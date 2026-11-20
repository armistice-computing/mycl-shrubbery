/**
 * Features the first release holds back without removing them.
 *
 * TAGS_ENABLED: tags wait for their rework (Eschaton, 2026-11-17; the plan is
 * in her 11/2 daily note: tags become block-level clusters that live beside
 * wires). While off, typing #word makes no tag, the # picker never opens and
 * the sidebar has no Tags section. Tags already in documents still render,
 * and no data is touched. Turn this on with the rework.
 */
export const TAGS_ENABLED = false

/**
 * SLASH_COMMANDS_ENABLED: the / menu waits too (Eschaton, 2026-11-17: the
 * markdown shortcuts, the toolbar and paste make the same blocks more
 * plainly). While off, typing / is just a slash. Turn it on if the menu
 * comes back reworked.
 */
export const SLASH_COMMANDS_ENABLED = false

/**
 * SYNC_FEATURES_ENABLED: what only means something with a remote copy waits
 * for sync (Eschaton, 2026-11-17 and 11-18). The offline app has no remote
 * copy, so these only confused. While off:
 * - the sidebar's "Parked work" section isn't drawn (nothing stored is
 *   touched);
 * - the editor toolbar's document-state lines say what is true offline
 *   ("This document was deleted", "Not saved · Keep this window open")
 *   instead of the remote wording ("Deleted remotely · Local recovery
 *   saved", "Reconnect before closing"). Both sets live in
 *   mn-editor-toolbar.ts renderReadOnlyToolbar;
 * - the desktop app's Settings has no Account page (Eschaton, 2026-11-18):
 *   offline there is no account, only this computer's profile.
 *   settings-service.ts drops it (a hosted cell keeps it for sign-in), and
 *   the settings page opens on the first page that remains.
 * Turn this on with sync.
 */
export const SYNC_FEATURES_ENABLED = false

/**
 * IMAGE_GENERATION_ENABLED: the image editor's "Describe an image edit to
 * generate" bar waits (Eschaton, 2026-11-18: "we don't need image
 * generation"). It sent the image to OpenRouter with a key kept in Settings,
 * and Settings no longer offers that key. While off, the bar isn't drawn;
 * drawing, cropping and saving a version still work.
 */
export const IMAGE_GENERATION_ENABLED = false

/**
 * VAULT_IMPORT_ENABLED: bringing in a whole vault (Door 1). The person
 * chooses a folder or a .zip in a native chooser, the app scans it and shows
 * what an import would make, and Import writes it into a NEW graph (the
 * commit step landed 2026-11-19). On for 0.1.0 (Eschaton, 2026-11-20).
 * While off, the import dialog has no vault choice.
 */
export const VAULT_IMPORT_ENABLED = true

/**
 * CITATIONS_ENABLED: making citations waits for Zotero support (Eschaton,
 * 2026-11-18). While off, the editor toolbar has no Citation button, ⌘⇧C
 * does nothing, and the Keyboard Shortcuts page doesn't list it. Citations
 * already in documents still render and open. Turn this on with Zotero.
 */
export const CITATIONS_ENABLED = false
