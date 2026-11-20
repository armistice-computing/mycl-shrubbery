/**
 * REAL token test — NO MOCKS.
 *
 * We read the EMITTED CSS files from disk (css/*.css), tokenize their custom-
 * property declarations per selector block, resolve var() chains through the
 * reference ramp, and assert the skin/theme blocks define the expected token
 * VALUES. This is a real parse of the shipped CSS — there is no hand-written
 * mock token bag anywhere. The Emporium accent MUST resolve to purple-400
 * (#9472CE, Nora's iter-4a pick), the chrome font to Diatype, and BOTH must
 * differ from Garden.
 *
 * (The in-browser getComputedStyle confirmation runs later in iteration 3c via
 * Playwright against the real Storybook; happy-dom does not resolve the CSS
 * cascade across attribute selectors, so here we resolve from the source of
 * truth — the CSS text itself — which is the strongest assertion we can make
 * without a real engine.)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PURPLE_RAMP,
  RESEARCH_ACCENT,
  RESEARCH_FONT_SERIF,
  GREENHOUSE_ACCENT,
  GREENHOUSE_STANCE,
  GREENHOUSE_FONT_SANS,
  CONTESTED_STANCE,
  ROOM_POSTURE_STANCES,
  GARDEN_ACCENT,
  GARDEN_FONT_CHROME,
  OBSERVATORY_ACCENT,
  OBSERVATORY_CHART_CATEGORICAL,
  OBSERVATORY_CHART_SEQUENTIAL_AZURE,
  OBSERVATORY_CHART_DIVERGING,
  OBSERVATORY_CHART_STATUS,
  VISUAL_IDENTITY_SKINS,
  SKIN_APPLICATIONS,
  THEME_APPLICATIONS,
  EDITOR_MATERIAL_APPLICATIONS,
  STANCE_APPLICATIONS,
  KIND_APPLICATIONS,
  applyKind,
  applySkinTheme,
  applySkin,
  applyTheme,
  applyEditorMaterial,
  applyStance,
  nextVisualIdentitySkin,
  Z_LAYERS,
  type AttrTarget,
  type DisplayKindRegister,
} from '../index.js'

const CSS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../css')
const read = (f: string) => readFileSync(resolve(CSS_DIR, f), 'utf8')

// ── A tiny, dependency-free CSS custom-property reader ────────────────────────
// Splits a stylesheet into { selector → { --prop: rawValue } } blocks. Good
// enough for our flat token files (no nesting, no media queries inside blocks).
type Block = Record<string, string>
function parseBlocks(css: string): Map<string, Block> {
  // Strip comments first.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = new Map<string, Block>()
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    const selector = m[1].trim()
    const body = m[2]
    const block: Block = out.get(selector) ?? {}
    const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g
    let d: RegExpExecArray | null
    while ((d = declRe.exec(body)) !== null) {
      block[d[1].trim()] = d[2].trim()
    }
    // Multiple selectors can share a body (e.g. emporium + alias) → comma-split.
    for (const sel of selector.split(',').map(s => s.trim())) {
      out.set(sel, { ...(out.get(sel) ?? {}), ...block })
    }
  }
  return out
}

// The reference ramp (Tier 0) — the only place raw hexes live.
const refBlocks = parseBlocks(read('reference.css'))
const refRoot = refBlocks.get(':root') ?? {}

// The semantic + component :root scopes (Tier 1/2 defaults). A skin block that
// references a scale token like var(--mn-radius-none) resolves it from here.
const semanticRoot = parseBlocks(read('semantic.css')).get(':root') ?? {}
const componentRoot = parseBlocks(read('component.css')).get(':root') ?? {}
const baseRoot: Block = { ...refRoot, ...semanticRoot, ...componentRoot }

/** Normalize a resolved leaf value: lowercase bare hex colors, leave others. */
function norm(v: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v.toLowerCase() : v
}

/** Resolve a raw token value through var(--mn-ref-*) one hop (refs are flat). */
function resolveRef(raw: string): string {
  const varMatch = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/)
  if (!varMatch) return norm(raw)
  const target = varMatch[1]
  if (baseRoot[target] !== undefined) return norm(baseRoot[target])
  return norm(raw)
}

/**
 * Resolve a token in a given block, following var() chains within that block,
 * then the semantic/component/reference :root scopes. Bespoke tokens
 * (--emporium-*) and Tier-1 roles are followed within the supplied block first.
 */
function resolveIn(block: Block, raw: string, depth = 0): string {
  if (depth > 8) return norm(raw)
  const single = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/)
  if (single) {
    const target = single[1]
    if (block[target] !== undefined) return resolveIn(block, block[target], depth + 1)
    if (baseRoot[target] !== undefined) return resolveIn(baseRoot, baseRoot[target], depth + 1)
    return norm(raw)
  }
  // Compound value (e.g. "1px solid var(--mn-ref-purple-300)") — substitute each
  // embedded var() in place, then return the expanded string.
  if (raw.includes('var(')) {
    const expanded = raw.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, t: string) => {
      if (block[t] !== undefined) return resolveIn(block, block[t], depth + 1)
      if (baseRoot[t] !== undefined) return resolveIn(baseRoot, baseRoot[t], depth + 1)
      return `var(${t})`
    })
    return expanded
  }
  return norm(raw)
}

