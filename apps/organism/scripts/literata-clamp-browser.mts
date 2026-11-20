/**
 * literata-clamp-browser.mts — Literata's bold really is 600 in the real app.
 *
 * The clamp lives in a stylesheet (`packages/tokens/css/literata-clamped.css`),
 * and a stylesheet is exactly the kind of thing that can be correct and never
 * reach the page: an import that resolves to the wrong file, a bundler that
 * hoists fontsource's own `200 900` face back in alongside ours, a family-name
 * mismatch. None of those raise an error. All of them look like "we changed the
 * font and nothing happened".
 *
 * So this asks the running page two questions it cannot fake:
 *
 *   1. Does any loaded @font-face for Literata still declare a weight above
 *      600? `document.fonts` reports the declared range, so a stray fontsource
 *      import is visible by name.
 *   2. Does text set to 700 render the same as text set to 600? If the clamp is
 *      live they are pixel-identical; if it is not, 700 carries ~14% more ink.
 *
 * Question 2 is the one that matters — question 1 can pass while a second face
 * wins the match.
 *
 *   pnpm -C apps/organism run test:literata-clamp
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.SHRUBBERY_LITERATA_PORT ?? 5251)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`literata-clamp-browser assertion failed: ${message}`)
}

const server = await createServer({
  root: appDir,
  configFile: resolve(appDir, 'vite.config.ts'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  logLevel: 'warn',
})
await server.listen()
const browser = await chromium.launch({ headless: process.env.SHRUBBERY_HEADED !== '1' })
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 })

try {
  await page.goto(`http://127.0.0.1:${port}/browser-harness.html`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(500)

  const faces = await page.evaluate(() =>
    [...document.fonts]
      .filter(face => /literata/i.test(face.family))
      .map(face => ({ family: face.family, weight: face.weight, status: face.status })))
  console.log('Literata faces on the page:', JSON.stringify(faces, null, 2))
  assert(faces.length > 0, 'Literata is actually loaded — otherwise everything below tests a fallback')

  const overweight = faces.filter(face => {
    const top = Number(String(face.weight).split(' ').pop())
    return Number.isFinite(top) && top > 600
  })
  assert(
    overweight.length === 0,
    `no Literata face declares a weight above 600: ${JSON.stringify(overweight)}`,
  )

  // The measurement. Same words, same size; only the requested weight differs.
  // NOTE: no named inner function here. tsx compiles this file with esbuild's
  // keepNames helper, which rewrites `const measure = (w) => …` into a call to
  // `__name(...)` — a helper that exists in Node and not in the page, so the
  // evaluate dies with "__name is not defined". The loop is inlined for that
  // reason, not for style.
  const ink = await page.evaluate(async () => {
    await document.fonts.load("600 32px 'Literata Variable'")
    await document.fonts.load("700 32px 'Literata Variable'")
    const out: Record<string, number> = {}
    for (const weight of [400, 600, 650, 700]) {
      const canvas = document.createElement('canvas')
      canvas.width = 1200
      canvas.height = 80
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#000'
      ctx.font = `${weight} 32px 'Literata Variable'`
      ctx.fillText('Handgloves quick brown fox', 10, 50)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let dark = 0
      for (let i = 0; i < data.length; i += 4) dark += 255 - data[i]
      out[`w${weight}`] = dark
    }
    return out as { w400: number; w600: number; w650: number; w700: number }
  })
  console.log('ink by requested weight:', JSON.stringify(ink))

  // A sanity floor: 400 and 600 must still differ, or the family is not
  // rendering variable weights at all and the equality below would be vacuous.
  assert(ink.w600 > ink.w400 * 1.05, `the weight axis still works: 400=${ink.w400} 600=${ink.w600}`)
  assert(ink.w700 === ink.w600, `700 is clamped to 600: 700=${ink.w700} 600=${ink.w600}`)
  assert(ink.w650 === ink.w600, `650 is clamped to 600: 650=${ink.w650} 600=${ink.w600}`)

  console.log('\nLiterata is clamped at 600 in the real app. Cloud-1 parity holds.')
} finally {
  await browser.close()
  await server.close()
}
