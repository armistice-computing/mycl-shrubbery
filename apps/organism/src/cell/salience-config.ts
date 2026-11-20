/**
 * salience-config.ts — the importance view's scoring settings, read and
 * written through the same MCP tools agents use: `get_values` and
 * `revaluate`. revaluate archives the old settings and schedules the
 * importance view's rebuild (garden salience_service.rs), which the plain
 * PATCH /salience/{graph}/config route does not archive.
 */
import type { SalienceConfigPatch, SalienceConfigRequestDetail, SalienceConfigView } from '@shrubbery/components'

export type McpToolCaller = (name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** gardend's config JSON (dual-keyed; revaluate nests it under `config`). */
export function parseSalienceConfig(value: unknown): SalienceConfigView {
  const outer = record(value)
  const config = record(outer?.['config']) ?? outer
  const weights = record(config?.['weights'])
  if (!config || !weights) {
    throw new Error(typeof value === 'string' ? value : 'The cell answered without scoring settings.')
  }
  const numbers: Record<string, number> = {}
  for (const [key, raw] of Object.entries(weights)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) numbers[key] = raw
  }
  const text = (camel: string, snake: string): string => {
    const raw = config[camel] ?? config[snake]
    return typeof raw === 'string' ? raw : ''
  }
  const history = config['historyCount'] ?? config['history_count']
  return {
    importancePrompt: text('importancePrompt', 'importance_prompt'),
    valencePrompt: text('valencePrompt', 'valence_prompt'),
    weights: numbers,
    historyCount: typeof history === 'number' ? history : 0,
  }
}

/** revaluate's arguments: weights travel as a JSON object in its `weights` text. */
export function revaluateArgs(graphId: string, patch: SalienceConfigPatch): Record<string, unknown> {
  const args: Record<string, unknown> = { graph_id: graphId }
  if (patch.weights && Object.keys(patch.weights).length > 0) args['weights'] = JSON.stringify(patch.weights)
  if (patch.importancePrompt !== undefined) args['importance_prompt'] = patch.importancePrompt
  if (patch.valencePrompt !== undefined) args['valence_prompt'] = patch.valencePrompt
  return args
}

/**
 * Answer one request from mn-salience-config. `writeRefusal` is the reason a
 * save is refused here (read-only graph, offline cell), or null.
 */
export async function answerSalienceConfigRequest(
  callTool: McpToolCaller,
  graphId: string,
  detail: SalienceConfigRequestDetail,
  writeRefusal: string | null,
): Promise<void> {
  try {
    if (detail.action === 'save') {
      if (writeRefusal) {
        detail.respond({ error: writeRefusal })
        return
      }
      if (!detail.patch) {
        detail.respond({ error: 'Nothing changed.' })
        return
      }
      detail.respond({ config: parseSalienceConfig(await callTool('revaluate', revaluateArgs(graphId, detail.patch))) })
      return
    }
    detail.respond({ config: parseSalienceConfig(await callTool('get_values', { graph_id: graphId })) })
  } catch (error) {
    detail.respond({ error: error instanceof Error ? error.message : String(error) })
  }
}
