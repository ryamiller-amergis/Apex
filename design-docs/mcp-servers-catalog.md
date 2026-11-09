---
name: MCP Servers
status: proposed
---

# MCP Servers

## Summary

MCP Servers is a catalog in the style of Overcut. An admin
picks a provider from the catalog, signs in or pastes a credential, chooses
which of the provider's tools agents may use, and decides who can use the
connection. Agents then reach those tools through an Apex gateway that holds the
credential, enforces the tool list, and records each call.

Providers that publish an official MCP server (Pendo, then Clerk) are
connected directly. Providers that do not (SendGrid) keep an Apex-built adapter
that presents the same MCP interface. Clerk is limited to end-user lookup.

## Why

The current connectors cannot answer real questions.

- Each prebuilt connector has two hard-coded `GET` endpoints. Pendo can look up
  one visitor or one account and nothing else.
- Pendo's analytics live behind tools such as `entityUsage`, `appUsage`,
  `queryFunnel`, and `cohortRetention`. Apex cannot reach them today.
- The MCP Servers page "Ask" box is not AI. `mcpServerAskService.ts` pulls an
  email address out of the question with a regex, calls one fixed endpoint, and
  returns the raw response body.
- Custom connectors accept only OpenAPI documents or hand-written `GET` calls,
  not MCP servers.

## Current state

| Piece | Location | Notes |
| --- | --- | --- |
| Connection table | `migrations/20261021150100_integration-connections.sql`, `src/server/db/schema.ts` (`mcpServers`) | One encrypted credential, `base_url`, `operations` JSONB, `allowed_user_ids` |
| Prebuilt definitions | `src/shared/types/mcpServers.ts` (`PREBUILT_CONNECTORS`) | Clerk, Pendo, SendGrid; two reads each |
| CRUD and test | `src/server/services/mcpServerConnectionService.ts`, `src/server/routes/mcpServers.ts` | Test calls one `GET` |
| URL checks | `src/server/services/mcpServerOpenApi.ts` | `https` only, DNS lookup rejects private ranges, no redirects |
| Credential crypto | `src/server/services/mcpServerCredentialCrypto.ts` | AES-256-GCM bound to project and connection id |
| Agent tool server | `src/server/mcp/mcp-servers/server.ts`, `express.ts` | One `read_operation` tool per connection, loopback only; mounted from `src/server/mcp/ado/express.ts` |
| Chat wiring | `src/server/services/chatAgentService.ts` (`buildMcpServers`), `src/server/routes/chat.ts` | One connection per thread (`kickoff.mcpServerId`) |
| Ask box | `src/server/services/mcpServerAskService.ts` | Regex email lookup; no model call |
| Remote MCP precedent | `src/server/mcp/maxview/express.ts` | Pass-through proxy that injects a token; forwards every tool |

## Provider findings (checked 2026-10-21)

| Provider | Official MCP server | Auth | Fit |
| --- | --- | --- | --- |
| Pendo | Yes. Regional URLs, for example `https://app.pendo.io/mcp/v0/shttp` | Interactive OAuth, or service accounts using OAuth client credentials (60-minute tokens, no refresh token) | Strong. Service accounts suit a shared project connection. Read tools are on by default; write tools need a Pendo admin to opt in |
| Clerk | Yes. `https://mcp.clerk.com/mcp` | Interactive OAuth only; acts as the signed-in person in one workspace | Use it for end-user lookup only. Hide application, domain, and user-create tools. Consent grants those scopes anyway, so the Apex tool list is what enforces the limit |
| SendGrid | No server that calls the API. Twilio's hosted server only searches documentation | API key | Keep the Apex adapter and add more read tools |

