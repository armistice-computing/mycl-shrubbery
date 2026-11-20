/**
 * Read-time retirement of surfaces removed for the first public release.
 *
 * Every graph made before the pruning stores a :ux:config written from the
 * old seed. That config names a Choreograph app branch (region-choreo-center,
 * rendered by wf-studio-shell), the Sophia chat panel (panel-chat), and the
 * Emporium skin value. Those tags are no longer vetted components, so strict
 * validation (I7) rejects the whole config and the workspace does not load.
 *
 * `retireRemovedSurfaces` strips those parts, and every reference to them,
 * BEFORE validation. It is pure and read-time only: callers must never write
 * the result back to the stored config. Validation stays strict for
 * everything else. A config that names nothing removed is returned as the
 * same object.
 */
import type { ConfigDimension, RegionConfig, WorkspaceConfig } from './types.js'

/** Component tags whose surfaces were deleted. A region or panel that names one is dropped. */
export const RETIRED_COMPONENT_TAGS: ReadonlySet<string> = new Set([
  'wf-studio-shell',
  'wf-choreograph-view',
  'wf-mission-control',
  'mn-chat-panel',
  'sh-chat-panel',
  'mn-phanes-control-editor',
  'mn-mobile-tabs',
  'mn-mobile-file-list',
])

/** Regions and panels retired by id, whatever they render. */
export const RETIRED_REGION_IDS: ReadonlySet<string> = new Set(['region-choreo-center'])
export const RETIRED_PANEL_IDS: ReadonlySet<string> = new Set(['panel-chat'])

/** Apps retired from `appRootRegions` and the dim-app dimension. */
export const RETIRED_APP_IDS: ReadonlySet<string> = new Set(['choreograph'])

/** Dimension literal values retired, per dimension id. */
export const RETIRED_DIMENSION_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  'dim-app': RETIRED_APP_IDS,
  'dim-skin': new Set(['emporium']),
}

function retiredTag(tag: string | null | undefined): boolean {
  return tag != null && RETIRED_COMPONENT_TAGS.has(tag)
}

export function retireRemovedSurfaces(config: WorkspaceConfig): WorkspaceConfig {
  let changed = false

  // 1. Panels.
  const panels: Record<string, WorkspaceConfig['panels'][string]> = {}
  for (const [key, panel] of Object.entries(config.panels)) {
    if (RETIRED_PANEL_IDS.has(key) || RETIRED_PANEL_IDS.has(panel.id) || retiredTag(panel.renderedByComponent)) {
      changed = true
      continue
    }
    panels[key] = panel
  }
  // 2. Regions (by id or by tag).
  const removedRegions = new Set<string>()
  for (const [key, region] of Object.entries(config.regions)) {
    if (RETIRED_REGION_IDS.has(key) || RETIRED_REGION_IDS.has(region.id) || retiredTag(region.renderedByComponent)) {
      removedRegions.add(key)
      removedRegions.add(region.id)
    }
  }
  const regions: Record<string, RegionConfig> = {}
  for (const [key, region] of Object.entries(config.regions)) {
    if (removedRegions.has(key)) {
      changed = true
      continue
    }
    const docksPanel = region.docksPanel.filter(id => id in panels)
    const childRegion = region.childRegion !== null && removedRegions.has(region.childRegion)
      ? null
      : region.childRegion
    if (docksPanel.length !== region.docksPanel.length || childRegion !== region.childRegion) {
      changed = true
      regions[key] = { ...region, docksPanel, childRegion }
    } else {
      regions[key] = region
    }
  }

  // 3. Root lists.
  const rootRegions = config.rootRegions.filter(id => !removedRegions.has(id))
  if (rootRegions.length !== config.rootRegions.length) changed = true

  let appRootRegions: Record<string, readonly string[]> | undefined
  if (config.appRootRegions) {
    appRootRegions = {}
    for (const [app, roots] of Object.entries(config.appRootRegions)) {
      if (RETIRED_APP_IDS.has(app)) {
        changed = true
        continue
      }
      const kept = roots.filter(id => !removedRegions.has(id))
      if (kept.length !== roots.length) changed = true
      if (kept.length === 0) continue
      appRootRegions[app] = kept
    }
    if (Object.keys(appRootRegions).length === 0) appRootRegions = undefined
  }

  // 4. Dimension values (and a default that pointed at one).
  const dimensions: Record<string, ConfigDimension> = {}
  for (const [key, dimension] of Object.entries(config.dimensions)) {
    const retired = RETIRED_DIMENSION_VALUES[key] ?? RETIRED_DIMENSION_VALUES[dimension.id]
    if (!retired) {
      dimensions[key] = dimension
      continue
    }
    const values = dimension.values.filter(value => !retired.has(value.literalValue))
    const defaultValue = retired.has(dimension.defaultValue)
      ? values[0]?.literalValue ?? dimension.defaultValue
      : dimension.defaultValue
    if (values.length !== dimension.values.length || defaultValue !== dimension.defaultValue) {
      changed = true
      dimensions[key] = { ...dimension, values, defaultValue }
    } else {
      dimensions[key] = dimension
    }
  }

  // The terminal panel is part of the shell, not of any one graph: a config
  // stored before it existed (every graph made before this release, and the
  // seeded ones) gains it here, in memory, whatever else changed.
  if (!panels['panel-terminal']) {
    changed = true
    panels['panel-terminal'] = {
      defaultVisible: false,
      dockState: 'stacked',
      id: 'panel-terminal',
      label: 'Terminal Panel',
      renderedByComponent: 'mn-terminal-pane',
    }
  }
  const rightRail = regions['region-right-rail']
  if (rightRail && !rightRail.docksPanel.includes('panel-terminal')) {
    changed = true
    regions['region-right-rail'] = {
      ...rightRail,
      docksPanel: [...rightRail.docksPanel, 'panel-terminal'].sort(),
    }
  }
  if (!changed) return config
  const { appRootRegions: _dropped, ...rest } = config
  return {
    ...rest,
    regions,
    panels,
    dimensions,
    rootRegions,
    ...(appRootRegions ? { appRootRegions } : {}),
  }
}
