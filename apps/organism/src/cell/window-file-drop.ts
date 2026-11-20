/**
 * Files dropped outside the page's own drop targets.
 *
 * The desktop window no longer keeps Tauri's drop handler (garden db05030),
 * so a Finder file dropped on the editor, the top bar or empty space is
 * WebKit's to open in place of the app. gardend refuses that navigation, but
 * then the drop did nothing visible. This listener takes any file drop that
 * no target handled and offers it to the import, the same path as a drop on
 * the sidebar.
 */

export interface WindowFileDropOptions {
  readonly target?: Window
  readonly onFiles: (files: FileList) => void
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

export function installWindowFileDrop(options: WindowFileDropOptions): () => void {
  const target = options.target ?? window
  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (event: DragEvent) => {
    if (!carriesFiles(event)) return
    // A target that took the drop (the sidebar, a canvas, the editor) has
    // already called preventDefault. The window still refuses navigation.
    const handled = event.defaultPrevented
    event.preventDefault()
    if (handled) return
    const files = event.dataTransfer?.files
    if (files?.length) options.onFiles(files)
  }
  target.addEventListener('dragover', onDragOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
  }
}
