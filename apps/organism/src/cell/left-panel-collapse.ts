/**
 * Which right panel shows when the expanded left panel closes.
 *
 * Opening the Graph in the left panel widens it ("rolls it out") and records
 * the right panel exactly as it was, `none` included. A plain widening only
 * keeps `preExpandRightPanel`, which never holds `none`: widening by hand puts
 * the default panel there so un-widening reopens something. Closing a rolled
 * out Graph must use the roll-out record. Using `preExpandRightPanel` instead
 * opened the default right panel after Graph → Graph when the right panel had
 * been closed (Eschaton's round 6, 2026-11-19).
 */
import type { RightPanelMode } from '@shrubbery/nucleus'

export interface GraphRolloutRecord {
  readonly rightPanel: RightPanelMode
}

export function rightPanelAfterLeftCollapse(
  rollout: GraphRolloutRecord | null,
  preExpandRightPanel: RightPanelMode,
): RightPanelMode {
  return rollout ? rollout.rightPanel : preExpandRightPanel
}
