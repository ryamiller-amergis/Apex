# Local Load Test Dev Setup

This repo does **not** spin up a local Service Bus via Docker Compose.
For day-to-day local work:

| Goal | Needs Azure SB / Blob / CA Job? |
|------|----------------------------------|
| AI generate k6 script (FEAT-011) | No — Apex + Postgres + `CURSOR_API_KEY` + connected skill repo |
| Save definition + Enqueue | No — use `LT_DISPATCH_PUBLISHER=noop` (run becomes `dispatched`, no runner) |
| Full k6 execution + artifacts | Yes — non-prod Azure LT infra (or inject `LT_DISPATCH_MESSAGE_JSON` + blob) |

## One-time local prep (already applied on this machine)

1. Missing load-test columns repaired (some migrations were recorded but DDL was absent).
2. `load-tests` menu enabled for **Apex** and **MaxView**.
3. Staging allowlist target seeded: `https://httpbin.org` (`staging`) for Apex + MaxView.
4. RBAC keys `load-test:view|run|manage` granted to viewer/member/admin defaults.
5. `.env` / `.env.local` include:

```env
LT_DISPATCH_PUBLISHER=noop
LT_RUNNER_CALLBACK_TOKEN=local-dev-runner-token
LT_APEX_CALLBACK_BASE_URL=http://localhost:3001
APEX_CALLBACK_URL=http://localhost:3001
```

**Restart `npm run dev`** after env changes so the API process reloads them.

## Try AI generate (recommended first test)

1. Open http://localhost:3000 and sign in (admin or member on Apex/MaxView).
2. Switch project to **Apex** or **MaxView** (both have a connected skill repo).
3. Sidebar → **Load Tests** → **New**.
4. Fill requirement id + select target `https://httpbin.org` / staging.
5. Open **AI generate** → Generate → wait for apply → edit → **Save**.

If AI mode is greyed out: Project Admin → Skill Settings must have a non-empty Skill Repo.

Optional: set **Load Test Generation Skill** to  
`.cursor/skills/k6-load-test-generation/SKILL.md`  
and an optional model override.

## Enqueue without Azure (noop)

After saving a definition, use **Run** (needs `load-test:run`).  
With `LT_DISPATCH_PUBLISHER=noop`, Apex marks the run `dispatched` and does **not** call Service Bus. No k6 process starts.

## Full k6 runner (optional)

See [README.md](./README.md). Requires `LT_BLOB_ACCOUNT_NAME`, Key Vault (if secret refs), and either:

- Azure Service Bus + Container Apps Job, or
- `LT_DISPATCH_MESSAGE_JSON=...` + `node dist/server/services/loadTestRunner/entrypoint.js` after `npm run build:server`

Docker image build:

```bash
npm run build:server
docker build -f runners/load-test-k6/Dockerfile -t apex-lt-k6:local .
```
