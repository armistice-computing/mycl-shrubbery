import type { RenderWorkspaceOptions } from '@shrubbery/runtime'

/**
 * The read-aloud state for the active pane's editor toolbar. The tts feature
 * returns its snapshot beside the panes, and pane editors are built before
 * it, so the toolbar's button said "unavailable" while Mod+L spoke
 * (Eschaton, 2026-11-18). The active pane is the one the controller reads.
 */
export function withPaneReadAloud(snapshot: RenderWorkspaceOptions): RenderWorkspaceOptions {
  const tts = snapshot.tts
  const panes = snapshot.centerPanes
  if (!tts || !panes) return snapshot
  const activeId = panes.projection.activePaneId
  const active = panes.editorHosts.get(activeId)
  if (!active) return snapshot
  const editorHosts = new Map(panes.editorHosts)
  editorHosts.set(activeId, { ...active, ttsAvailable: tts.available, ttsStatus: tts.status })
  return { ...snapshot, centerPanes: { ...panes, editorHosts } }
}
