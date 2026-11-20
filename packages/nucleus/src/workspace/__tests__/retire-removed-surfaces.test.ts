/**
 * Stored configs written before the pruning still load.
 *
 * The fixture is the garden-default seed as it was before Choreograph, the
 * Sophia chat, Emporium and the mobile layout were removed. Every graph made
 * before the pruning stores that config. The test reads it through the same
 * RDF path the shell uses (parseNT → parseTriplesToConfig), then retires the
 * removed surfaces and validates.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseNT } from '../rdf-model.js'
import { parseTriplesToConfig } from '../ux-rdf.js'
import { validateConfig } from '../validate.js'
import { deriveAppTabs, planFor } from '../interpreter.js'
import { GARDEN_DEFAULT } from '../garden-default.js'
import { GARDEN_VARIANT } from '../garden-variant.js'
import { RETIRED_COMPONENT_TAGS, retireRemovedSurfaces } from '../retire-removed-surfaces.js'

const here = dirname(fileURLToPath(import.meta.url))
const readSeed = (path: string) => parseTriplesToConfig(parseNT(readFileSync(path, 'utf8')))
const OLD = readSeed(resolve(here, 'fixtures/garden-default-pre-prune.ux.nt'))
const NEW_SEED = readSeed(resolve(here, '../__generated__/garden-default.ux.nt'))

describe('retireRemovedSurfaces — stored pre-prune configs', () => {
  it('the old stored config is rejected without the retire step (the live failure)', () => {
    const verdict = validateConfig(OLD)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.error).toContain('wf-studio-shell')
  })

  it('retire + validate accepts the old stored config', () => {
    expect(validateConfig(retireRemovedSurfaces(OLD))).toEqual({ ok: true })
  })

  it('the retired config has one app (no switcher), no chat panel and no emporium skin', () => {
    const retired = retireRemovedSurfaces(OLD)
    expect(deriveAppTabs(retired)).toEqual(['garden'])
    expect(retired.appRootRegions).toBeUndefined()
    expect(retired.regions['region-choreo-center']).toBeUndefined()
    expect(retired.panels['panel-chat']).toBeUndefined()
    expect(retired.regions['region-right-rail'].docksPanel).not.toContain('panel-chat')
    expect(retired.dimensions['dim-app'].values.map(v => v.literalValue)).toEqual(['garden'])
    expect(retired.dimensions['dim-skin'].values.map(v => v.literalValue)).toEqual(['garden'])
    for (const region of Object.values(retired.regions)) {
      expect(RETIRED_COMPONENT_TAGS.has(region.renderedByComponent ?? '')).toBe(false)
    }
    for (const panel of Object.values(retired.panels)) {
      expect(RETIRED_COMPONENT_TAGS.has(panel.renderedByComponent)).toBe(false)
    }
  })

  it('the retired old config plans exactly like the new default', () => {
    expect(planFor(retireRemovedSurfaces(OLD))).toEqual(planFor(GARDEN_DEFAULT))
    expect(retireRemovedSurfaces(OLD)).toEqual(NEW_SEED)
  })

  it('is a no-op (same object) on the new seed and the built-in configs', () => {
    expect(retireRemovedSurfaces(NEW_SEED)).toBe(NEW_SEED)
    expect(retireRemovedSurfaces(GARDEN_DEFAULT)).toBe(GARDEN_DEFAULT)
    // A config from before the terminal panel gains it, and nothing else.
    const variant = retireRemovedSurfaces(GARDEN_VARIANT)
    expect(variant.panels['panel-terminal']?.renderedByComponent).toBe('mn-terminal-pane')
    expect(variant.regions['region-right-rail']?.docksPanel).toContain('panel-terminal')
    const { 'panel-terminal': _added, ...others } = variant.panels
    expect(others).toEqual(GARDEN_VARIANT.panels)
    expect(retireRemovedSurfaces(variant)).toBe(variant)
  })

  it('does not mutate its input', () => {
    const before = JSON.stringify(OLD)
    retireRemovedSurfaces(OLD)
    expect(JSON.stringify(OLD)).toBe(before)
  })

  it('leaves every other off-catalog tag to strict validation', () => {
    const bogus = {
      ...GARDEN_DEFAULT,
      panels: {
        ...GARDEN_DEFAULT.panels,
        'panel-comments': { ...GARDEN_DEFAULT.panels['panel-comments'], renderedByComponent: 'mn-not-a-real-panel' },
      },
    }
    expect(retireRemovedSurfaces(bogus)).toBe(bogus)
    expect(validateConfig(retireRemovedSurfaces(bogus)).ok).toBe(false)
  })
})
