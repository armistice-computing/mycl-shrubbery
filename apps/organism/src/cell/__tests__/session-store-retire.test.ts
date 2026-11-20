/**
 * A graph made before the 2026-10 pruning stores a :ux:config written from
 * the old seed (Choreograph app branch, Sophia chat panel, Emporium skin).
 * The live read path must retire those surfaces before strict validation, or
 * every such graph refuses to load. Drives the real loadConfigFromCell over
 * the frozen pre-prune seed body.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GARDEN_DEFAULT, deriveAppTabs, planFor } from '@shrubbery/nucleus'
import { loadConfigFromCell, type CellContract } from '../session-store.js'

const here = dirname(fileURLToPath(import.meta.url))
const OLD_SEED_NT = readFileSync(
  resolve(here, '../../../../../packages/nucleus/src/workspace/__tests__/fixtures/garden-default-pre-prune.ux.nt'),
  'utf8',
)

function contractServing(nt: string): CellContract {
  return {
    restConcrete: {
      dumpUxConfig: async () => ({ data: nt }),
    },
  } as unknown as CellContract
}

describe('loadConfigFromCell — stored pre-prune configs still load', () => {
  it('retires the removed surfaces and returns a valid single-app config', async () => {
    const read = await loadConfigFromCell(contractServing(OLD_SEED_NT), 'pre-prune-graph')
    expect(read.defaulted).toBe(false)
    expect(deriveAppTabs(read.config)).toEqual(['garden'])
    expect(read.config.panels['panel-chat']).toBeUndefined()
    expect(read.config.dimensions['dim-skin'].values.map(v => v.literalValue)).toEqual(['garden'])
    expect(planFor(read.config)).toEqual(planFor(GARDEN_DEFAULT))
    // Read-time only: the stored body handed back is the original, untouched.
    expect(read.nt).toBe(OLD_SEED_NT)
  })
})
