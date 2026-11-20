/**
 * editor-math-browser.mts — does LaTeX math render, under the app's CSP?
 *
 * REPORTED: typing $$formula$$ captured the formula (the dollar signs went
 * away) but it stayed plain text.
 *
 * THE CAUSES. (1) The kernel's math nodes render through an optional host
 * `renderMath` callback, and nothing supplied it, so the default showed the raw
 * LaTeX. The runtime now supplies a KaTeX renderer (math-renderer.ts). (2) The
 * math styles were adopted onto the document, which never reaches the
 * editor's shadow root; they now go to the editor's own root.
 *
 * The run serves the app with its style and font policies (the style-src with
 * a nonce, as Tauri adds, and font-src), on a document holding an inline and
 * a block formula, then types a third one. For each it checks that KaTeX
 * rendered it, that KaTeX's layout CSS applies inside the shadow root (the
 * MathML copy is visually hidden), and that a KaTeX font loaded. Any stylesheet
 * or font the policy refused fails the run.
 *
 *   SHRUBBERY_BROWSER_ENGINE=webkit pnpm -C apps/organism run test:editor-math
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'
import { resolveGardendBin, spawnGardend, type GardendCell } from '../src/cell/spawn-gardend.js'
import { LoopbackMcpClient } from '../src/cell/loopback-mcp.js'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loopbackPath = resolve(appDir, '.gardend-loopback.json')
const port = Number(process.env.SHRUBBERY_MATH_PORT ?? 5300)
const engineName = process.env.SHRUBBERY_BROWSER_ENGINE ?? 'chromium'
if (engineName !== 'chromium' && engineName !== 'webkit') {
  throw new Error('SHRUBBERY_BROWSER_ENGINE must be chromium or webkit')
}
const engine = engineName === 'webkit' ? webkit : chromium
const GRAPH_ID = 'editor-math-probe'
const DOC_ID = 'math-doc'
const NONCE = 'harness-nonce'
// The style and font parts of garden/src-tauri/tauri.conf.json's policy, plus
// the nonce Tauri adds. Scripts and connections stay open: this harness tests
// what math needs to look right.
const CSP = `style-src 'self' 'unsafe-inline' 'nonce-${NONCE}' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src 'self' data: https://fonts.gstatic.com https://esm.sh`
// gardend's XML form: its HTML import drops math by design
// (garden html_to_tiptap.rs), the XML path keeps it.
const CONTENT = '<paragraph>Energy is <mathInline src="E = mc^2"/> in one line.</paragraph>'
  + '<mathBlock src="\\int_0^1 x^2 \\, dx = \\frac{1}{3}"/>'
  + '<paragraph>Type here:</paragraph>'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`editor-math-browser assertion failed: ${message}`)
}

let cell: GardendCell | null = null
let server: Awaited<ReturnType<typeof createServer>> | null = null
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

try {
  const bin = resolveGardendBin()
  assert(existsSync(bin), `real gardend binary at ${bin}`)
  cell = await spawnGardend({ bin, readyTimeoutMs: 30_000 })
  const mcp = new LoopbackMcpClient({
    mcpUrl: cell.mcpUrl,
    healthUrl: `${cell.apiUrl}/health`,
    token: cell.token,
    origin: 'http://127.0.0.1',
  })
  await mcp.toolsCall('create_graph', { graph_id: GRAPH_ID, title: 'math probe' })
  await mcp.toolsCall('create_document', { graphId: GRAPH_ID, documentId: DOC_ID, title: DOC_ID })
  await mcp.toolsCall('write_document', { graphId: GRAPH_ID, documentId: DOC_ID, content: CONTENT })
  writeFileSync(loopbackPath, JSON.stringify({
    apiUrl: cell.apiUrl,
    mcpUrl: cell.mcpUrl,
    token: cell.token,
    port: cell.manifest.port,
    graphId: GRAPH_ID,
  }, null, 2))
  server = await createServer({
    root: appDir,
    configFile: resolve(appDir, 'vite.config.ts'),
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
    logLevel: 'warn',
  })
  await server.listen()
  browser = await engine.launch({ headless: process.env.SHRUBBERY_HEADED !== '1' })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

  const refused: string[] = []
  page.on('console', message => {
    const text = message.text()
    // Only refusals that would hurt math: a font, or a KaTeX stylesheet. The
    // policy text itself names fonts.googleapis.com, so match the directive,
    // not the word. Vite dev's own <style> injections are refused here too,
    // and are harmless (the production build links CSS files instead).
    if (/font-src/i.test(text) || /katex/i.test(text)) refused.push(text.slice(0, 200))
  })
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message.slice(0, 200)))
  await page.route(`http://127.0.0.1:${port}/g/**`, async route => {
    if (route.request().resourceType() !== 'document') return route.continue()
    const response = await route.fetch()
    const html = (await response.text()).replace(/<style>/g, `<style nonce="${NONCE}">`)
    await route.fulfill({ response, body: html, headers: { ...response.headers(), 'content-security-policy': CSP } })
  })

  await page.goto(`http://127.0.0.1:${port}/g/${GRAPH_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.body.dataset.organismMode === 'local-cell', undefined, { timeout: 60_000 })
  await page.waitForFunction(
    () => !!document.querySelector('mn-sidebar-panel')?.shadowRoot?.querySelector('[data-file-pane-body]'),
    undefined,
    { timeout: 60_000 },
  )
  await page.evaluate((id) => {
    const panel = document.querySelector('mn-sidebar-panel') as HTMLElement | null
    ;(panel?.shadowRoot?.querySelector(`[data-node-id="${id}"]`) as HTMLElement | null)?.click()
  }, DOC_ID)
  await page.waitForFunction(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    return (host?.shadowRoot?.querySelectorAll('.editor-mount .math-node').length ?? 0) >= 2
  }, undefined, { timeout: 60_000 }).catch(async () => {
    const html = await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      return (host?.shadowRoot?.querySelector('.editor-mount .ProseMirror')?.innerHTML ?? '(no editor)').slice(0, 600)
    })
    throw new Error(`the written math never appeared as math nodes; the editor holds: ${html}`)
  })

  // Measure only after the written formulas have rendered and their fonts
  // loaded: KaTeX grows the block formula, which moves the paragraph below it.
  // Measured earlier, the click lands in the gap under the formula, where
  // ProseMirror selects the formula itself (as with an image), and typing
  // replaces it.
  await page.waitForFunction(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    return (host?.shadowRoot?.querySelectorAll('.editor-mount .math-node .katex').length ?? 0) >= 2
  }, undefined, { timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  // Type a third formula at the end of "Type here:". (No End key: on a Mac it
  // scrolls the document rather than moving to the line's end.)
  const typeAt = await page.evaluate(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    const paragraphs = host?.shadowRoot?.querySelectorAll('.editor-mount [contenteditable="true"] > p') ?? []
    const last = paragraphs[paragraphs.length - 1] as HTMLElement | undefined
    const rect = last?.getBoundingClientRect()
    return rect ? { x: rect.right - 10, y: rect.top + rect.height / 2 } : null
  })
  assert(typeAt, 'the last paragraph is on screen')
  await page.mouse.click(typeAt.x, typeAt.y)
  await page.waitForTimeout(200)
  await page.keyboard.type(' $$a^2 + b^2$$', { delay: 40 })
  await page.waitForFunction(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    return (host?.shadowRoot?.querySelectorAll('.editor-mount .math-node .katex').length ?? 0) >= 3
  }, undefined, { timeout: 15_000 }).catch(async () => {
    const dump = await page.evaluate(() => {
      const host = document.querySelector('sh-editor-host') as HTMLElement | null
      return Array.from(host?.shadowRoot?.querySelector('.editor-mount .ProseMirror')?.children ?? [])
        .map(child => child.outerHTML.slice(0, 200)).join('\n  ')
    })
    throw new Error(`three rendered formulas never appeared; the editor holds:\n  ${dump}`)
  })
  await page.evaluate(() => document.fonts.ready)

  const nodes = await page.evaluate(() => {
    const host = document.querySelector('sh-editor-host') as HTMLElement | null
    return Array.from(host?.shadowRoot?.querySelectorAll('.editor-mount .math-node') ?? []).map(node => {
      const katex = node.querySelector('.katex') as HTMLElement | null
      const mathml = node.querySelector('.katex-mathml') as HTMLElement | null
      const html = node.querySelector('.katex-html') as HTMLElement | null
      return {
        kind: node.classList.contains('math-block') ? 'block' : 'inline',
        error: node.hasAttribute('data-math-error'),
        katex: katex != null,
        // KaTeX's CSS hides the MathML copy with position:absolute + clip.
        // Without the CSS inside the shadow root it sits in the flow as text.
        mathmlHidden: mathml ? getComputedStyle(mathml).position === 'absolute' : false,
        htmlFont: html ? getComputedStyle(html.querySelector('.mord') ?? html).fontFamily : '',
        // KaTeX sizes its layout with style attributes (a strut's height). If
        // the policy refused them, the strut would have no height.
        strutHeight: (() => {
          const strut = node.querySelector('.katex-html .strut') as HTMLElement | null
          return strut ? Math.round(strut.getBoundingClientRect().height) : -1
        })(),
        text: (node.textContent ?? '').slice(0, 30),
      }
    })
  })
  const fontLoaded = await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))
  const fontFaces = await page.evaluate(() =>
    Array.from(document.fonts).filter(face => face.family.includes('KaTeX')).map(face => `${face.family}:${face.status}`).slice(0, 6))

  console.log(JSON.stringify({ engine: engineName, nodes, fontLoaded, fontFaces, refused, pageErrors }, null, 2))

  assert(nodes.length === 3, `three math nodes: two written, one typed (${nodes.length})`)
  for (const [index, node] of nodes.entries()) {
    assert(node.katex, `math node ${index} (${node.kind}) was rendered by KaTeX, not left as source ("${node.text}")`)
    assert(!node.error, `math node ${index} rendered without error`)
    assert(node.mathmlHidden, `KaTeX's layout CSS applies inside the editor's shadow root (node ${index})`)
    assert(/KaTeX/.test(node.htmlFont), `node ${index} uses a KaTeX font (${node.htmlFont})`)
    assert(node.strutHeight > 0, `KaTeX's sizing style attributes apply (node ${index} strut height ${node.strutHeight})`)
  }
  assert(fontLoaded, `a KaTeX font loaded (${fontFaces.join(', ')})`)
  assert(refused.length === 0, `nothing math-related was refused by the policy: ${refused.join(' | ')}`)
  assert(pageErrors.length === 0, `no page errors: ${pageErrors.join(' | ')}`)
  console.log('\nInline, block and typed math render with KaTeX, styled and in KaTeX fonts, under the app policy.')
} finally {
  await browser?.close()
  await server?.close()
  await cell?.kill()
  if (existsSync(loopbackPath)) unlinkSync(loopbackPath)
}
