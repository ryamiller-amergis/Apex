# Work Board MCP tools

Board-native standup tools live in `tools.ts` and are registered on the existing
**ado-skills** MCP server (see `registerBoardMcpTools` called from
`src/server/mcp/ado/server.ts`).

## Why not a separate mount?

Mounting a new Express MCP path requires editing `src/server/index.ts`, which is
out of scope for Work Board rollout (scope discipline). Registering on
`ado-skills` keeps tools available to standup agents without a new mount.

## Tools

| Tool | Purpose |
|------|---------|
| `query_board_items` | List/filter board items by owner/status/release |
| `update_board_item` | Update fields or move status (needs `threadId`) |
| `add_board_item_comment` | Comment on a board item (needs `threadId`) |
| `list_board_releases` | List releases + progress |

## Export

```ts
import { registerBoardMcpTools, getBoardMcpTools } from './tools';
```

`getBoardMcpTools().register(server)` is equivalent to `registerBoardMcpTools(server)`.
