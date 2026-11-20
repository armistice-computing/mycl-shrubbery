/**
 * Real-browser contract for the two-state editor-material preference.
 *
 * The journey starts at the actual Settings route, persists the preference,
 * navigates to the deterministic workspace in the same browser context, and
 * inspects real Chromium layout/paint. It proves the restrained paper posture
 * (no ruler since 2026-10-14) across skins and themes, then returns to the
 * continuous canvas. The Classic Word page was retired on 2026-10-14.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { chromium, type Page } from 'playwright'
import { createServer } from 'vite'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requestedPort = Number(process.env.SHRUBBERY_EDITOR_MATERIAL_BROWSER_PORT ?? 0)
const artifactDir = process.env.SHRUBBERY_ARTIFACT_DIR ?? '/private/tmp'

await mkdir(artifactDir, { recursive: true })

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`editor-material-browser-harness assertion failed: ${message}`)
}

async function waitForSettings(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = (window as unknown as {
      __settingsHarness?: { state: { ready?: boolean; error?: string | null } }
    }).__settingsHarness?.state
    return state?.ready === true || Boolean(state?.error)
  }, undefined, { timeout: 60_000 })
  const error = await page.evaluate(() => window.__settingsHarness?.state.error ?? null)
  assert(error == null, `settings boot error: ${String(error)}`)
}

async function waitForWorkspace(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const state = (window as unknown as {
      __organism?: { state: { ready?: boolean; error?: string | null } }
    }).__organism?.state
    return state?.ready === true || Boolean(state?.error)
  }, undefined, { timeout: 60_000 })
  const error = await page.evaluate(() => window.__organism?.state.error ?? null)
  assert(error == null, `workspace boot error: ${String(error)}`)
}

async function appendThroughPointerCaret(page: Page, expectedHeading: string, suffix: string): Promise<void> {
  // Shell navigation commits before the provider-gated editor swap. Wait on
  // the live body, not only activeDocumentId, so this proof never types into
  // the outgoing room during that legitimate handoff window.
  await page.waitForFunction((heading) => document.querySelector('sh-editor-host')?.shadowRoot
    ?.querySelector<HTMLElement>('.ProseMirror h1')?.textContent === heading, expectedHeading)
  const before = await page.locator('sh-editor-host').evaluate((host) => {
    const editor = host.shadowRoot?.querySelector<HTMLElement>('.ProseMirror')
    const heading = editor?.querySelector<HTMLElement>('h1')
    const paragraphs = editor ? Array.from(editor.querySelectorAll<HTMLElement>(':scope > p')) : []
    const paragraph = paragraphs.at(-1)
    if (!editor || !heading || !paragraph) throw new Error('pointer-caret proof nodes are missing')
    return { heading: heading.textContent ?? '', paragraph: paragraph.textContent ?? '' }
  })

  const clickPoint = await page.locator('sh-editor-host').evaluate((host) => {
    const editor = host.shadowRoot?.querySelector<HTMLElement>('.ProseMirror')
    const paragraphs = editor ? Array.from(editor.querySelectorAll<HTMLElement>(':scope > p')) : []
    const paragraph = paragraphs.at(-1)
    if (!paragraph) throw new Error('pointer-caret paragraph disappeared')
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let lastText: Text | null = null
    let next = walker.nextNode()
    while (next) {
      if ((next.textContent ?? '').length > 0 && !next.parentElement?.closest('[contenteditable="false"]')) {
        lastText = next as Text
      }
      next = walker.nextNode()
    }
    if (!lastText || !lastText.textContent) throw new Error('pointer-caret paragraph has no text')
    const range = document.createRange()
    range.setStart(lastText, lastText.textContent.length - 1)
    range.setEnd(lastText, lastText.textContent.length)
    const rects = Array.from(range.getClientRects())
    const rect = rects.at(-1)
    if (!rect) throw new Error('pointer-caret final glyph has no layout rectangle')
    return { x: rect.right - 0.5, y: rect.top + (rect.height / 2) }
  })
  await page.mouse.click(clickPoint.x, clickPoint.y)
  await page.keyboard.type(suffix)
  try {
    await page.waitForFunction(({ heading, paragraphText, appended }) => {
      const editor = document.querySelector('sh-editor-host')?.shadowRoot
        ?.querySelector<HTMLElement>('.ProseMirror')
      const currentHeading = editor?.querySelector<HTMLElement>('h1')?.textContent ?? ''
      const paragraphs = editor ? Array.from(editor.querySelectorAll<HTMLElement>(':scope > p')) : []
      const currentParagraph = paragraphs.at(-1)?.textContent ?? ''
      return currentHeading === heading && currentParagraph === `${paragraphText}${appended}`
    }, { heading: before.heading, paragraphText: before.paragraph, appended: suffix })
  } catch (error) {
    const observed = await page.locator('sh-editor-host').evaluate((host) => {
      const editor = host.shadowRoot?.querySelector<HTMLElement>('.ProseMirror')
      const paragraphs = editor ? Array.from(editor.querySelectorAll<HTMLElement>(':scope > p')) : []
      const rawEditor = (host as HTMLElement & {
        _editor?: { state?: { selection?: { toJSON?: () => unknown } } }
      })._editor
      return {
        heading: editor?.querySelector<HTMLElement>('h1')?.textContent ?? '',
        paragraph: paragraphs.at(-1)?.textContent ?? '',
        selection: rawEditor?.state?.selection?.toJSON?.() ?? null,
      }
    })
    throw new Error(
      `pointer-caret settle failed: expected ${JSON.stringify({
        heading: before.heading,
        paragraph: `${before.paragraph}${suffix}`,
      })}, observed ${JSON.stringify(observed)}; ${String(error)}`,
    )
  }

  const after = await page.locator('sh-editor-host').evaluate((host) => {
    const editor = host.shadowRoot?.querySelector<HTMLElement>('.ProseMirror')
    const heading = editor?.querySelector<HTMLElement>('h1')
    const paragraphs = editor ? Array.from(editor.querySelectorAll<HTMLElement>(':scope > p')) : []
    return {
      heading: heading?.textContent ?? '',
      paragraph: paragraphs.at(-1)?.textContent ?? '',
    }
  })
  assert(after.heading === before.heading, `pointer edit changed the heading to ${JSON.stringify(after.heading)}`)
  assert(
    after.paragraph === `${before.paragraph}${suffix}`,
    `pointer edit landed outside the clicked paragraph: ${JSON.stringify(after.paragraph)}`,
  )
}

const server = await createServer({
  root: appDir,
  configFile: resolve(appDir, 'vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: requestedPort,
    strictPort: requestedPort !== 0,
    hmr: false,
  },
  logLevel: 'warn',
})
await server.listen()
const address = server.httpServer?.address()
const port = typeof address === 'object' && address ? address.port : requestedPort
if (!port) throw new Error('Editor-material browser harness could not resolve its Vite port')

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1800, height: 1100 } })
const page = await context.newPage()
const pageErrors: string[] = []
const consoleErrors: string[] = []
page.on('pageerror', error => pageErrors.push(error.stack ?? error.message))
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})

try {
  await page.goto(`http://127.0.0.1:${port}/settings-browser-harness.html`, {
    waitUntil: 'domcontentloaded',
  })
  await waitForSettings(page)
  const settings = page.locator('mn-settings-page')
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
  const materialSelect = settings.getByLabel('Editor canvas', { exact: true })
  assert(await materialSelect.inputValue() === 'continuous', 'editor material should default to continuous')
  await materialSelect.selectOption('paper')
  await page.waitForFunction(() => document.documentElement.dataset.editorMaterial === 'paper')
  assert(await materialSelect.inputValue() === 'paper', 'Settings did not select the paper posture')
  const persistedOn = await page.evaluate(() => {
    const value = window.localStorage.getItem('shrubbery.organism.settings.v1')
    return value ? JSON.parse(value).editorMaterial : null
  })
  assert(persistedOn === 'paper', 'paper preference was not persisted')

  await page.goto(`http://127.0.0.1:${port}/browser-harness.html`, { waitUntil: 'commit' })
  await waitForWorkspace(page)
  const home = page.locator('.app-container mn-home-view')
  await home.locator('[data-document-id="architecture"] button.open').click()
  await page.waitForFunction(() => window.__organism?.state.activeDocumentId === 'architecture')
  const desktop = await page.locator('sh-editor-host').evaluate((host) => {
    const root = host.shadowRoot
    const mount = root?.querySelector<HTMLElement>('.editor-mount')
    const editor = root?.querySelector<HTMLElement>('.ProseMirror')
    if (!mount || !editor) throw new Error('live editor material nodes are missing')
    const mountRect = mount.getBoundingClientRect()
    const editorRect = editor.getBoundingClientRect()
    const editorStyle = getComputedStyle(editor)
    const rulerStyle = getComputedStyle(mount, '::before')
    return {
      rootMaterial: document.documentElement.dataset.editorMaterial,
      hostMaterial: host.getAttribute('editor-material'),
      mountWidth: mountRect.width,
      editorWidth: editorRect.width,
      editorHeight: editorRect.height,
      editorTopInset: editorRect.top - mountRect.top,
      background: editorStyle.backgroundColor,
      color: editorStyle.color,
      borderTopWidth: editorStyle.borderTopWidth,
      boxShadow: editorStyle.boxShadow,
      rulerDisplay: rulerStyle.display,
      rulerHeight: rulerStyle.height,
    }
  })
  assert(desktop.rootMaterial === 'paper' && desktop.hostMaterial === 'paper', 'paper state did not cross the shadow boundary')
  assert(Math.abs(desktop.editorWidth - 816) <= 1, `paper width is ${desktop.editorWidth}px, expected 816px`)
  assert(desktop.editorHeight >= 1056, 'paper sheet lost its minimum page height')
  assert(desktop.editorTopInset >= 30, 'paper sheet lost its print-like top offset')
  assert(desktop.background === 'rgb(255, 253, 248)', 'paper sheet is not cream')
  assert(desktop.color === 'rgb(41, 39, 35)', 'paper sheet did not establish dark physical ink')
  assert(desktop.borderTopWidth === '1px' && desktop.boxShadow !== 'none', 'paper edge/depth is absent')
  assert(desktop.rulerDisplay !== 'block', 'the paper page draws a ruler again')

  await page.screenshot({ path: `${artifactDir}/shrubbery-art-paper-light.png`, fullPage: false })

  await page.locator('mn-top-bar button[aria-label="Toggle theme"]').click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark'
    && window.__organism?.state.theme === 'dark')
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  const dark = await page.locator('sh-editor-host').evaluate((host) => {
    const mount = host.shadowRoot?.querySelector<HTMLElement>('.editor-mount')
    const editor = host.shadowRoot?.querySelector<HTMLElement>('.ProseMirror')
    const heading = editor?.querySelector<HTMLElement>('h1')
    const paragraph = editor?.querySelector<HTMLElement>('p')
    if (!mount || !editor || !heading || !paragraph) throw new Error('dark editor material nodes are missing')
    return {
      mountBackground: getComputedStyle(mount).backgroundColor,
      editorBackground: getComputedStyle(editor).backgroundColor,
      editorColor: getComputedStyle(editor).color,
      headingColor: getComputedStyle(heading).color,
      paragraphColor: getComputedStyle(paragraph).color,
      text: editor.textContent,
    }
  })
  assert(dark.editorBackground === 'rgb(255, 253, 248)', 'dark theme recolored the physical page')
  assert(dark.editorColor === 'rgb(41, 39, 35)', 'dark theme recolored physical-page ink')
  assert(dark.headingColor === 'rgb(17, 17, 15)', 'dark theme recolored the paper heading')
  assert(dark.paragraphColor === 'rgb(41, 39, 35)', 'dark theme recolored paper body text')
  assert(dark.text?.includes('Architecture') && dark.text.includes('Y.Doc room'), 'paper content vanished during theme change')
  assert(dark.mountBackground !== dark.editorBackground, 'dark workspace and physical page collapsed into one surface')
  await page.screenshot({ path: `${artifactDir}/shrubbery-art-paper-dark.png`, fullPage: false })

  // Material mode must remain presentation-only. Exercise the real editable
  // ProseMirror/Y.Doc room, then switch back through the ordinary sidebar path.
  await page.locator('mn-sidebar-panel [data-node-id="research-notes"]').click()
  await page.waitForFunction(() => window.__organism?.state.activeDocumentId === 'research-notes')
  await appendThroughPointerCaret(page, 'Research Notes', ' Classic paper mode remains editable.')
  assert(
    await page.locator('sh-editor-host').getAttribute('editor-material') === 'paper',
    'editing discarded the paper presentation state',
  )
  await page.locator('mn-sidebar-panel [data-node-id="architecture"]').click()
  await page.waitForFunction(() => window.__organism?.state.activeDocumentId === 'architecture')

  await page.goto(`http://127.0.0.1:${port}/settings-browser-harness.html`, {
    waitUntil: 'domcontentloaded',
  })
  await waitForSettings(page)
  const restoredSettings = page.locator('mn-settings-page')
  await restoredSettings.getByRole('button', { name: 'Appearance', exact: true }).click()
  const restoredSelect = restoredSettings.getByLabel('Editor canvas', { exact: true })
  assert(await restoredSelect.inputValue() === 'paper', 'Settings did not restore the paper page')
  await restoredSelect.selectOption('continuous')
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-editor-material'))
  const persistedOff = await page.evaluate(() => {
    const value = window.localStorage.getItem('shrubbery.organism.settings.v1')
    return value ? JSON.parse(value).editorMaterial : null
  })
  assert(persistedOff === 'continuous', 'returning to continuous mode was not persisted')

  // The caret repair is a shadow-boundary behavior, not a material override.
  // Re-prove the default continuous canvas after the paper page.
  await page.setViewportSize({ width: 1800, height: 1100 })
  await page.goto(`http://127.0.0.1:${port}/browser-harness.html`, { waitUntil: 'commit' })
  await waitForWorkspace(page)
  await page.locator('.app-container mn-home-view [data-document-id="research-notes"] button.open').click()
  await page.waitForFunction(() => window.__organism?.state.activeDocumentId === 'research-notes')
  await appendThroughPointerCaret(page, 'Research Notes', ' Continuous mode targets the clicked paragraph.')
  assert(
    await page.locator('sh-editor-host').getAttribute('editor-material') == null,
    'continuous editing unexpectedly retained a material attribute',
  )

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('\n')}`)
  assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join('\n')}`)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    browser: 'chromium',
    settingsPersistence: true,
    desktopPaperGeometry: true,
    noRuler: true,
    ninetyEightMaterialRoles: true,
    glassMaterialRoles: true,
    darkChromeLightPage: true,
    editorBehaviorLive: true,
    shadowDomPointerCaret: true,
    screenshots: [
      `${artifactDir}/shrubbery-art-paper-light.png`,
      `${artifactDir}/shrubbery-art-paper-98.png`,
      `${artifactDir}/shrubbery-art-paper-glass.png`,
      `${artifactDir}/shrubbery-art-paper-dark.png`,
    ],
  }, null, 2)}\n`)
} finally {
  await context.close().catch(() => undefined)
  await browser.close().catch(() => undefined)
  await server.close()
}
