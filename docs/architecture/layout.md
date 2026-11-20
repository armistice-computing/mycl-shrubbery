# Layout: the frame as data

## What the RDF decides

The window's frame is a `WorkspaceConfig`, written in RDF using the `sux:` vocabulary:
- the regions: top bar, left rail, center, right rail and bottom bar
- the panels each region holds, and which component draws each one
- the dock states
- the skin, theme and posture values

The RDF does not decide what happens inside a panel. The editor, sidebar, wires, Home and Settings are code.

## Where the frame comes from

- **The default** is the TypeScript literal `GARDEN_DEFAULT` (`packages/nucleus/src/workspace/garden-default.ts`). `pnpm -C packages/nucleus generate:ux-seed` writes it out as N-Triples in `src/workspace/__generated__/garden-default.ux.nt`, and checks that it reads back the same.
- **A graph's own frame** can live in its `:ux:config` named graph (`urn:mnemosyne:local:graph:{graph}:ux:config`). Graphs made by earlier versions have one. The node does not seed one for new graphs, and the window does not write one, so a new graph uses the default.

So today the frame-as-data path reads saved frames and keeps old graphs working. Nothing in Mycl authors a frame yet.

## How a frame is read and drawn

1. `loadConfigFromCell()` (`apps/organism/src/cell/session-store.ts`) dumps the graph's `:ux:config` from the node.
2. `parseNT()` and then `parseTriplesToConfig()` turn the triples into a `WorkspaceConfig`. Next, `retireRemovedSurfaces()` drops panels that were removed from the app, such as the old chat panel. The result is never written back.
3. If there is no `sux:Workspace` node, the window uses `GARDEN_DEFAULT`. Any other parse failure is an error and is shown as one: a broken config never falls back silently.
4. `validateConfig()` checks the structure, for example that regions form no cycles.
5. `planFor()` (`packages/nucleus/src/workspace/interpreter.ts`) turns the config into a layout plan, and `renderWorkspace()` (`packages/runtime/src/render-workspace.ts`) draws it.

## Changing the frame

- **A new panel:** add the component, add its tag to the allowlist in `packages/nucleus/src/workspace/known-components.ts`, add it to `GARDEN_DEFAULT`, and regenerate the seed.
- **A removed panel:** add its tag to `retire-removed-surfaces.ts`, so saved frames that still name it keep loading.
- **Behaviour inside a panel:** change the component or the runtime host. The frame is not involved.
