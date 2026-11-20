# The backend seam

## The rule

Code under `packages/` reaches the backend only through `ShrubberyContract` (`packages/nucleus/src/contract.ts`). It never calls `fetch`, opens a socket, reads a token or calls Tauri. CRDT documents cross the seam as opaque handles (`CrdtDoc`, `CrdtAwareness`), so `nucleus` does not depend on Yjs.

Keep the rule when you add a feature. Put the new call in the contract as an interface, implement it in `apps/organism/src/cell/`, and pass it in.

## How the window connects

1. The desktop shell starts `gardend` on loopback, with a fresh bearer token for each run.
2. At boot, `cell/tauri-local-bootstrap.ts` asks the shell for the coordinates (the Tauri command `get_loopback_manifest`: API URL, MCP URL, token).
3. `cell/gardend-contract.ts` builds the contract from them:
   - **REST**: the graph catalog, plus SPARQL reads and writes, as MCP tool calls (`cell/loopback-mcp.ts`).
   - **CRDT**: `cell/loopback-crdt-backend.ts` opens one y-websocket room per document at `/hocuspocus/docs/{graph}/{doc}`, and one for the workspace at `/hocuspocus/workspace/{graph}`. The token goes in the `Sec-WebSocket-Protocol` header as `bearer.<token>`.
   - **UI services**: the confirmation dialog, icons and presence colors.
4. Native-only work goes through Tauri `invoke` in its own `cell/` module: menus, the vault import, export and print, agent keys and Dreaming. A plain browser has none of these, and the window still runs without them.

## In development

`pnpm -C apps/organism dev` serves the window from Vite. The browser calls same-origin `/cell/*`, and the Vite proxy (`scripts/vite-cell-proxy.ts`) forwards it to a node and adds the token on the server side, so no token reaches the page. `dev:live` points that proxy at the running app's node. Edits made there are real.

## Hosted shapes

`cell/hosted-gateway-contract.ts` and `cell/gateway-crdt-backend.ts` build the same contract for a hosted gateway. Mycl does not use them today. They show that the seam holds for more than one backend.
