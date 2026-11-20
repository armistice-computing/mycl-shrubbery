# Architecture

Mycl's window is a web app that runs inside the desktop shell. The shell runs a local graph node, `gardend`, which keeps the graphs. The window reads and writes them over loopback: HTTP for queries and tools, and WebSockets for live document editing (Yjs).

This repository is the window. Three ideas organize it.

## 1. The packages never reach the backend

Everything under `packages/` talks to the backend only through the interfaces in `packages/nucleus/src/contract.ts` (`ShrubberyContract` and its parts: REST, CRDT rooms, wires, salience, the native bridge, auth). No package calls `fetch`, opens a socket, or touches Tauri.

`apps/organism` builds the real contract, in `apps/organism/src/cell/`. So the packages can be tested with nothing running, and a backend change touches one folder. Details: [docs/architecture/backend.md](docs/architecture/backend.md).

## 2. The frame is data, the behaviour is code

The window's frame is declared in RDF: which regions exist (left rail, center, right rail, top and bottom bars), which panels they hold, the skin and the theme. The default frame is built in. Graphs made by earlier versions carry their own frame in a `:ux:config` named graph, and the window reads it. `planFor()` turns the config into a layout plan, and `renderWorkspace()` draws it.

What happens inside the panels, such as the editor, the sidebar, wires, Home and Settings, is ordinary TypeScript and Lit. Details: [docs/architecture/layout.md](docs/architecture/layout.md).

## 3. The editor is TipTap over Yjs

`packages/editor-kernel` holds the TipTap extensions: blocks and their ids, lists and the outliner, wikilinks and wire decorations, math, footnotes, images, value marks and comments. `packages/runtime/src/editor-host.ts` (`ShEditorHost`) puts them together with Yjs collaboration, the pickers and the block controls. Each document is one Yjs room on the node.

## The parts

| Part | What it holds |
|---|---|
| `apps/organism` | The window: boot, routes, Home, Settings, imports, the wiring of everything below. `src/main.ts` is the entry point, and `src/cell/` holds the backend. |
| `packages/nucleus` | The contract, the RDF layout model and `planFor`, the feature switches (`src/features.ts`). |
| `packages/runtime` | Draws the layout and hosts the editor, the wires panel, the graph view and the other panels. |
| `packages/components` | Lit components: chrome, dialogs, Home, Settings, sidebars. |
| `packages/editor-kernel` | TipTap extensions. |
| `packages/tokens` | CSS design tokens: colors, type, spacing, skins and themes. |
| `packages/source`, `render`, `site`, `hoja`, `chat-kernel`, `domain-kit` | Smaller pieces organism uses: triple sources, RDF renderings, site bundles, a plain text surface, chat rendering, domain contracts. |

## Switches

Unfinished features ship switched off in `packages/nucleus/src/features.ts`. Each switch says what it hides and why. Flip one there; nothing else needs to change.

## Testing

How the tests are split, and what each kind needs: [docs/architecture/testing.md](docs/architecture/testing.md).

## Reading order

1. `packages/nucleus/src/contract.ts`
2. `apps/organism/src/cell/tauri-local-bootstrap.ts` and `gardend-contract.ts`
3. `packages/nucleus/src/workspace/interpreter.ts` (`planFor`)
4. `packages/runtime/src/editor-host.ts`
5. `apps/organism/src/main.ts`, searching for what you need: it is long.
