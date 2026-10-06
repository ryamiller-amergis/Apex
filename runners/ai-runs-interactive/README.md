# Local interactive AI runtime

Local interactive chats use the same shape as cloud: the Apex API dispatches a
turn to a Dapr actor, Redis carries live events to the WebSocket gateway, and
the actor runs the Cursor SDK against the grounded checkout.

The local runtime uses Docker for Redis, Dapr placement, and the Dapr sidecar.
The actor itself runs on the host so it can read local grounding workspaces.
You do not need the Dapr CLI.

## Prerequisites

- Node.js 24+ and `npm install` completed
- Docker Desktop installed and running
- A root `.env` with the normal Apex settings, including `CURSOR_API_KEY`
- Database migrations applied

## Start

Use two PowerShell terminals from the repository root.

Terminal 1:

```powershell
.\runners\ai-runs-interactive\start-local.ps1
```

The script is safe to run again. It:

1. Adds missing local actor settings to the git-ignored `.env`.
2. Creates a random callback token without printing it.
3. Verifies Docker Desktop is available.
4. Starts or reuses Redis, Dapr placement, and the Dapr sidecar.
5. Starts the actor on port `8080` with isolated Cursor SDK state.

Terminal 2:

```powershell
npm run dev
```

Start the actor before `npm run dev` on the first setup. If the script adds
settings while Apex is already running, restart `npm run dev`.

## Enable a project

The `ai-runs-interactive` feature flag is seeded for the **Apex** project.
For another local project, use Platform Admin → Feature Flags and add that
project to `ai-runs-interactive`. Do not add an `everyone` rule merely for local
testing because feature-flag data may point at a shared database.

## Expected ports

- `3000` — Vite
- `3001` — Apex API and WebSocket gateway
- `6379` — Redis
- `8080` — interactive actor host
- `3500` — Dapr HTTP
- `50001` — Dapr gRPC

## Stop

Press `Ctrl+C` in both terminals. The Docker containers may remain running and
will be reused on the next start. To stop them too:

```powershell
docker stop apex-dapr-sidecar apex-dapr-placement apex-dapr-redis
```

The next `start-local.ps1` invocation recreates stopped runtime containers.

## Troubleshooting

- **Docker Desktop is not running** — start Docker Desktop and wait until
  `docker info` succeeds.
- **A turn runs in-process** — confirm
  `AI_RUNS_INTERACTIVE_DISPATCH_URL=http://127.0.0.1:8080` exists in `.env`,
  restart `npm run dev`, and check the project’s `ai-runs-interactive` rule.
- **The browser does not receive live events** — confirm the API log contains
  `Interactive WebSocket gateway mounted`.
- **The actor exits** — read its terminal. SDK terminal failures now include the
  safe structured error returned by Cursor.
- **Ports are occupied** — stop the older Apex/actor process before retrying.

Local actor state is written under `data/cursor-sdk-interactive/` and is ignored
by Git.
