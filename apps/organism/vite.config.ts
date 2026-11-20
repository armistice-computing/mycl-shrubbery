import { createReadStream, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { dynamicCellProxy } from '../../scripts/vite-cell-proxy.js'
import { cloud2ServiceProxy } from '../../scripts/vite-cloud2-service-proxy.js'

const __dir = dirname(fileURLToPath(import.meta.url))

const LOOPBACK_FILE = process.env.GARDEND_LOOPBACK_MANIFEST
  ? resolve(process.env.GARDEND_LOOPBACK_MANIFEST)
  : resolve(__dir, '.gardend-loopback.json')

const cloud2ProxyValues = {
  gatewayBaseUrl: process.env.CLOUD2_GATEWAY_BASE_URL?.trim() ?? '',
  serviceTokenFile: process.env.CLOUD2_SERVICE_TOKEN_FILE?.trim() ?? '',
  onBehalfOf: process.env.CLOUD2_ON_BEHALF_OF?.trim() ?? '',
}
const cloud2ProxyEnabled = Object.values(cloud2ProxyValues).some(Boolean)
if (cloud2ProxyEnabled && Object.values(cloud2ProxyValues).some(value => !value)) {
  throw new Error(
    'CLOUD2_GATEWAY_BASE_URL, CLOUD2_SERVICE_TOKEN_FILE, and CLOUD2_ON_BEHALF_OF must be set together.',
  )
}

/**
 * How long the dev proxy waits on the cell before calling it unreachable.
 *
 * The plugin's 2s default is sized for the small cells the harnesses spawn. A
 * real graph is not small: `default_x1` holds ~1.27M triples, and a
 * `sparql_query` over it routinely outruns two seconds -- whereupon the proxy
 * answers 503 `cell_proxy_unavailable` and the sidebar reports the cell as "not
 * accepting connections yet". The cell was answering fine; the proxy stopped
 * listening. Raise it when pointing the dev server at a real profile.
 */
const CELL_PROXY_TIMEOUT_MS = Number(process.env.SHRUBBERY_CELL_PROXY_TIMEOUT_MS ?? 2_000)

const PDF_WASM_FILES = [
  'openjpeg.wasm',
  'jbig2.wasm',
  'qcms_bg.wasm',
  'openjpeg_nowasm_fallback.js',
  'jbig2_nowasm_fallback.js',
] as const

function pdfJsWasmAssets(): Plugin {
  const require = createRequire(import.meta.url)
  const sourceDir = dirname(require.resolve('pdfjs-dist/package.json'))
  return {
    name: 'pdfjs-wasm-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs-wasm', (request, response, next) => {
        const filename = request.url?.replace(/^\//, '') ?? ''
        if (!PDF_WASM_FILES.includes(filename as typeof PDF_WASM_FILES[number])) return next()
        const path = resolve(sourceDir, 'wasm', filename)
        if (!existsSync(path)) return next()
        response.setHeader('Content-Type', filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        createReadStream(path).pipe(response)
      })
    },
    writeBundle() {
      const outputDir = resolve(__dir, 'dist', 'pdfjs-wasm')
      mkdirSync(outputDir, { recursive: true })
      for (const filename of PDF_WASM_FILES) {
        copyFileSync(resolve(sourceDir, 'wasm', filename), resolve(outputDir, filename))
      }
    },
  }
}

export default defineConfig({
  root: '.',
  plugins: [
    pdfJsWasmAssets(),
    dynamicCellProxy({
      manifestPath: LOOPBACK_FILE,
      websocket: true,
      upstreamTimeoutMs: CELL_PROXY_TIMEOUT_MS,
    }),
    ...(cloud2ProxyEnabled ? [cloud2ServiceProxy({ ...cloud2ProxyValues, websocket: true })] : []),
  ],
  optimizeDeps: {
    // The browser entry point resolves web_bg.wasm relative to its own module.
    // Prebundling rewrites that module into .vite/deps without copying the
    // sibling WASM, leaving Oxigraph's exported Store present but uninitialized.
    exclude: ['oxigraph'],
  },
  server: {
    port: 5180,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Multi-page build: the playground root (`index.html`) plus the RETIRED
      // Observatory page (`observatory.html`), which is now a tiny STATIC
      // redirect to `/?graph=observatory` — the Observatory renders inside the
      // normal Organism workspace whenever the active graph's :ux:config
      // declares a dashboard center (sh-layout-dashboard). The entry stays in
      // the production build ONLY so old /observatory.html links keep working;
      // it loads no module script. Every other page in this directory (the
      // *-harness.html proof pages) is dev-server-only, reached by direct URL,
      // deliberately NOT part of the production build.
      input: {
        main: resolve(__dir, 'index.html'),
        observatory: resolve(__dir, 'observatory.html'),
      },
    },
  },
})