/** WCAG relative luminance of a #rrggbb literal. */
function relativeLuminance(hex: string): number {
  const value = hex.trim().replace('#', '')
  const channel = (pair: string): number => {
    const c = parseInt(pair, 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const r = channel(value.slice(0, 2))
  const g = channel(value.slice(2, 4))
  const b = channel(value.slice(4, 6))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two #rrggbb literals. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('@shrubbery/tokens — reference ramp (Tier 0)', () => {
  it('emits the purple ramp with the exact documented hexes', () => {
    for (const [step, hex] of Object.entries(PURPLE_RAMP)) {
      const tok = `--mn-ref-purple-${step}`
      expect(refRoot[tok], `${tok} present`).toBeDefined()
      expect(refRoot[tok].toLowerCase(), `${tok} value`).toBe(hex.toLowerCase())
    }
  })

  it('keeps the fern + cobalt ramps for Garden identity + sophia provenance', () => {
    expect(refRoot['--mn-ref-fern-600']).toBe('#376d57')
    expect(refRoot['--mn-ref-cobalt-500']).toBe('#1a5fa3') // sophia source, unchanged
  })
})

describe('@shrubbery/tokens — repository-owned typography', () => {
  it('loads the offline font entrypoint before every token layer', () => {
    const entry = read('tokens.css')
    expect(entry.indexOf("@import './fonts.css';")).toBeGreaterThanOrEqual(0)
    expect(entry.indexOf("@import './fonts.css';")).toBeLessThan(entry.indexOf("@import './reference.css';"))
  })

  it('declares normal and italic WOFF2 sources for every structural family', () => {
    const fonts = read('fonts.css')
    // Literata goes through literata-clamped.css rather than straight to
    // fontsource (see the next test for why), so its sources are asserted there.
    for (const family of ['source-sans-3', 'jetbrains-mono', 'inter', 'public-sans']) {
      expect(fonts).toContain(`@fontsource-variable/${family}/`)
    }
    expect(fonts).toContain("@import './literata-clamped.css';")
    const literata = read('literata-clamped.css')
    expect(literata).toContain('@fontsource-variable/literata/files/')
    expect(literata).toMatch(/font-style:\s*normal/)
    expect(literata).toMatch(/font-style:\s*italic/)
    // Piazzolla, like Literata, goes through a clamped copy.
    expect(fonts).toContain("@import './piazzolla-clamped.css';")
    const piazzolla = read('piazzolla-clamped.css')
    expect(piazzolla).toContain('@fontsource-variable/piazzolla/files/')
    expect(piazzolla).toMatch(/font-style:\s*normal/)
    expect(piazzolla).toMatch(/font-style:\s*italic/)
    expect(fonts.match(/italic\.css/g)).toHaveLength(4)
  })

  it('Literata stops at 600, which is where cloud-1 leaves it', () => {
    // A variable font renders whatever weight range its @font-face declares.
    // Cloud-1 asks Google Fonts for 400/500/600, so its face declares `400 600`
    // and every `font-weight: 700` in that app quietly renders at 600 — the
    // lighter bold Eschaton compared side by side and chose to keep. Measured
    // difference at a true 700: +14% ink, ~13px wider per line at 32px, while
    // 400-600 are identical to the pixel. That is why only bold looked wrong.
    //
    // This guards the two ways the clamp dies silently: a face that declares a
    // wider range, or fonts.css reaching past it to fontsource's own CSS, whose
    // faces declare `200 900` and would win the match for 700.
    const literata = read('literata-clamped.css')
    const ranges = [...literata.matchAll(/font-weight:\s*([\d\s]+);/g)].map(match => match[1].trim())
    expect(ranges.length).toBeGreaterThan(0)
    expect([...new Set(ranges)]).toEqual(['400 600'])

    const fonts = read('fonts.css')
    expect(fonts).not.toMatch(/@fontsource-variable\/literata\/(standard|wght|opsz|index)/)
  })

  it('Piazzolla stops at 600 too, so the app keeps the lighter bold it had in Literata', () => {
    // Piazzolla took over chrome and prose on 2026-10-14. Unclamped, its faces
    // declare `100 900`, and every 650/700/800 in the app would render heavier
    // than Literata ever did. Same two silent failure modes as above.
    const piazzolla = read('piazzolla-clamped.css')
    const ranges = [...piazzolla.matchAll(/font-weight:\s*([\d\s]+);/g)].map(match => match[1].trim())
    expect(ranges.length).toBe(14)
    expect([...new Set(ranges)]).toEqual(['400 600'])
    expect(read('fonts.css')).not.toMatch(/@fontsource-variable\/piazzolla\/(standard|wght|opsz|index)/)
  })

  it('gives code blocks a dark well wherever the page is dark, Observatory included', () => {
    // Undefined, the token fell back to a light #f3f1ec well under light text
    // in dark mode (2026-10-15). Observatory is dark without data-theme=dark.
    expect(semanticRoot['--mn-color-surface-code']).toBe('#f3f1ec')
    expect(parseBlocks(read('theme-dark.css')).get('[data-theme="dark"]')?.['--mn-color-surface-code']).toMatch(/^rgba\(0, 0, 0/)
    expect(parseBlocks(read('skin-observatory.css')).get('[data-skin="observatory"]')?.['--mn-color-surface-code']).toMatch(/^rgba\(0, 0, 0/)
  })

  it.each(['skin-research.css', 'skin-greenhouse.css', 'skin-observatory.css'])(
    '%s has its own prose face, so it sets the document body weight back to 400',
    (file) => {
      const blocks = parseBlocks(read(file))
      const weights = [...blocks.values()].map(block => block['--mn-editor-font-weight']).filter(Boolean)
      expect(weights).toContain('400')
    },
  )

  it('makes Piazzolla the Garden face, at a 450 document body weight', () => {
    expect(semanticRoot['--mn-font-chrome']).toMatch(/^'Piazzolla Variable'/)
    expect(semanticRoot['--mn-font-prose']).toMatch(/^'Piazzolla Variable'/)
    expect(semanticRoot['--mn-editor-font-weight']).toBe('450')
  })

  it('uses the bundled variable family names as the first choice', () => {
    expect(semanticRoot['--mn-font-chrome']).toMatch(/^'Piazzolla Variable'/)
    expect(semanticRoot['--mn-font-sans']).toMatch(/^'Source Sans 3 Variable'/)
    expect(semanticRoot['--mn-font-mono']).toMatch(/^'JetBrains Mono Variable'/)
  })
})

describe('@shrubbery/tokens — Garden skin (the default fern identity)', () => {
  const gBlocks = parseBlocks(read('skin-garden.css'))
  const g = gBlocks.get('[data-skin="garden"]') ?? {}

  it('accent resolves to the quiet-archive FERN-600 #376d57', () => {
    expect(resolveRef(g['--mn-color-accent'])).toBe(GARDEN_ACCENT.accent.toLowerCase())
  })

  it('chrome font is Literata serif (the Garden voice)', () => {
    expect(g['--mn-font-chrome']).toBe(GARDEN_FONT_CHROME)
  })

  it('keeps rounded geometry + visible labels (NOT sophia structure)', () => {
    expect(resolveRef(g['--mn-radius-control'])).not.toBe('0')
    expect(g['--mn-label-display']).toBe('inline')
    expect(g['--mn-row-height']).toBe('30px')
    expect(g['--mn-control-height']).toBe('30px')
  })
})

describe('@shrubbery/tokens — Research skin (SRS scholar-desk identity)', () => {
  const rBlocks = parseBlocks(read('skin-research.css'))
  const r = rBlocks.get('[data-skin="research"]') ?? {}
  const rDark =
    rBlocks.get('[data-theme="dark"][data-skin="research"]') ?? {}
  const rRoot = rBlocks.get(':root') ?? {}
  const rResolveBlock: Block = { ...rRoot, ...r }

  it('lights up via [data-skin=research] (the sux appliesAttribute hook)', () => {
    expect(Object.keys(r).length).toBeGreaterThan(0)
    expect(SKIN_APPLICATIONS.research.appliesAttribute).toBe('[data-skin=research]')
  })

  it('accent resolves to the muted SRS research blue', () => {
    const accent = resolveIn(rResolveBlock, r['--mn-color-accent'])
    expect(accent).toBe(RESEARCH_ACCENT.accent.toLowerCase())
    expect(accent).not.toBe(GARDEN_ACCENT.accent.toLowerCase())
    expect(accent).not.toBe(PURPLE_RAMP[400].toLowerCase())
  })

  it('accent channel triple is the research blue channel', () => {
    expect(resolveIn(rResolveBlock, r['--mn-color-accent-ch'])).toBe(
      RESEARCH_ACCENT.accentChannel,
    )
  })

  it('uses Literata for chrome, prose, and display (SRS prose-forward posture)', () => {
    expect(resolveIn(rResolveBlock, r['--mn-font-chrome'])).toBe(RESEARCH_FONT_SERIF)
    expect(resolveIn(rResolveBlock, r['--mn-font-display'])).toBe(RESEARCH_FONT_SERIF)
    expect(resolveIn(rResolveBlock, r['--mn-font-prose'])).toBe(RESEARCH_FONT_SERIF)
  })

  it('keeps the scholar-desk surfaces, gentle rules, and comfortable density', () => {
    expect(r['--mn-color-surface-base']).toBe('#f6f4ef')
    expect(r['--mn-color-surface-raised']).toBe('#fffdf8')
    expect(r['--mn-radius-surface']).toBe('12px')
    expect(resolveIn(rResolveBlock, r['--mn-radius-control'])).toBe('6px')
    expect(r['--mn-row-height']).toBe('30px')
    expect(r['--mn-control-height']).toBe('30px')
    expect(r['--mn-label-display']).toBe('inline')
    expect(r['--mn-texture-display']).toBe('block')
    expect(resolveIn(rResolveBlock, r['--mn-chrome-rule'])).toBe('1px solid #ded8cc')
  })

  it('exports the soft raised shadows the SRS wireframes used for cards/composer', () => {
    expect(r['--mn-shadow-card']).toContain('0 12px 30px')
    expect(r['--mn-shadow-composer']).toContain('0 8px 24px')
    expect(r['--mn-shadow-composer-focus']).toContain('0 10px 28px')
  })

  it('dark Research lightens the accent and keeps a cool research desk surface', () => {
    const darkBlock: Block = { ...rRoot, ...r, ...rDark }
    const darkAccent = resolveIn(darkBlock, darkBlock['--research-accent'])
    expect(darkAccent).toBe(RESEARCH_ACCENT.accentDark.toLowerCase())
    expect(resolveIn(darkBlock, darkBlock['--mn-color-accent-ch'])).toBe('169 186 216')
    expect(rDark['--mn-color-surface-base']).toBe('#141821')
    expect(rDark['--mn-color-surface-base']).not.toBe('#171514')
  })
})

describe('@shrubbery/tokens — Greenhouse skin (sans Garden research workspace)', () => {
  const ghBlocks = parseBlocks(read('skin-greenhouse.css'))
  const gh = ghBlocks.get('[data-skin="greenhouse"]') ?? {}
  const ghDark =
    ghBlocks.get('[data-theme="dark"][data-skin="greenhouse"]') ?? {}
  const ghRoot = ghBlocks.get(':root') ?? {}
  const ghResolveBlock: Block = { ...ghRoot, ...gh }

  it('lights up via [data-skin=greenhouse] (the sux appliesAttribute hook)', () => {
    expect(Object.keys(gh).length).toBeGreaterThan(0)
    expect(SKIN_APPLICATIONS.greenhouse.appliesAttribute).toBe('[data-skin=greenhouse]')
  })

  it('accent resolves to the greenhouse workspace green', () => {
    const accent = resolveIn(ghResolveBlock, gh['--mn-color-accent'])
    expect(accent).toBe(GREENHOUSE_ACCENT.accent.toLowerCase())
    expect(accent).not.toBe(GARDEN_ACCENT.accent.toLowerCase())
    expect(accent).not.toBe(RESEARCH_ACCENT.accent.toLowerCase())
    expect(accent).not.toBe(PURPLE_RAMP[400].toLowerCase())
  })

  it('accent channel triple is the greenhouse channel', () => {
    expect(resolveIn(ghResolveBlock, gh['--mn-color-accent-ch'])).toBe(
      GREENHOUSE_ACCENT.accentChannel,
    )
  })

  it('uses sans for chrome, prose, display, and utility roles', () => {
    expect(resolveIn(ghResolveBlock, gh['--mn-font-chrome'])).toBe(GREENHOUSE_FONT_SANS)
    expect(resolveIn(ghResolveBlock, gh['--mn-font-display'])).toBe(GREENHOUSE_FONT_SANS)
    expect(resolveIn(ghResolveBlock, gh['--mn-font-prose'])).toBe(GREENHOUSE_FONT_SANS)
    expect(resolveIn(ghResolveBlock, gh['--mn-font-utility'])).toBe(GREENHOUSE_FONT_SANS)
  })

  it('keeps human-factor targets visible while reducing visual noise', () => {
    expect(gh['--mn-color-surface-base']).toBe('#f4f6f2')
    expect(gh['--mn-color-surface-raised']).toBe('#ffffff')
    expect(resolveIn(ghResolveBlock, gh['--mn-radius-control'])).toBe('6px')
    expect(resolveIn(ghResolveBlock, gh['--mn-radius-surface'])).toBe('8px')
    expect(gh['--mn-row-height']).toBe('30px')
    expect(gh['--mn-control-height']).toBe('32px')
    expect(gh['--mn-label-display']).toBe('inline')
    expect(gh['--mn-texture-display']).toBe('none')
    expect(gh['--mn-tracking-label']).toBe('0')
    expect(resolveIn(ghResolveBlock, gh['--mn-chrome-rule'])).toBe('1px solid #cfdad2')
  })

  it('exports shallow workspace shadows rather than the lifted SRS workbench', () => {
    expect(gh['--mn-shadow-card']).toContain('0 6px 18px')
    expect(gh['--mn-shadow-card']).not.toContain('0 12px 30px')
    expect(gh['--mn-shadow-composer']).toContain('0 6px 18px')
  })

  it('dark Greenhouse lightens the accent and keeps a cool botanical dark surface', () => {
    const darkBlock: Block = { ...ghRoot, ...gh, ...ghDark }
    const darkAccent = resolveIn(darkBlock, darkBlock['--greenhouse-accent'])
    expect(darkAccent).toBe(GREENHOUSE_ACCENT.accentDark.toLowerCase())
    expect(resolveIn(darkBlock, darkBlock['--mn-color-accent-ch'])).toBe('136 201 172')
    expect(ghDark['--mn-color-surface-base']).toBe('#121816')
    expect(ghDark['--mn-color-surface-base']).not.toBe('#171514')
  })

  it('consumes stance registers and exposes floor salience hooks', () => {
    const room = ghBlocks.get('[data-skin="greenhouse"][data-stance="room"]') ?? {}
    const bench = ghBlocks.get('[data-skin="greenhouse"][data-stance="bench"]') ?? {}
    const openFloor = ghBlocks.get('[data-skin="greenhouse"][data-floor-state="open"]') ?? {}
    const heldFloor = ghBlocks.get('[data-skin="greenhouse"][data-floor-state="held"]') ?? {}

    expect(room['--greenhouse-stance-register']).toBe('var(--mn-stance-register-room)')
    expect(bench['--greenhouse-stance-register']).toBe('var(--mn-stance-register-bench)')
    expect(openFloor['--greenhouse-floor-tone']).toBe('var(--mn-color-accent)')
    expect(heldFloor['--greenhouse-floor-tone']).toBe('var(--mn-color-warning)')
  })

  it('lights the annunciator per stance — Room accent, Constitution violet (folio 02)', () => {
    const room = ghBlocks.get('[data-skin="greenhouse"][data-stance="room"]') ?? {}
    const constitution = ghBlocks.get('[data-skin="greenhouse"][data-stance="constitution"]') ?? {}

    // Room wears the accent; the shell's default annunciator hue is the accent too.
    expect(room['--mn-stance-annunciator-ink']).toBe('var(--mn-color-accent)')
    expect(resolveIn(ghResolveBlock, gh['--mn-stance-annunciator-ink'])).toBe(GREENHOUSE_ACCENT.accent.toLowerCase())

    // Constitution wears its own quiet violet — the CSS and the exported constant agree.
    expect(constitution['--mn-stance-annunciator-ink']).toBe(GREENHOUSE_STANCE.constitutionInk)
    expect(constitution['--mn-stance-annunciator-edge']).toBe(GREENHOUSE_STANCE.constitutionEdge)
    expect(constitution['--mn-stance-annunciator-wash']).toBe(GREENHOUSE_STANCE.constitutionWash)
    // The two stance hues are genuinely distinct — the switch reads at a glance.
    expect(GREENHOUSE_STANCE.constitutionInk).not.toBe(GREENHOUSE_ACCENT.accent)
  })
})

describe('@shrubbery/tokens — Observatory skin (night-room dashboard identity)', () => {
  const obBlocks = parseBlocks(read('skin-observatory.css'))
  const ob = obBlocks.get('[data-skin="observatory"]') ?? {}
  const obDark = obBlocks.get('[data-theme="dark"][data-skin="observatory"]') ?? {}
  const obRoot = obBlocks.get(':root') ?? {}
  const obResolveBlock: Block = { ...obRoot, ...ob }

  it('lights up via [data-skin=observatory] (the sux appliesAttribute hook)', () => {
    expect(Object.keys(ob).length).toBeGreaterThan(0)
    expect(SKIN_APPLICATIONS.observatory.appliesAttribute).toBe('[data-skin=observatory]')
  })

  it('is NOT part of the global visual-identity cycle', () => {
    expect(VISUAL_IDENTITY_SKINS).not.toContain('observatory')
    expect(nextVisualIdentitySkin('observatory')).toBe('garden')
  })

  it('baseline accent resolves to the dark-optimized azure chart swatch (no daylight register)', () => {
    const accent = resolveIn(obResolveBlock, ob['--mn-color-accent'])
    expect(accent).toBe(OBSERVATORY_ACCENT.accent.toLowerCase())
    expect(accent).toBe(OBSERVATORY_CHART_CATEGORICAL.azure.dark.toLowerCase())
    expect(accent).not.toBe(GARDEN_ACCENT.accent.toLowerCase())
    expect(accent).not.toBe(RESEARCH_ACCENT.accent.toLowerCase())
    expect(accent).not.toBe(GREENHOUSE_ACCENT.accent.toLowerCase())
  })

  it('accent channel triple matches the documented Observatory accent', () => {
    expect(resolveIn(obResolveBlock, ob['--mn-color-accent-ch'])).toBe(OBSERVATORY_ACCENT.accentChannel)
  })

  it('is a genuinely dark room even at [data-skin=observatory] alone (no [data-theme=dark] needed)', () => {
    // Baseline surface-base IS the validated dataviz dark surface (ink-50).
    expect(resolveIn(obResolveBlock, ob['--mn-color-surface-base'])).toBe('#191c18')
    expect(resolveIn(obResolveBlock, ob['--mn-color-surface-canvas'])).not.toBe('#fbfaf6')
    // High-contrast numeral ink: text-primary/title sit at the brightest ink steps.
    expect(resolveIn(obResolveBlock, ob['--mn-color-text-title'])).toBe('#f6f7f2')
  })

  it('borders are instrument-lit — the accent channel, not a flat neutral gray', () => {
    expect(ob['--mn-color-border-default']).toContain('var(--observatory-accent-ch)')
    expect(ob['--mn-color-rule']).toContain('var(--observatory-accent-ch)')
  })

  it('exports the instrument glow built only from the accent channel (no new raw hex)', () => {
    expect(ob['--mn-observatory-instrument-glow']).toContain('var(--observatory-accent-ch)')
    expect(ob['--mn-observatory-instrument-glow']).not.toMatch(/#[0-9a-fA-F]{3,8}/)
  })

  it('uses mono chrome/display/utility — a telemetry-console voice distinct from every other skin', () => {
    expect(resolveIn(obResolveBlock, ob['--mn-font-chrome'])).toBe(semanticRoot['--mn-font-mono'])
    expect(resolveIn(obResolveBlock, ob['--mn-font-display'])).toBe(semanticRoot['--mn-font-mono'])
    expect(resolveIn(obResolveBlock, ob['--mn-font-prose'])).toBe(semanticRoot['--mn-font-sans'])
  })

  it('dark composition ("true night") lightens the accent further and deepens the room', () => {
    const darkBlock: Block = { ...obRoot, ...ob, ...obDark }
    const darkAccent = resolveIn(darkBlock, darkBlock['--observatory-accent'])
    expect(darkAccent).toBe(OBSERVATORY_ACCENT.accentTrueNight.toLowerCase())
    expect(resolveIn(darkBlock, darkBlock['--mn-color-accent-ch'])).toBe(OBSERVATORY_ACCENT.accentTrueNightChannel)
    // Strictly darker canvas than the baseline room, not a flip.
    expect(obDark['--mn-color-surface-canvas']).toBe('#000000')
    expect(resolveIn(obResolveBlock, ob['--mn-color-surface-canvas'])).not.toBe('#000000')
    expect(obDark['--mn-color-text-primary']).toBe('#ffffff')
  })

  it('status quads at baseline already match the dark-appropriate theme-dark.css steps', () => {
    // The room is dark regardless of [data-theme]; danger/warning/success at
    // baseline must already be the SAME literals theme-dark.css documents.
    const darkTheme = parseBlocks(read('theme-dark.css')).get('[data-theme="dark"]') ?? {}
    expect(resolveIn(obResolveBlock, ob['--mn-color-danger'])).toBe(darkTheme['--mn-color-danger'])
    expect(resolveIn(obResolveBlock, ob['--mn-color-success'])).toBe(darkTheme['--mn-color-success'])
  })
})

describe('@shrubbery/tokens — Observatory dataviz chart palette (global, skin-independent)', () => {
  const light = semanticRoot
  const dark = parseBlocks(read('theme-dark.css')).get('[data-theme="dark"]') ?? {}

  it('categorical hues are in FIXED slot order and machine-validated per theme', () => {
    const lightSlots = [1, 2, 3, 4, 5].map(n => resolveIn(light, light[`--mn-chart-categorical-${n}`]))
    const expectedLight = [
      OBSERVATORY_CHART_CATEGORICAL.azure.light,
      OBSERVATORY_CHART_CATEGORICAL.terracotta.light,
      OBSERVATORY_CHART_CATEGORICAL.violet.light,
      OBSERVATORY_CHART_CATEGORICAL.chartreuse.light,
      OBSERVATORY_CHART_CATEGORICAL.magenta.light,
    ].map(h => h.toLowerCase())
    expect(lightSlots).toEqual(expectedLight)

    const darkSlots = [1, 2, 3, 4, 5].map(n => (dark[`--mn-chart-categorical-${n}`] ?? '').toLowerCase())
    const expectedDark = [
      OBSERVATORY_CHART_CATEGORICAL.azure.dark,
      OBSERVATORY_CHART_CATEGORICAL.terracotta.dark,
      OBSERVATORY_CHART_CATEGORICAL.violet.dark,
      OBSERVATORY_CHART_CATEGORICAL.chartreuse.dark,
      OBSERVATORY_CHART_CATEGORICAL.magenta.dark,
    ].map(h => h.toLowerCase())
    expect(darkSlots).toEqual(expectedDark)
  })

  it('a 9th series folds into "Other" — a distinct, muted, non-categorical token', () => {
    expect(light['--mn-chart-categorical-other']).toBe('var(--mn-color-text-muted)')
    const other = resolveIn(light, light['--mn-chart-categorical-other'])
    for (const n of [1, 2, 3, 4, 5]) {
      expect(other).not.toBe(resolveIn(light, light[`--mn-chart-categorical-${n}`]))
    }
  })

  it('sequential ramp is the azure hue, light→dark, theme-invariant', () => {
    for (const step of [100, 200, 300, 400, 500, 600, 700] as const) {
      expect(resolveIn(light, light[`--mn-chart-sequential-${step}`])).toBe(
        OBSERVATORY_CHART_SEQUENTIAL_AZURE[step].toLowerCase(),
      )
    }
    // No dark override exists — the token test file's own convention (theme-
    // dark.css literals win the cascade) means an absent key here IS the
    // "unchanged" contract.
    expect(dark['--mn-chart-sequential-500']).toBeUndefined()
  })

  it('diverging scale (azure cool pole / terracotta warm pole + neutral midpoint) re-validates per theme', () => {
    const roles = ['cool-far', 'cool-mid', 'cool-near', 'mid', 'warm-near', 'warm-mid', 'warm-far'] as const
    const keyOf = (r: (typeof roles)[number]) =>
      (r.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())) as keyof typeof OBSERVATORY_CHART_DIVERGING.light
    for (const role of roles) {
      const key = keyOf(role)
      expect(resolveIn(light, light[`--mn-chart-diverging-${role}`])).toBe(
        OBSERVATORY_CHART_DIVERGING.light[key].toLowerCase(),
      )
      expect((dark[`--mn-chart-diverging-${role}`] ?? '').toLowerCase()).toBe(
        OBSERVATORY_CHART_DIVERGING.dark[key].toLowerCase(),
      )
    }
  })

  it('status quad is RESERVED and matches theme-dark.css semantics where hues overlap', () => {
    expect(resolveIn(light, light['--mn-chart-status-good'])).toBe(OBSERVATORY_CHART_STATUS.light.good.toLowerCase())
    expect(resolveIn(light, light['--mn-chart-status-warning'])).toBe(OBSERVATORY_CHART_STATUS.light.warning.toLowerCase())
    expect(resolveIn(light, light['--mn-chart-status-serious'])).toBe(OBSERVATORY_CHART_STATUS.light.serious.toLowerCase())
    expect(resolveIn(light, light['--mn-chart-status-critical'])).toBe(OBSERVATORY_CHART_STATUS.light.critical.toLowerCase())

    expect((dark['--mn-chart-status-good'] ?? '').toLowerCase()).toBe(OBSERVATORY_CHART_STATUS.dark.good.toLowerCase())
    expect((dark['--mn-chart-status-serious'] ?? '').toLowerCase()).toBe(OBSERVATORY_CHART_STATUS.dark.serious.toLowerCase())
    expect((dark['--mn-chart-status-critical'] ?? '').toLowerCase()).toBe(OBSERVATORY_CHART_STATUS.dark.critical.toLowerCase())
    // good (dark) reuses the exact literal theme-dark.css documents for success.
    expect(dark['--mn-chart-status-good']).toBe(dark['--mn-color-success'])
    expect(dark['--mn-chart-status-serious']).toBe(dark['--mn-color-danger'])

    // Status is a RESERVED 4th vocabulary — never collides with a categorical slot.
    const categoricalLight = [1, 2, 3, 4, 5].map(n => resolveIn(light, light[`--mn-chart-categorical-${n}`]))
    for (const status of ['good', 'warning', 'serious', 'critical']) {
      expect(categoricalLight).not.toContain(resolveIn(light, light[`--mn-chart-status-${status}`]))
    }
  })

  it('chart geometry roles encode the thin-mark / recessive-grid rules as consumable tokens', () => {
    expect(light['--mn-chart-mark-width']).toBe('2px')
    expect(light['--mn-chart-mark-radius']).toBe('4px')
    expect(light['--mn-chart-marker-min']).toBe('8px')
    expect(light['--mn-chart-fill-gap']).toBe('2px')
    expect(light['--mn-chart-axis']).toBe('var(--mn-color-border-default)')
    expect(light['--mn-chart-grid']).toBe('var(--mn-color-border-subtle)')
  })

  it('numerals wear a global tabular-figures token (JetBrains Mono, not skin-scoped)', () => {
    expect(resolveIn(light, light['--mn-font-numeral'])).toBe(semanticRoot['--mn-font-mono'])
  })
})

describe('@shrubbery/tokens — semantic motion roles', () => {
  it('defines the transition family consumed by components', () => {
    expect(semanticRoot['--mn-ease-standard']).toBe('cubic-bezier(0.2, 0, 0, 1)')
    expect(semanticRoot['--mn-ease-emphasized']).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)')
    expect(semanticRoot['--mn-transition-fast']).toBe('110ms var(--mn-ease-standard)')
    expect(semanticRoot['--mn-transition-normal']).toBe('180ms var(--mn-ease-standard)')
    expect(semanticRoot['--mn-transition-slow']).toBe('320ms var(--mn-ease-emphasized)')
  })

  it('lets both the OS media query and explicit preference win the :root cascade', () => {
    const source = read('semantic.css')
    const explicit = parseBlocks(source).get('[data-reduced-motion]') ?? {}
    expect(source).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*html:root\s*\{/)
    expect(explicit['--mn-transition-fast']).toBe('0ms linear')
    expect(explicit['--mn-transition-normal']).toBe('0ms linear')
    expect(explicit['--mn-transition-slow']).toBe('0ms linear')
    expect(explicit['--mn-wire-pulse-animation']).toBe('none')
    expect(source).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?--mn-wire-pulse-animation:\s*none/)
  })
})

describe('@shrubbery/tokens — mature Garden compatibility vocabulary', () => {
  it('routes legacy surface and ramp names through go-forward semantic roles', () => {
    expect(semanticRoot['--mn-color-panel-bg']).toBe('var(--mn-color-surface-panel)')
    expect(semanticRoot['--mn-color-neutral-100']).toBe('var(--mn-color-surface-subtle)')
    expect(semanticRoot['--mn-color-primary-500']).toBe('var(--mn-color-accent)')
    expect(semanticRoot['--mn-color-primary-600']).toBe('var(--mn-color-accent-hover)')
    expect(semanticRoot['--mn-color-primary-700']).toBe('var(--mn-color-accent-active)')
    expect(semanticRoot['--mn-color-accent-700']).toBe('var(--mn-color-warning-strong)')
    expect(semanticRoot['--mn-color-danger-700']).toBe('var(--mn-color-danger-strong)')
  })

  it('keeps lifted typography and shared panel geometry on the semantic scale', () => {
    expect(semanticRoot['--mn-leading-normal']).toBe('var(--mn-leading-ui)')
    expect(semanticRoot['--mn-leading-relaxed']).toBe('var(--mn-leading-prose)')
    expect(semanticRoot['--mn-editor-line-height']).toBe('var(--mn-leading-prose)')
    expect(semanticRoot['--mn-y-slice-1-height']).toBe('var(--mn-top-bar-height, 46px)')
    expect(semanticRoot['--mn-touch-target-size']).toBe('48px')
  })
})

describe('@shrubbery/tokens — material hierarchy', () => {
  it('keeps every surface role addressable while resolving them to ONE paper', () => {
    // This test used to assert the roles were mutually DISTINCT. They had
    // drifted to nine separately-chosen hexes that did not agree on hue —
    // greenish chrome beside yellowish warm beside two near-whites — which
    // reads as inconsistency rather than hierarchy. Garden has one paper and
    // expresses depth as translucency over it (cloud-1's own model: four roles
    // across two values). The role NAMES stay; components address them.
    const roles = [
      '--mn-color-surface-canvas',
      '--mn-color-surface-base',
      '--mn-color-surface-editor',
      '--mn-color-surface-panel',
      '--mn-color-surface-chrome',
      '--mn-color-surface-raised',
      '--mn-color-surface-elevated',
      '--mn-color-surface-overlay',
      '--mn-color-surface-sunken',
      '--mn-color-surface-subtle',
      '--mn-color-surface-warm',
    ]
    for (const role of roles) expect(semanticRoot[role], `${role} present`).toBeDefined()

    const paper = resolveIn(baseRoot, 'var(--mn-color-paper)')
    for (const role of [
      '--mn-color-surface-canvas',
      '--mn-color-surface-base',
      '--mn-color-surface-editor',
      '--mn-color-surface-panel',
      '--mn-color-surface-chrome',
      '--mn-color-surface-subtle',
      '--mn-color-surface-warm',
    ]) {
      expect(resolveIn(baseRoot, semanticRoot[role]), `${role} is the paper`).toBe(paper)
    }

    // The two deliberate exceptions: a card lifts OFF the paper, and a well is
    // a wash over it rather than a second colour.
    expect(resolveIn(baseRoot, semanticRoot['--mn-color-surface-raised'])).not.toBe(paper)
    expect(semanticRoot['--mn-color-surface-sunken']).toContain('rgba')
  })

  it('exports shared depth, atmosphere, and prose rhythm roles', () => {
    // Garden's own atmosphere is NONE: a green radial wash plus a white
    // diagonal sheen shifted the paper colour across the viewport and read as
    // a gradient at the edges. Cloud-1's token layer has no gradients at all.
    // The role stays defined so app-owned skins can still set one.
    expect(semanticRoot['--mn-atmosphere']).toBe('none')
    expect(semanticRoot['--mn-shadow-chrome']).toBeDefined()
    expect(semanticRoot['--mn-shadow-card']).toBe('var(--mn-shadow-xs)')
    expect(semanticRoot['--mn-shadow-composer-focus']).toContain('var(--mn-focus-ring)')
    expect(semanticRoot['--mn-leading-prose']).toBe('1.72')
    expect(semanticRoot['--mn-measure-prose']).toBe('72ch')
  })

  it('keeps dark charcoal rather than black, and on ONE paper like light', () => {
    // This used to assert the dark surfaces were mutually distinct. They had
    // drifted to eleven opaque darks, so the editor read as a bounded
    // rectangle even though nothing in dark draws a border — the boundary was
    // in colour. Same rule as light: one ground, depth as translucency.
    const dark = parseBlocks(read('theme-dark.css')).get('[data-theme="dark"]') ?? {}
    expect(dark['--mn-color-paper']).not.toBe('#000000')
    for (const role of [
      '--mn-color-surface-canvas',
      '--mn-color-surface-base',
      '--mn-color-surface-editor',
      '--mn-color-surface-panel',
      '--mn-color-surface-chrome',
    ]) {
      expect(dark[role], `${role} is the paper`).toBe('var(--mn-color-paper)')
    }
    // On dark, lifting means lighter; a well is still a wash.
    expect(dark['--mn-color-surface-raised']).not.toBe('var(--mn-color-paper)')
    expect(dark['--mn-color-surface-sunken']).toContain('rgba')
    expect(dark['--mn-color-text-primary']).not.toBe('#ffffff')
    expect(dark['--mn-atmosphere']).toBe('none')
  })

  it('keeps dark body text OUT of the halation band', () => {
    // Bright text on a dark ground blooms optically into the surround, and the
    // strokes it closes up first are the thin ones — which on a serif are the
    // hairlines. Cloud-1 measured 16.7:1 against a 21:1 ceiling, with text
    // #f7f5f0: the light-mode paper, inverted. That is why its dark mode was
    // hard to read, and much harder with astigmatism.
    const dark = parseBlocks(read('theme-dark.css')).get('[data-theme="dark"]') ?? {}
    const ratio = contrastRatio(dark['--mn-color-text-primary'], dark['--mn-color-paper'])
    expect(ratio, 'body text below the readable floor').toBeGreaterThan(10)
    expect(ratio, 'body text bright enough to bloom on a dark ground').toBeLessThan(12.5)
  })
})

describe('@shrubbery/tokens — editor material axis', () => {
  const materialBlocks = parseBlocks(read('editor-material.css'))
  const defaults = materialBlocks.get(':root') ?? {}
  const paper = materialBlocks.get('[data-editor-material="paper"]') ?? {}

  it('keeps continuous editing as the attribute-free default', () => {
    expect(EDITOR_MATERIAL_APPLICATIONS.continuous.value).toBeNull()
    expect(EDITOR_MATERIAL_APPLICATIONS.continuous.appliesAttribute).toContain('removeAttribute')
    expect(defaults['--mn-editor-sheet-width']).toContain('var(--mn-editor-line-width, 784px)')
  })

  it('registers an honest paper surface without claiming pagination', () => {
    expect(EDITOR_MATERIAL_APPLICATIONS.paper.appliesAttribute).toBe('[data-editor-material=paper]')
    // The page's width follows the line width (664px of text by default,
    // plus its 76px side padding: the old 816px Letter sheet).
    expect(paper['--mn-editor-sheet-width']).toContain('var(--mn-editor-line-width, 664px) + 152px')
    expect(paper['--mn-editor-sheet-min-height']).toContain('1056px')
    expect(paper['--mn-editor-sheet-surface']).toBe('#fffdf8')
  })

  it('has only the two materials, and neither draws a ruler (Eschaton, 2026-10-14)', () => {
    expect(Object.keys(EDITOR_MATERIAL_APPLICATIONS).sort()).toEqual(['continuous', 'paper'])
    expect([...materialBlocks.keys()].sort()).toEqual([':root', '[data-editor-material="paper"]'])
    expect(read('editor-material.css')).not.toContain('ruler')
  })

  it('applies and removes the editor material attribute through the canonical applier', () => {
    const attrs = new Map<string, string>()
    const target: AttrTarget = {
      setAttribute: (name, value) => { attrs.set(name, value) },
      removeAttribute: name => { attrs.delete(name) },
    }

    applyEditorMaterial({ material: 'paper', target })
    expect(attrs.get('data-editor-material')).toBe('paper')
    applyEditorMaterial({ material: 'continuous', target })
    expect(attrs.has('data-editor-material')).toBe(false)
  })

  it.each([
    ['research', 'skin-research.css', '[data-skin="research"]', '[data-theme="dark"][data-skin="research"]', '#586f93'],
    ['greenhouse', 'skin-greenhouse.css', '[data-skin="greenhouse"]', '[data-theme="dark"][data-skin="greenhouse"]', '#2f7d5f'],
    ['observatory', 'skin-observatory.css', '[data-skin="observatory"]', '[data-theme="dark"][data-skin="observatory"]', '#028fad'],
  ])('%s maps the complete material hierarchy and its own physical-page accent', (
    _skin,
    file,
    lightSelector,
    darkSelector,
    paperAccent,
  ) => {
    const blocks = parseBlocks(read(file))
    const light = blocks.get(lightSelector) ?? {}
    const dark = blocks.get(darkSelector) ?? {}
    for (const role of [
      '--mn-color-surface-canvas',
      '--mn-color-surface-editor',
      '--mn-color-surface-panel',
      '--mn-color-surface-chrome',
      '--mn-color-surface-elevated',
      '--mn-color-surface-overlay',
      '--mn-color-text-title',
      '--mn-color-text-quiet',
      '--mn-color-backdrop',
      '--mn-atmosphere',
    ]) {
      expect(light[role], `${role} light`).toBeDefined()
      expect(dark[role], `${role} dark`).toBeDefined()
    }
    expect(resolveRef(light['--mn-editor-paper-accent'])).toBe(paperAccent)
  })
})

describe('@shrubbery/tokens — z-layer contract (Tier 1, theme-invariant)', () => {
  const zBlocks = parseBlocks(read('z-layers.css'))
  const z = zBlocks.get(':root') ?? {}

  const ORDER = [
    ['--mn-z-delivery-shell', 'deliveryShell'],
    ['--mn-z-wire-overlay', 'wireOverlay'],
    ['--mn-z-dropdown-backdrop', 'dropdownBackdrop'],
    ['--mn-z-dropdown', 'dropdown'],
    ['--mn-z-popover', 'popover'],
    ['--mn-z-tooltip', 'tooltip'],
    ['--mn-z-modal-backdrop', 'modalBackdrop'],
    ['--mn-z-modal', 'modal'],
    ['--mn-z-overlay', 'overlay'],
    ['--mn-z-toast', 'toast'],
  ] as const

  it('defines all ten tokens with the exact Z_LAYERS values (CSS agrees with the TS constant)', () => {
    for (const [token, key] of ORDER) {
      expect(z[token], `${token} present`).toBeDefined()
      expect(Number(z[token]), `${token} value`).toBe(Z_LAYERS[key])
    }
  })

  it('is strictly ascending in the documented sequence (delivery-shell < … < toast)', () => {
    const values = ORDER.map(([token]) => Number(z[token]))
    for (let i = 1; i < values.length; i++) {
      expect(values[i], `${ORDER[i][0]} > ${ORDER[i - 1][0]}`).toBeGreaterThan(values[i - 1])
    }
  })

  it('tokens.css imports z-layers.css after component.css and before theme-dark.css', () => {
    const entry = read('tokens.css')
    const componentIdx = entry.indexOf("@import './component.css';")
    const zLayersIdx = entry.indexOf("@import './z-layers.css';")
    const themeDarkIdx = entry.indexOf("@import './theme-dark.css';")
    expect(componentIdx).toBeGreaterThanOrEqual(0)
    expect(zLayersIdx).toBeGreaterThanOrEqual(0)
    expect(themeDarkIdx).toBeGreaterThanOrEqual(0)
    expect(zLayersIdx).toBeGreaterThan(componentIdx)
    expect(zLayersIdx).toBeLessThan(themeDarkIdx)
  })

  it('keeps the contract in exactly one file — no --mn-z-* definitions leak into skin/theme CSS', () => {
    const skinAndThemeFiles = [
      'theme-dark.css',
      'editor-material.css',
      'stance.css',
      'kind.css',
      'skin-garden.css',
      'skin-research.css',
      'skin-greenhouse.css',
      'skin-observatory.css',
    ]
    for (const file of skinAndThemeFiles) {
      const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
      expect(css, `${file} defines no --mn-z-*`).not.toMatch(/--mn-z-[a-z-]*\s*:/)
    }
  })
})

describe('@shrubbery/tokens — stance axis (orthogonal room posture)', () => {
  const stanceBlocks = parseBlocks(read('stance.css'))
  const root = stanceBlocks.get(':root') ?? {}
  const room = stanceBlocks.get('[data-stance="room"]') ?? {}
  const bench = stanceBlocks.get('[data-stance="bench"]') ?? {}
  const constitution = stanceBlocks.get('[data-stance="constitution"]') ?? {}
  const dispatch = stanceBlocks.get('[data-stance="dispatch"]') ?? {}
  const contested = stanceBlocks.get('[data-stance="contested"]') ?? {}

  const semanticBlock = parseBlocks(read('semantic.css')).get(':root') ?? {}
  const darkBlock = parseBlocks(read('theme-dark.css')).get('[data-theme="dark"]') ?? {}
  const semanticResolveBlock: Block = { ...baseRoot, ...semanticBlock }
  const darkResolveBlock: Block = { ...baseRoot, ...semanticBlock, ...darkBlock }

  it('ships as a first-class CSS layer with stance register variables — five one-hot registers', () => {
    expect(root['--mn-stance-register-room']).toBe('0')
    expect(root['--mn-stance-register-contested']).toBe('0')
    expect(room['--mn-stance-register-room']).toBe('1')
    expect(bench['--mn-stance-register-bench']).toBe('1')
    expect(constitution['--mn-stance-register-constitution']).toBe('1')
    expect(dispatch['--mn-stance-register-dispatch']).toBe('1')
    expect(contested['--mn-stance-register-contested']).toBe('1')
    expect(contested['--mn-stance-register-current']).toBe('contested')

    // One-hot invariant over all five registers, for every block including :root.
    const REGISTERS = [
      '--mn-stance-register-room',
      '--mn-stance-register-bench',
      '--mn-stance-register-constitution',
      '--mn-stance-register-dispatch',
      '--mn-stance-register-contested',
    ] as const
    for (const [name, block] of [
      ['room', room], ['bench', bench], ['constitution', constitution],
      ['dispatch', dispatch], ['contested', contested],
    ] as const) {
      const ones = REGISTERS.filter(r => block[r] === '1')
      expect(ones, `${name} block is one-hot`).toEqual([`--mn-stance-register-${name}`])
    }
  })

  it('maps each stance to its appliesAttribute hook, including contested', () => {
    expect(STANCE_APPLICATIONS.room.appliesAttribute).toBe('[data-stance=room]')
    expect(STANCE_APPLICATIONS.bench.appliesAttribute).toBe('[data-stance=bench]')
    expect(STANCE_APPLICATIONS.constitution.appliesAttribute).toBe('[data-stance=constitution]')
    expect(STANCE_APPLICATIONS.dispatch.appliesAttribute).toBe('[data-stance=dispatch]')
    expect(STANCE_APPLICATIONS.contested.appliesAttribute).toBe('[data-stance=contested]')
    expect(STANCE_APPLICATIONS.contested.attr).toBe('data-stance')
    expect(STANCE_APPLICATIONS.contested.value).toBe('contested')
  })

  it('ROOM_POSTURE_STANCES excludes contested', () => {
    expect(ROOM_POSTURE_STANCES).toEqual(['room', 'bench', 'constitution', 'dispatch'])
    expect(ROOM_POSTURE_STANCES).not.toContain('contested')
  })

  it('applyStance({stance:"contested"}) fails to compile (D-8, RoomPostureStance narrowing)', () => {
    // @ts-expect-error — 'contested' is not assignable to RoomPostureStance.
    applyStance({ stance: 'contested' })
  })

  it('[data-stance=contested] re-points all three annunciator vars at the contested semantic triple', () => {
    expect(contested['--mn-stance-annunciator-ink']).toBe('var(--mn-stance-contested-ink)')
    expect(contested['--mn-stance-annunciator-edge']).toBe('var(--mn-stance-contested-edge)')
    expect(contested['--mn-stance-annunciator-wash']).toBe('var(--mn-stance-contested-wash)')
  })

  it('the contested semantic triple resolves to CONTESTED_STANCE in light — the RESERVED wine, reused not re-invented', () => {
    const ink = resolveIn(semanticResolveBlock, semanticBlock['--mn-stance-contested-ink'])
    const edge = resolveIn(semanticResolveBlock, semanticBlock['--mn-stance-contested-edge'])
    const wash = resolveIn(semanticResolveBlock, semanticBlock['--mn-stance-contested-wash'])
    expect(ink).toBe(CONTESTED_STANCE.ink.toLowerCase())
    expect(ink).toBe('#880134') // the RESERVED swatch — exact, unchanged
    expect(edge).toBe(CONTESTED_STANCE.edgeLight.toLowerCase())
    expect(wash).toBe(CONTESTED_STANCE.washLight.toLowerCase())
  })

  it('the contested semantic triple resolves to CONTESTED_STANCE dark counterparts under [data-theme=dark]', () => {
    const ink = resolveIn(darkResolveBlock, darkBlock['--mn-stance-contested-ink'])
    const edge = resolveIn(darkResolveBlock, darkBlock['--mn-stance-contested-edge'])
    const wash = resolveIn(darkResolveBlock, darkBlock['--mn-stance-contested-wash'])
    expect(ink).toBe(CONTESTED_STANCE.inkDark.toLowerCase())
    expect(edge).toBe(CONTESTED_STANCE.edgeDark.toLowerCase())
    expect(wash).toBe(CONTESTED_STANCE.washDark.toLowerCase())
  })

  it('the dark ink resolves via var(--mn-ref-status-critical-ink-dark) — theme-dark.css contains no bare hex for it (§6.6.3 regression)', () => {
    expect(darkBlock['--mn-stance-contested-ink']).toBe('var(--mn-ref-status-critical-ink-dark)')
    // No literal-hex assignment to --mn-stance-contested-ink anywhere in theme-dark.css.
    const rawThemeDark = read('theme-dark.css')
    expect(rawThemeDark).not.toMatch(/--mn-stance-contested-ink:\s*#[0-9a-fA-F]{3,8}\s*;/)
  })
})

describe('@shrubbery/tokens — DisplayKind register axis', () => {
  const kindBlocks = parseBlocks(read('kind.css'))
  const root = kindBlocks.get(':root') ?? {}
  const metric = kindBlocks.get('.mn-kind[data-kind="metric"]') ?? {}
  const reference = kindBlocks.get('.mn-kind[data-kind="reference"]') ?? {}
  const testimony = kindBlocks.get('.mn-kind[data-kind="testimony"]') ?? {}

  it('ships token hooks for kinded render values', () => {
    expect(root['--mn-kind-text']).toBe('var(--mn-color-text-primary)')
    expect(metric['--mn-kind-register-current']).toBe('metric')
    expect(reference['--mn-kind-register-current']).toBe('reference')
    expect(testimony['--mn-kind-register-current']).toBe('testimony')
  })

  it('maps each DisplayKind to its appliesAttribute hook', () => {
    expect(KIND_APPLICATIONS.identity.appliesAttribute).toBe('[data-kind=identity]')
    expect(KIND_APPLICATIONS.state.appliesAttribute).toBe('[data-kind=state]')
    expect(KIND_APPLICATIONS.metric.appliesAttribute).toBe('[data-kind=metric]')
    expect(KIND_APPLICATIONS.prose.appliesAttribute).toBe('[data-kind=prose]')
    expect(KIND_APPLICATIONS.reference.appliesAttribute).toBe('[data-kind=reference]')
    expect(KIND_APPLICATIONS.testimony.appliesAttribute).toBe('[data-kind=testimony]')
    expect(KIND_APPLICATIONS.affordance.appliesAttribute).toBe('[data-kind=affordance]')
  })
})

describe('@shrubbery/tokens — the {skin,theme} → root-attribute applier', () => {
  // A real minimal AttrTarget (no DOM mock framework — a plain map of attrs).
  function makeTarget() {
    const attrs = new Map<string, string>()
    const target: AttrTarget = {
      setAttribute: (n, v) => void attrs.set(n, v),
      removeAttribute: n => void attrs.delete(n),
    }
    return { target, attrs }
  }

  it('research + light stamps [data-skin=research] [data-theme=light]', () => {
    const { target, attrs } = makeTarget()
    applySkinTheme({ skin: 'research', theme: 'light', target })
    expect(attrs.get('data-skin')).toBe('research')
    expect(attrs.get('data-theme')).toBe('light')
  })

  it('greenhouse + light stamps [data-skin=greenhouse] [data-theme=light]', () => {
    const { target, attrs } = makeTarget()
    applySkinTheme({ skin: 'greenhouse', theme: 'light', target })
    expect(attrs.get('data-skin')).toBe('greenhouse')
    expect(attrs.get('data-theme')).toBe('light')
  })

  it('observatory + light stamps [data-skin=observatory] [data-theme=light]', () => {
    const { target, attrs } = makeTarget()
    applySkinTheme({ skin: 'observatory', theme: 'light', target })
    expect(attrs.get('data-skin')).toBe('observatory')
    expect(attrs.get('data-theme')).toBe('light')
  })

  it('garden REMOVES data-skin (the "[data-skin] absent" sux default)', () => {
    const { target, attrs } = makeTarget()
    attrs.set('data-skin', 'research') // pretend a prior skin was set
    applySkinTheme({ skin: 'garden', theme: 'dark', target })
    expect(attrs.has('data-skin')).toBe(false) // removeAttribute, per sux value
    expect(attrs.get('data-theme')).toBe('dark')
  })

  it('the map mirrors the sux ConfigValue.appliesAttribute literals', () => {
    expect(SKIN_APPLICATIONS.garden.appliesAttribute).toBe(
      '[data-skin] absent (removeAttribute)',
    )
    expect(SKIN_APPLICATIONS.research.appliesAttribute).toBe('[data-skin=research]')
    expect(SKIN_APPLICATIONS.greenhouse.appliesAttribute).toBe('[data-skin=greenhouse]')
    expect(SKIN_APPLICATIONS.observatory.appliesAttribute).toBe('[data-skin=observatory]')
    expect(THEME_APPLICATIONS.dark.appliesAttribute).toBe('[data-theme=dark]')
    expect(THEME_APPLICATIONS.light.appliesAttribute).toBe('[data-theme=light]')
    expect(STANCE_APPLICATIONS.room.appliesAttribute).toBe('[data-stance=room]')
  })

  it('returns the applied ConfigValue applications (for logging, not store reads)', () => {
    const { target } = makeTarget()
    const applied = applySkinTheme({ skin: 'research', theme: 'dark', target })
    expect(applied.skin.literalValue).toBe('research')
    expect(applied.theme.literalValue).toBe('dark')
  })

  it('can update either appearance axis without disturbing the other', () => {
    const { target, attrs } = makeTarget()
    applySkinTheme({ skin: 'greenhouse', theme: 'dark', target })
    applySkin({ skin: 'research', target })
    expect(attrs.get('data-skin')).toBe('research')
    expect(attrs.get('data-theme')).toBe('dark')
    applyTheme({ theme: 'light', target })
    expect(attrs.get('data-skin')).toBe('research')
    expect(attrs.get('data-theme')).toBe('light')
  })

  it('defines a single-skin visual-identity cycle (Garden only)', () => {
    expect(VISUAL_IDENTITY_SKINS).toEqual(['garden'])
    expect(nextVisualIdentitySkin('garden')).toBe('garden')
    expect(nextVisualIdentitySkin('research')).toBe('garden')
  })

  it('stamps [data-stance=room] as the Greenhouse root posture', () => {
    const { target, attrs } = makeTarget()
    const applied = applyStance({ stance: 'room', target })
    expect(attrs.get('data-stance')).toBe('room')
    expect(applied.literalValue).toBe('room')
  })

  it('applyKind stamps data-kind per KIND_APPLICATIONS for every register value', () => {
    const kinds: readonly DisplayKindRegister[] = [
      'identity',
      'state',
      'metric',
      'prose',
      'reference',
      'testimony',
      'affordance',
    ]
    for (const kind of kinds) {
      const { target, attrs } = makeTarget()
      const applied = applyKind({ kind, target })
      expect(attrs.get('data-kind'), kind).toBe(KIND_APPLICATIONS[kind].value)
      expect(attrs.get('data-kind'), kind).toBe(kind)
      expect(applied).toBe(KIND_APPLICATIONS[kind])
    }
  })

  it('applyKind re-stamps (a later kind overwrites an earlier one)', () => {
    const { target, attrs } = makeTarget()
    applyKind({ kind: 'metric', target })
    expect(attrs.get('data-kind')).toBe('metric')
    applyKind({ kind: 'testimony', target })
    expect(attrs.get('data-kind')).toBe('testimony')
  })
})

describe('@shrubbery/tokens — ghost vars the layer now owns', () => {
  // Each of these was CONSUMED by components but DEFINED nowhere, so every call
  // site fell to whatever literal its author typed — and the authors disagreed.
  // That divergence, not damaged components, is what read as "inconsistent".
  it('defines the roles that used to fall through to hand-typed literals', () => {
    for (const tok of [
      '--mn-color-focus',
      '--mn-focus-ring-width',
      '--mn-color-on-accent',
      '--mn-font-ui',
      '--mn-space-2-5',
      '--mn-space-3-5',
      '--mn-radius-xs',
    ]) {
      expect(baseRoot[tok], `${tok} defined`).toBeDefined()
    }
  })

  it('binds the ghost --mn-type-* scale to the real scale, not to fresh literals', () => {
    const bindings: ReadonlyArray<readonly [string, string]> = [
      ['--mn-type-ui-size', '--mn-text-sm'],
      ['--mn-type-ui-sm-size', '--mn-text-xs'],
      ['--mn-type-micro-size', '--mn-text-2xs'],
      ['--mn-type-label-size', '--mn-text-xs'],
      ['--mn-type-label-family', '--mn-font-chrome'],
      ['--mn-type-label-weight', '--mn-font-weight-medium'],
      ['--mn-type-label-tracking', '--mn-tracking-label'],
    ]
    for (const [ghost, role] of bindings) {
      expect(baseRoot[ghost], `${ghost} defined`).toBeDefined()
      expect(baseRoot[ghost], `${ghost} points at ${role}`).toBe(`var(${role})`)
      expect(resolveIn(baseRoot, baseRoot[ghost])).toBe(resolveIn(baseRoot, `var(${role})`))
    }
  })

  it('routes focus through the one focus role, not a second blue', () => {
    // 3 of 4 call sites had fallen back to Tailwind #2563eb.
    expect(resolveIn(baseRoot, baseRoot['--mn-color-focus']))
      .toBe(resolveIn(baseRoot, 'var(--mn-color-border-focus)'))
    expect(resolveIn(baseRoot, baseRoot['--mn-color-focus'])).not.toBe('#2563eb')
  })

  it('gives the UI font role the serif chrome, not raw system-ui', () => {
    // cloud-1 index.css:179 — "Radical Move: UI uses Serif". Garden's chrome
    // is the serif (Piazzolla); the sans stack is for utility surfaces, not the room.
    expect(baseRoot['--mn-font-ui']).toBe('var(--mn-font-chrome)')
    expect(resolveIn(baseRoot, baseRoot['--mn-font-ui'])).toContain('Piazzolla')
  })

  it('completes the spacing half-steps the scale already implied', () => {
    expect(baseRoot['--mn-space-2-5']).toBe('0.625rem')
    expect(baseRoot['--mn-space-3-5']).toBe('0.875rem')
  })
})

describe('@shrubbery/tokens — the CSS actually parses', () => {
  // Every other test here reads declarations with a regex, which is happy to
  // "pass" on a file postcss cannot parse at all. A nested /* */ inside a
  // comment closed one early and shipped a broken semantic.css past a green
  // suite; only the organism build test caught it.
  it.each([
    'semantic.css', 'reference.css', 'component.css', 'theme-dark.css',
    'skin-garden.css', 'z-layers.css', 'tokens.css',
  ])('%s has balanced comments and braces', (file) => {
    const css = read(file)
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments.match(/\/\*|\*\//g) ?? [], `${file}: stray comment delimiter`).toHaveLength(0)
    const opens = (css.match(/\{/g) ?? []).length
    const closes = (css.match(/\}/g) ?? []).length
    expect(opens, `${file}: unbalanced braces`).toBe(closes)
  })
})

