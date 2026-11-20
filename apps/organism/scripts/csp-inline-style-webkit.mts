/**
 * csp-inline-style-webkit.mts — does the packaged app's CSP let a component
 * position anything?
 *
 * THE BUG THIS EXISTS FOR. In the packaged Garden the wire fan renders every
 * card on top of every other card in one corner, while its connector lines fan
 * out correctly to where the cards should have been. The value gutter lands in
 * the same corner. Neither reproduces in Chromium, in WebKit under Playwright,
 * from the dev server, or from the production bundle.
 *
 * The overlay's own debug dump, read through Safari's inspector attached to the
 * running app, showed the layout was CORRECT: seven nodes, seven distinct
 * positions, 56.8px apart, seven rendered in the DOM. Computed right and not
 * applied. Beside it: "Refused to apply a stylesheet because its hash, its
 * nonce, or 'unsafe-inline' does not appear in the style-src directive".
 *
 * Cards are positioned with `style="left:…px; top:…px"`, a style ATTRIBUTE.
 * Connector lines use SVG `x1/y1/x2/y2` PRESENTATION ATTRIBUTES, which CSP has
 * no opinion about. That asymmetry is the whole symptom.
 *
 * And the app's CSP does list `'unsafe-inline'` in `style-src`. It is ignored:
 * Tauri injects a nonce into every <style> and into `style-src`
 * (tauri-utils html.rs `inject_nonce_token`), and the CSP spec says a directive
 * carrying a nonce ignores `'unsafe-inline'` entirely. The policy we wrote and
 * the policy that runs are different policies.
 *
 * So this asks the only question that settles the fix, in the engine that ships:
 * with a style-src nonce present, what does it take to let a style ATTRIBUTE
 * through? `style-src-attr` is a separate CSP3 directive that governs attributes
 * and is not affected by the nonce -- IF WebKit implements it. Believing that
 * from memory is how the last three of these went wrong, so it is measured.
 *
 *   pnpm -C apps/organism run test:csp-inline-style
 */
import { webkit } from 'playwright'

interface Case {
  readonly name: string
  readonly policy: string
  readonly expectApplied: boolean
  readonly why: string
}

/** The app's real policy, trimmed to the directives this question turns on. */
const BASE = "default-src 'self'; script-src 'self'"
const NONCE = 'tauri-abc123'

const CASES: Case[] = [
  {
    name: 'no nonce, unsafe-inline',
    policy: `${BASE}; style-src 'self' 'unsafe-inline'`,
    expectApplied: true,
    why: 'the policy as WRITTEN in tauri.conf.json — works, which is why this was invisible',
  },
  {
    name: 'nonce + unsafe-inline (what Tauri actually serves)',
    policy: `${BASE}; style-src 'self' 'unsafe-inline' 'nonce-${NONCE}'`,
    expectApplied: false,
    why: 'a nonce makes unsafe-inline inert — THE BUG',
  },
  {
    name: 'nonce + unsafe-inline + style-src-attr',
    policy: `${BASE}; style-src 'self' 'unsafe-inline' 'nonce-${NONCE}'; style-src-attr 'unsafe-inline'`,
    expectApplied: true,
    why: 'THE FIX — attributes get their own directive, which no nonce touches',
  },
]

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`csp-inline-style-webkit assertion failed: ${message}`)
}

const browser = await webkit.launch({ headless: true })
try {
  const failures: string[] = []
  for (const testCase of CASES) {
    const page = await browser.newPage()
    // A <style> carrying the nonce, so the document is shaped like the app's:
    // stylesheets allowed by nonce, and the question is only about attributes.
    await page.setContent(`<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="${testCase.policy}">
      <style nonce="${NONCE}">.probe { position: absolute; width: 10px; height: 10px; }</style>
      </head><body>
      <div class="probe" id="card" style="left: 137px; top: 42px;"></div>
      <svg width="200" height="200"><line id="wire" x1="0" y1="0" x2="137" y2="42" stroke="black"/></svg>
      </body></html>`)
    const measured = await page.evaluate(() => {
      const card = document.getElementById('card')!
      const wire = document.getElementById('wire')!
      return {
        // What the CARD got: the inline style attribute.
        left: getComputedStyle(card).left,
        top: getComputedStyle(card).top,
        // What the LINE got: an SVG presentation attribute, for contrast.
        lineX2: wire.getAttribute('x2'),
      }
    })
    await page.close()

    const applied = measured.left === '137px' && measured.top === '42px'
    const verdict = applied === testCase.expectApplied ? 'as expected' : 'UNEXPECTED'
    console.log(`${verdict.padEnd(10)} ${testCase.name}`)
    console.log(`           left=${measured.left} top=${measured.top} (line x2=${measured.lineX2}, never blocked)`)
    console.log(`           ${testCase.why}\n`)
    if (applied !== testCase.expectApplied) {
      failures.push(`${testCase.name}: inline style ${applied ? 'applied' : 'was blocked'}, expected the opposite`)
    }
  }

  assert(failures.length === 0, failures.join('; '))
  console.log('WebKit implements style-src-attr, and it survives a style-src nonce.')
  console.log('Adding `style-src-attr \'unsafe-inline\'` restores positioning without')
  console.log('giving up the nonce protection on <style> elements.')
} finally {
  await browser.close()
}