Sources: [Pendo: connect](https://support.pendo.io/hc/en-us/articles/41102236924955-Connect-to-the-Pendo-MCP-server),
[Pendo: service accounts](https://support.pendo.io/hc/en-us/articles/50293561169435-Authenticate-to-the-Pendo-MCP-server-with-a-service-account),
[Pendo: tools](https://support.pendo.io/hc/en-us/articles/42476316360731-Pendo-MCP-tools-for-AI-agents),
[Clerk MCP server](https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server),
[Twilio MCP server](https://www.twilio.com/docs/ai/mcp).

## Goals

1. A searchable catalog with categories, provider logos, and an Install action.
2. Connect official remote MCP servers, plus any custom MCP server URL.
3. Discover a server's tools on install and let an admin choose which ones agents
   may use.
4. Keep credentials out of the agent. Apex adds them on the way out.
5. Keep project scope, user allow-lists, permissions, and the feature flag.
6. Replace the regex "Ask" box with a real agent conversation.

## Non-goals

- Write tools. Version one allows only tools marked read-only. Write access would
  need its own approval design.
- Running local (stdio) MCP servers. Apex connects only to hosted servers over
  Streamable HTTP.
- A public marketplace. Catalog entries are reviewed and shipped in code.

## Design

### 1. Two connector kinds

| Kind | Meaning | Examples |
| --- | --- | --- |
| `remote-mcp` | Apex connects to a provider's MCP server | Pendo, custom MCP URL, Clerk once OAuth ships |
| `managed-api` | Apex adapter calls the provider's REST API and presents MCP tools | SendGrid, existing custom OpenAPI connectors, Clerk user lookup until OAuth ships |

Both kinds reach the agent the same way, so the chat side does not care which one
it is talking to.

### 2. Catalog entries

Add a typed list in `src/shared/integrationCatalog.ts`:

```ts
interface CatalogEntry {
  id: string;                     // 'pendo'
  label: string;
  category: 'analytics' | 'auth' | 'communication' | 'monitoring' | 'developer-tools' | 'documentation';
  description: string;
  logo: string;                   // bundled asset, never a remote URL
  kind: 'remote-mcp' | 'managed-api';
  regions?: { id: string; label: string; mcpUrl: string; tokenUrl?: string }[];
  mcpUrl?: string;
  auth: ('api-key' | 'bearer' | 'oauth-client-credentials' | 'oauth-user')[];
  defaultTools?: string[];        // curated starting set
  docsUrl: string;
}
```

`defaultTools` matters for Pendo, which has around a hundred tools. Turning all of
them on would crowd the model's context, so the entry ships a curated read set
(metadata, visitors and accounts, page and feature usage, funnels, retention,
guides) that an admin can widen.

### 3. Data model

New migration that adds columns to `mcp_servers`:

| Column | Type | Purpose |
| --- | --- | --- |
| `kind` | `TEXT NOT NULL DEFAULT 'managed-api'` | Connector kind; existing rows stay `managed-api` |
| `catalog_id` | `TEXT` | Catalog entry, or null for custom |
| `server_url` | `TEXT` | Remote MCP URL |
| `auth_type` | `TEXT` | `api-key`, `bearer`, `oauth-client-credentials`, `oauth-user` |
| `auth_header_name` | `TEXT` | Header for `api-key` auth |
| `token_url` | `TEXT` | Token endpoint for client credentials |
| `tool_policy` | `JSONB NOT NULL DEFAULT '[]'` | Enabled tools, each with name, read-only flag, and a hash of its description and input schema |
| `tools_discovered_at` | `TIMESTAMPTZ` | Last discovery |

The existing encrypted credential columns hold a JSON payload. For client
credentials that is `{ clientId, clientSecret }`. Access tokens are minted on
demand and cached in memory until a minute before expiry. They are never stored,
so a restart or a second instance just mints a new one.

Per-user OAuth (phase 3) adds `integration_user_tokens` with `connection_id`,
`user_id`, encrypted access and refresh tokens, and `expires_at`.

### 4. The Apex gateway

`/mcp/mcp-servers/:connectionId` keeps its address and its loopback and user
checks, then branches on `kind`.

For `remote-mcp`, Apex is an MCP client to the provider and an MCP server to the
agent:

```text
Agent ──MCP──▶ Apex gateway ──MCP + credential──▶ Provider MCP server
               │ list: enabled tools only
               │ call: reject tools not on the list
               │ add auth header, enforce timeout and size limit
               └ record the call
```

- **Listing.** Return only tools in `tool_policy`, using the pinned description
  and schema.
- **Calling.** Reject any tool not in `tool_policy`. Otherwise open an SDK
  `Client` with `StreamableHTTPClientTransport`, attach the credential, forward
  the call, and return the result.
- **Network.** Pass Apex's own `fetch` to the transport (the SDK accepts one) so
  each request runs the existing `https`, private-address, and DNS checks, with
  redirects refused. Keep the current 10-second timeout and 1 MB response cap.
- **Server.** Use the SDK's low-level `Server` rather than `McpServer`, because
  tool schemas arrive as JSON Schema from the provider, not as Zod.

The MaxView proxy is a pass-through and forwards every tool. That works for a
server Apex controls. It does not work here, where Apex must hide tools and keep
the credential away from the agent.

For `managed-api`, the gateway keeps today's behavior, but each operation becomes
its own named tool (for example `get_bounces`) instead of one generic
`read_operation`. Named tools are easier for the model to choose.

### 5. Tool discovery and approval

On install, and when an admin clicks **Refresh tools**:

1. Connect and call `tools/list`.
2. Show each tool with its description and annotations.
3. Pre-select tools that are in the catalog's `defaultTools` and marked
   `readOnlyHint: true`.
4. Show tools without a read-only hint as "Unverified" and leave them off.
5. Show tools marked `destructiveHint: true`, or not read-only, as disabled in
   version one.

On refresh, new upstream tools are never turned on automatically. If an enabled
tool's description or schema hash changes, Apex turns it off and marks it
"Changed — review". This prevents a provider-side change from quietly altering
what the agent is told or allowed to do.

### 6. Authentication

| Method | Used by | How |
| --- | --- | --- |
| API key in a named header | Custom MCP servers | Encrypted; added by the gateway |
| Bearer token | Custom MCP, SendGrid | Encrypted; added by the gateway |
| OAuth client credentials | Pendo service accounts | Store client id and secret; mint a token at the catalog's regional token URL; cache in memory |
| OAuth per user | Clerk, later Figma and Notion | Phase 3. Authorization code with PKCE, using the SDK's `OAuthClientProvider`. Callback at `/api/projects/:projectId/mcp-servers/oauth/callback` on the existing router. The admin installs the connector; each user links their own account; the agent acts as that user |

### 7. Chat

- **Phase 1.** The MCP Servers page "Try it" box starts a real chat thread with
  `assistantType: 'mcp-server'` and opens it in Agent Home. Remove
  `selectMcpServerRead` and the regex path.
- **Phase 2.** Change `kickoff.mcpServerId` to
  `mcpServerIds: string[]`. `buildMcpServers` mounts one gateway per
  connection, named `integration-<slug>`. Agent Home gets a source picker, so one
  question can draw on Pendo and SendGrid together. Allow-list and permission
  checks run for every selected connection.

### 8. Interface

- **Catalog.** A short list of example MCP servers: Pendo, Clerk, and
  SendGrid, plus custom. Each card has a logo, a one-line description, and
  Install.
- **Install page.** Matches the Overcut server page, not a wizard. It shows the
  provider, a Documentation link, Install, a configuration block, the required
  secrets, and an Allowed tools list with an All tools toggle. Only enabled
  tools are saved on the connection.
- **Installed tab.** Replaces the current table. Shows health, enabled tool
  count, last used, and Refresh tools, Edit access, and Remove actions.
- Logos ship as local assets so the catalog makes no external requests.

### 9. Permissions and flags

- Reuse `mcp-servers:view` and `mcp-servers:manage`.
- A project admin with `mcp-servers:manage` can install a connector on their
  own. Platform Admin approval is not required.
- Gate the `remote-mcp` kind behind a new `mcp-servers-remote-mcp` flag, using
  the cleanup markers from `.cursor/skills/feature-flags/SKILL.md`. Existing
  connectors keep working with the flag off.

### 10. Audit

New table `integration_tool_calls`: `connection_id`, `user_id`, `thread_id`,
`tool_name`, `status`, `duration_ms`, `created_at`. No arguments or results are
stored, because they may hold customer data. Shown as "Last used" and a simple
activity list on each connection.

## Security checklist

- Credentials never reach the agent, the browser, or logs.
- Server URLs: `https` only, public addresses only after DNS lookup, no
  redirects, checked on every request.
- Tool list enforced on both listing and calling.
- Changed tool descriptions turn the tool off until an admin reviews it.
- Read-only tools only in version one; the provider's own scopes are a second
  layer, not the only one.
- Project id and connection id stay bound into credential encryption.
- Timeouts and response size limits on every upstream call.

## Phases

| Phase | Scope |
| --- | --- |
| 1 | `remote-mcp` kind; gateway with tool filtering; API key, bearer, and client-credentials auth; discovery and approval; catalog UI with Pendo and Add custom; "Try it" starts a real chat; SendGrid and Clerk stay `managed-api` |
| 2 | Several connections per chat thread; source picker in Agent Home; audit table; tool-change detection; more read tools for SendGrid; more catalog entries that accept API keys |
| 3 | Per-user OAuth for Clerk's official server, limited to end-user read tools; then other OAuth-only providers such as Figma and Notion |

## Files

| Change | Files |
| --- | --- |
| New | `src/shared/integrationCatalog.ts`, `src/server/services/integrationRemoteMcpService.ts`, `src/server/services/integrationTokenService.ts`, migration for the new columns and tables |
| Changed | `src/shared/types/mcpServers.ts`, `src/server/db/schema.ts`, `src/server/services/mcpServerConnectionService.ts`, `src/server/mcp/mcp-servers/server.ts`, `src/server/mcp/mcp-servers/express.ts`, `src/server/routes/mcpServers.ts`, `src/server/services/chatAgentService.ts`, `src/server/routes/chat.ts`, `src/client/components/McpServersView.tsx`, `src/client/hooks/useMcpServers.ts` |
| Removed | Regex path in `src/server/services/mcpServerAskService.ts` |

No change is expected to `src/server/index.ts`, `package.json`, or config files.
The gateway keeps its current mount, and `@modelcontextprotocol/sdk` 1.29.0 is
already installed. If a new folder is added, update `.cursor/CODEMAP.md` in the
same change.

## Testing

- Unit: tool policy filtering, schema-hash change detection, token caching and
  expiry, URL checks with redirect refusal, catalog validation.
- Integration: a stub MCP server that lists read, unannotated, and destructive
  tools; confirm only approved tools reach the agent and others are rejected on
  call.
- Client: catalog search and filters, install steps, tool selection, custom MCP
  validation.
- End to end: install Pendo against the stub, ask a usage question in chat, see
  the tool call recorded.

## Decisions (2026-10-21)

1. **Use the official servers.** Pendo and Clerk both have MCP, and Amergis has
   accounts on both. Pendo connects with a service account. Clerk connects with
   the existing account through OAuth.
2. **The Pendo API package is available**, so service accounts and client
   credentials are allowed.
3. **Clerk is end-user lookup only.** Enable user-read tools. Do not enable
   application, domain, instance-config, or user-create tools. Clerk's consent
   screen grants the wider set and cannot be narrowed, so the gateway refuses
   every tool outside the user-read list.
4. **No extra sign-off** is required before Pendo data is sent to the model.
5. **A project admin installs alone.** `mcp-servers:manage` on the project is
   enough. No Platform Admin approval step.

Setup still needed when Pendo is first installed, not a design choice: turn on
the read-only MCP toggle in that Pendo subscription, create a service account,
and pick the subscription's region in the install panel. The panel defaults to
the US URL.
