import { describe, expect, it } from 'vitest'
import type { SalienceConfigResult } from '@shrubbery/components'
import { answerSalienceConfigRequest, parseSalienceConfig, revaluateArgs } from '../salience-config.js'

// The shape gardend's local_value_config_json returns (salience_config_projection.rs).
const CELL_CONFIG = {
  graph_id: 'g',
  graphId: 'g',
  importance_prompt: 'imp',
  importancePrompt: 'imp',
  valence_prompt: 'val',
  valencePrompt: 'val',
  weights: { importance_weight: 0.3, half_life_days: 30, workspace_depth: 2 },
  temporal_half_life_days: 30,
  history_count: 4,
  historyCount: 4,
  source: 'local-value-store',
}

async function answer(
  action: 'load' | 'save',
  reply: unknown,
  writeRefusal: string | null = null,
): Promise<{ result: SalienceConfigResult | null; calls: Array<[string, Readonly<Record<string, unknown>>]> }> {
  const calls: Array<[string, Readonly<Record<string, unknown>>]> = []
  let result: SalienceConfigResult | null = null
  await answerSalienceConfigRequest(
    async (name, args) => {
      calls.push([name, args])
      if (reply instanceof Error) throw reply
      return reply
    },
    'g',
    { action, patch: action === 'save' ? { weights: { half_life_days: 14 }, valencePrompt: 'new' } : undefined, respond: r => { result = r } },
    writeRefusal,
  )
  return { result, calls }
}

describe('salience config through get_values / revaluate', () => {
  it('reads get_values and revaluate replies (revaluate nests the config)', () => {
    const view = parseSalienceConfig(CELL_CONFIG)
    expect(view).toEqual({
      importancePrompt: 'imp',
      valencePrompt: 'val',
      weights: { importance_weight: 0.3, half_life_days: 30, workspace_depth: 2 },
      historyCount: 4,
    })
    expect(parseSalienceConfig({ success: true, updated: ['weights'], config: CELL_CONFIG })).toEqual(view)
    expect(() => parseSalienceConfig('revaluate weights not applied: unknown weight "x"')).toThrow('unknown weight')
  })

  it('sends weights as the JSON text revaluate parses, and only the fields given', () => {
    expect(revaluateArgs('g', { weights: { half_life_days: 14 } })).toEqual({ graph_id: 'g', weights: '{"half_life_days":14}' })
    expect(revaluateArgs('g', { importancePrompt: '' })).toEqual({ graph_id: 'g', importance_prompt: '' })
  })

  it('loads with get_values and saves with revaluate', async () => {
    const load = await answer('load', CELL_CONFIG)
    expect(load.calls).toEqual([['get_values', { graph_id: 'g' }]])
    expect(load.result).toMatchObject({ config: { historyCount: 4 } })

    const save = await answer('save', { success: true, config: { ...CELL_CONFIG, history_count: 5, historyCount: 5 } })
    expect(save.calls).toEqual([['revaluate', { graph_id: 'g', weights: '{"half_life_days":14}', valence_prompt: 'new' }]])
    expect(save.result).toMatchObject({ config: { historyCount: 5 } })
  })

  it('refuses a save where ratings cannot be written, and reports a cell error', async () => {
    const refused = await answer('save', CELL_CONFIG, 'Ratings are online-only.')
    expect(refused.calls).toEqual([])
    expect(refused.result).toEqual({ error: 'Ratings are online-only.' })

    const failed = await answer('load', new Error('MCP error for get_values: boom'))
    expect(failed.result).toEqual({ error: 'MCP error for get_values: boom' })
  })
})
