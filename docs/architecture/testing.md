# Testing

## Three kinds of test

| Kind | Run it with | Needs |
|---|---|---|
| Source tests (`*.test.ts`) | `pnpm test:source` | Nothing. Components render in happy-dom. |
| Integration tests (`*.integration.test.ts`) | `GARDEN_BIN=/path/to/gardend pnpm test:run` | A `gardend` binary from the Mycl repository. Each suite starts its own throwaway node. |
| Browser tests (`*.browser.test.ts` and the organism harnesses) | `pnpm test:browser-suites`, `pnpm -C apps/organism test:browser` | Playwright browsers (`pnpm -C apps/organism exec playwright install`). |

`pnpm test:source` skips the integration and browser tests. A few source tests read the backend's own files to check the window against them (for example, the arguments `create_graph` requires). They look for a backend checkout beside this repository (`GARDEN_REPO`, `../mycl` or `../garden`), and they skip when there is none.

`apps/organism/scripts/` holds many one-purpose browser harnesses (`test:*-browser` in its `package.json`). Many of them start a real node and drive the real window in Chromium or WebKit. Use Safari's engine (`SHRUBBERY_BROWSER_ENGINE=webkit` where a harness supports it) for anything visual: the desktop app renders with WebKit.

## No mocks

Tests drive real code against real inputs: a real contract, a real node, a real DOM. `vi.mock`, `vi.fn`, `vi.spyOn` and the other stand-ins are banned in new tests. `pnpm guard:no-mocks` fails when a test that is not on its frozen allowlist uses them. When you remove the mocks from a listed file, delete its entry too. The guard fails on stale entries as well.

## Before you push

```bash
pnpm -C apps/organism typecheck
pnpm test:source
pnpm build
```
