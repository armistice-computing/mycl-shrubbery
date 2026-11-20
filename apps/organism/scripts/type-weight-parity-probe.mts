/**
 * type-weight-parity-probe.mts — why Shrubbery's text is heavier than cloud-1's.
 *
 * THE REPORT: "we matched all the font sizes but everything is just a little
 * thicker... it's most noticable on bold." Measured on the same display in the
 * same browser, so it was never a renderer difference.
 *
 * THE FIRST THEORY WAS WRONG, and this probe is what killed it. Cloud-1 loads
 * Literata from Google Fonts with the optical-size axis (`opsz,wght@0,7..72,…`)
 * while Shrubbery imports `@fontsource-variable/literata/standard.css`, so the
 * obvious story was that we had dropped optical sizing and were rendering every
 * size at one optical instance. The two files are BYTE-IDENTICAL — same MD5 —
 * and rendered identically here. A tidy explanation that measurement refused.
 *
 * WHAT IT ACTUALLY IS: the declared weight RANGE on the @font-face.
 *
 * Cloud-1's Google Fonts request asks for weights 400, 500 and 600 only, so the
 * served face declares `font-weight: 400 600`. A variable font is clamped to its
 * declared range — so every `font-weight: 700` in cloud-1 silently renders at
 * 600. Shrubbery bundles the same outlines declared `font-weight: 200 900`, and
 * 700 renders at a true 700.
 *
 * Measured, same file, same sizes, the only difference being the declared range:
 *
 *     weight 400/500/600   identical, to the pixel
 *     weight 650           +7%  ink
 *     weight 700           +14% ink, and ~13px wider per line at 32px
 *
 * Which is exactly the report: regular text matches, bold does not.
 *
 *   pnpm -C apps/organism exec tsx scripts/type-weight-parity-probe.mts
 */
import { chromium } from 'playwright'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

const OUT_DIR = process.env.SHRUBBERY_TYPE_PROBE_DIR ?? '/private/tmp'

const PKG = resolve(
  dirname(fileURLToPath(import.meta.url)), '../../../node_modules/.pnpm',
  '@fontsource-variable+literata@5.2.8/node_modules/@fontsource-variable/literata/files',
)
// Inlined as data: URLs. A file:// page cannot load a file:// font (the fetch
// is cross-origin and blocked), and the first run of this probe reported the
// two builds as byte-identical because BOTH had silently fallen back to the
// default serif. An instrument that cannot tell "identical" from "absent" is
// not an instrument.
const dataUrl = (file: string): string =>
  `data:font/woff2;base64,${readFileSync(resolve(PKG, file)).toString('base64')}`
// NOTE: standard-normal and opsz-normal are the SAME FILE (identical MD5), so
// the optical-size theory this probe was written for is dead — measured, not
// argued. What actually differs between the two apps is the DECLARED WEIGHT
// RANGE on the @font-face.
//
// Cloud-1 loads Literata from Google Fonts as `wght@…400;…500;…600` — Google
// serves a face declaring `font-weight: 400 600`. A variable font is clamped to
// its declared range, so every `font-weight: 700` in cloud-1 renders at 600.
// Shrubbery bundles the same outlines declared `font-weight: 200 900`, so 700
// renders at a real 700. Same family, same size, heavier bold.
const literata = dataUrl('literata-latin-standard-normal.woff2')

const SIZES = [16, 20, 32, 40]
const page_html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'LitStandard'; src: url('${literata}') format('woff2-variations'); font-weight: 200 900; }
@font-face { font-family: 'LitOpsz';     src: url('${literata}') format('woff2-variations'); font-weight: 400 600; }
html, body { margin: 0; background: #fff; }
.row { display: inline-block; background: #fff; color: #000; white-space: nowrap; padding: 4px 8px; }
</style></head><body>
${SIZES.map(size => [400, 500, 600, 650, 700].map(weight => `
  <div><span class="row" data-k="standard-${size}-${weight}" style="font-family:LitStandard;font-size:${size}px;font-weight:${weight}">Handgloves quick brown fox</span></div>
  <div><span class="row" data-k="opsz-${size}-${weight}"     style="font-family:LitOpsz;font-size:${size}px;font-weight:${weight}">Handgloves quick brown fox</span></div>
`).join('')).join('')}
</body></html>`

const path = resolve(OUT_DIR, 'opsz.html')
writeFileSync(path, page_html)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 2 })
await page.goto(`file://${path}`)
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(400)

// Prove BOTH faces actually loaded before comparing them.
const loaded = await page.evaluate(() => ({
  standard: document.fonts.check('32px LitStandard'),
  opsz: document.fonts.check('32px LitOpsz'),
  families: [...document.fonts].map(f => `${f.family} ${f.status}`),
}))
console.log('fonts loaded:', JSON.stringify(loaded))
if (!loaded.standard || !loaded.opsz) throw new Error('a face did not load — the comparison would be meaningless')

/** Dark pixels in one row's screenshot — the honest measure of "thicker". */
async function ink(key: string): Promise<{ ink: number; width: number }> {
  const el = page.locator(`[data-k="${key}"]`)
  const shot = await el.screenshot()
  const box = await el.boundingBox()
  const counted = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    // Sum of darkness rather than a threshold count: antialiased edges are
    // where a weight difference actually lives, and a threshold throws them away.
    for (let i = 0; i < data.length; i += 4) dark += 255 - data[i]
    return dark
  }, Array.from(shot))
  return { ink: counted, width: Math.round(box?.width ?? 0) }
}

console.log('           shrubbery(200-900)   cloud-1(400-600)     diff      widths')
for (const size of SIZES) {
  for (const weight of [400, 500, 600, 650, 700]) {
    const s = await ink(`standard-${size}-${weight}`)
    const o = await ink(`opsz-${size}-${weight}`)
    const pct = ((s.ink - o.ink) / o.ink) * 100
    console.log(
      `${String(size).padStart(3)}px/${weight}   ${String(s.ink).padStart(12)}   ${String(o.ink).padStart(16)}   `
      + `${(pct >= 0 ? '+' : '') + pct.toFixed(1)}%`.padStart(8) + `   ${s.width} vs ${o.width}`,
    )
  }
}

await page.screenshot({
  path: resolve(OUT_DIR, 'opsz-compare.png'),
  fullPage: true,
})
await browser.close()
