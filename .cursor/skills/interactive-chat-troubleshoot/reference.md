# Interactive chat — reference

## Architecture (FEAT-007)

```
Browser (WS if ai-runs-interactive)
  → App Service gateway (interactiveGatewayService)
      ← in-memory subscribeToThread (same instance only)
      ← Redis live bus apex:interactive:live:<threadId>
  → sendMessage → tryDispatchInteractiveTurn
      → actor (ACA) OR in-process fail-closed
  → publishRunEventEnvelope → broadcast + pg_notify + publishInteractiveLive(Redis)
```

Durability: `agent_run_events` + `/run-status` poll. Live feel: Redis.

## Failure buckets

| Bucket | Meaning | Primary scripts |
|--------|---------|-----------------|
| A | REDIS_* / websockets / dispatch URL missing on slot | `check_app_settings` |
| B | Send never created a run | `diagnose_thread`, `fetch_app_logs` (`sendMessage`) |
| C | In-process turn, no Redis publish | logs `local agent slot` + `probe_live_bus` silent |
| D | Actor run, no Redis publish | diagnose lane + ACA env + probe |
| E | Redis has tokens, UI stuck | gateway / client WS / dedupe |
| F | Early gate (nativeReads / grounding) → always in-process | Insights / logs `nativeReads: false` |
| G | Run finished, client still `running` | missing `done` on WS; `/run-status` |

## Key code

- `src/server/services/chatAgentService.ts` — `tryDispatchInteractiveTurn`, `publishInteractiveLive`, `publishRunEventEnvelope`
- `src/server/services/interactiveLiveBus.ts` — Redis pub/sub (no-op if REDIS unset)
- `src/server/services/interactiveGatewayService.ts` — WS attach + replay + live subscribe
- `src/server/services/interactiveWorkflowRouter.ts` — flag / shed → in-process
- `src/client/hooks/useChatStream.ts` — WS vs SSE, `/run-status` safety net

## Key telemetry (App Insights `customEvents`)

| Event | When |
|-------|------|
| `chat.messages.accepted` | HTTP 202 accepted (before async turn) |
| `chat.send.start` | `sendMessage` entered |
| `interactive.dispatch.attempt` | Actor-path attempt started |
| `interactive.dispatch.stage` | Stage change (`ground-turn`, `prepare-turn`, `enqueue`, `route`, `post-actor`) + `elapsedMs` |
| `interactive.dispatch.bypass` | Early skip / fail-closed with `reason` |
| `interactive.dispatch.timeout` | Attempt exceeded timeout (default 45s) |
| `interactive.dispatch.failed` | Thrown error during attempt |
| `interactive.dispatch.actor` | Admitted + posted to ACA |
| `chat.send.interactive_result` | Actor vs in-process decision |
| `chat.send.failed` | Uncaught `sendMessage` rejection |

Query with `query_insights.py --env stg --thread <uuid>`. Last stage before silence = hang location.

## Env notes

| env | App | Slot | Redis hint |
|-----|-----|------|------------|
| dev | `app-scrum-dev` | (none) | `redis-apex-ai-dev` |
| stg | `app-apex-prd` | `staging` | `redis-apex-ai-prd-v2` |
| prd | `app-apex-prd` | production | `redis-apex-ai-prd-v2` |

Staging and prod share Postgres (`psql-apex-eus2`) and App Insights (`appi-app-apex-prd`).

Update [environments.json](environments.json) when infra names change (e.g. Redis cutover).
