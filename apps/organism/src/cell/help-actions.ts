/**
 * Settings → Help: the events the page sends and the two graph operations
 * behind it (Eschaton, 2026-11-18).
 *
 * "Add the latest Getting Started pages" seeds the onboarding archive this
 * build carries into a NEW graph. It never touches an existing graph.
 *
 * "Wipe everything and start over" seeds that new graph FIRST, switches to
 * it, and only then deletes every other graph. If seeding fails, nothing is
 * deleted, so the person is never left with no graph at all.
 */

export const HELP_DOOR_EVENT = 'mn-help-door'
export const HELP_SHOW_WELCOME_EVENT = 'mn-help-show-welcome'
export const HELP_ADD_GETTING_STARTED_EVENT = 'mn-help-add-getting-started'
export const HELP_WIPE_EVENT = 'mn-help-wipe'

export type HelpDoor = 'import' | 'agent' | 'start-here' | 'wires' | 'today' | 'shortcuts'

export interface HelpDoorDetail {
  readonly door: HelpDoor
}

export interface HelpOutcome {
  readonly ok: boolean
  readonly message: string
}

/** The page waits on `resolve` to leave its working state. */
export interface HelpRequestDetail {
  resolve(outcome: HelpOutcome): void
}

/** The node's commands, injected so the flow can be tested without one. */
export interface HelpGraphOps {
  /** Seeds the onboarding archive into a new graph with this id. */
  seed(graphId: string): Promise<void>
  listGraphIds(): Promise<readonly string[]>
  switchTo(graphId: string): Promise<void>
  deleteGraph(graphId: string): Promise<void>
}

export interface WipeResult {
  readonly graphId: string
  readonly deleted: readonly string[]
  readonly failed: readonly { readonly graphId: string; readonly reason: string }[]
}

function localDateKey(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** `start-2026-11-18`, then `-2`, `-3` when that id is taken. */
export function gettingStartedGraphId(existing: Iterable<string>, now: Date = new Date()): string {
  const taken = new Set(existing)
  const base = `start-${localDateKey(now)}`
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

export async function addGettingStarted(ops: HelpGraphOps, now: Date = new Date()): Promise<string> {
  const graphId = gettingStartedGraphId(await ops.listGraphIds(), now)
  await ops.seed(graphId)
  return graphId
}

export async function wipeAndStartOver(ops: HelpGraphOps, now: Date = new Date()): Promise<WipeResult> {
  const before = await ops.listGraphIds()
  const graphId = gettingStartedGraphId(before, now)
  await ops.seed(graphId)
  await ops.switchTo(graphId)
  const deleted: string[] = []
  const failed: { graphId: string; reason: string }[] = []
  for (const other of before) {
    if (other === graphId) continue
    try {
      await ops.deleteGraph(other)
      deleted.push(other)
    } catch (error) {
      failed.push({ graphId: other, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { graphId, deleted, failed }
}

/** Only an exact "delete" (any case, trimmed) arms the last step. */
export function wipeConfirmationMatches(typed: string): boolean {
  return typed.trim().toLowerCase() === 'delete'
}
