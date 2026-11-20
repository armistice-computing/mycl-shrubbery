# mycl-shrubbery

The frontend of [Mycl](https://github.com/armistice-computing/mycl), a knowledge graph that humans and agents compose and navigate together like a notes app. Everything you see in Mycl's window is built here: the editor, the sidebars, wires, the atlas, Home and Settings. The desktop app, the local graph node and the releases live in the Mycl repository, which builds this one into its window.

## Layout

- `apps/organism`: the Mycl window itself. Start here.
- `packages/editor-kernel`: the editor (TipTap and ProseMirror), with blocks, wires as links, math and footnotes.
- `packages/components`: the interface pieces, as Lit web components.
- `packages/runtime`: puts the editor and components together into a working window.
- `packages/nucleus`: shared types, the feature switches (`src/features.ts`) and the one interface the frontend uses to reach the backend.
- `packages/tokens`: colors, type and spacing, light and dark.
- `packages/source`: where the triples come from: adapters for a local graph node and the boot factory.
- `packages/render`: turtle, JSON-LD and markdown views of a resource.
- `packages/site`: route, face and appearance bundles over a workspace layout.
- `packages/hoja`: a plain text-entry surface over the editor kernel.
- `packages/chat-kernel`: chat rendering types and the chat event union.
- `packages/domain-kit`: graph contracts for domains: manifests, verdicts, dashboards and grants.

How the parts fit, and why the frontend never talks to a backend directly: [ARCHITECTURE.md](ARCHITECTURE.md). Design notes: [docs/](docs/).

## Run it

You need Node and pnpm 9. To run against a real graph you also need a `gardend` binary from the Mycl repository.

```bash
pnpm install
pnpm test:source                    # the tests that need nothing else
pnpm build

# the window, against a throwaway local graph
GARDEN_BIN=/path/to/gardend pnpm -C apps/organism gardend:dev   # terminal 1
pnpm -C apps/organism dev                                       # terminal 2
```

On macOS, `pnpm -C apps/organism dev:live` points the window at the graph of a running Mycl app instead. Edits there are real.

## For agents

Read [ARCHITECTURE.md](ARCHITECTURE.md) first, then `apps/organism/src/main.ts`. Hidden features are switched off in `packages/nucleus/src/features.ts`. Check a change with `pnpm -C apps/organism typecheck`, `pnpm test:source` and `pnpm build`.

## Read more

On how we think about designing it:

- [The Garden Design Antinomies](docs/writings/garden-design-antinomies.md)

## Where it comes from

Mycl is a fork of Sophia Labs' Garden project, made by a former member of Sophia Labs. This frontend began as an extraction of Garden's frontend, whose current form is at [sophia-labs/shrubbery](https://github.com/sophia-labs/shrubbery).

## License

PolyForm Noncommercial 1.0.0. See [LICENSE](LICENSE).

Made by Armistice Computing.
