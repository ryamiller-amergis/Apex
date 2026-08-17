---
name: interactive-chat-troubleshoot
description: >-
  Diagnoses broken Apex Agent Home / interactive chat streaming (WebSocket live
  bus, Redis, in-process fail-closed, stuck thinking, no tokens). Use when chat
  does not stream, the composer stays running, tokens never arrive, ai-runs-interactive
  misbehaves, or the user pastes a /home?thread= URL for cloud DEV, staging, or prod.
---

# Interactive Chat Troubleshoot

Fast, script-driven diagnosis of **user ↔ AI agent live communication** (Agent Home / interactive WS path). Prefer these scripts over inventing Azure commands. Cross-link: interview MCP hangs → `hung-interview-troubleshoot`.

## Step 0 — Ask the user (required)

Before any Azure/DB work, ask which environment they are troubleshooting. Use this exact prompt (or AskQuestion with the same three options):

> Which environment are you troubleshooting?
> - **dev** — cloud DEV (`app-scrum-dev`)
> - **stg** — staging slot (`app-apex-prd` / slot `staging`)
> - **prd** — production (`apex.amergis.com`)

Also collect a **thread id** (from `/home?thread=<uuid>` or paste). Do not proceed without `env` + `threadId`.

Load resources from [environments.json](environments.json) for that `env`. Never hard-code RGs in ad-hoc commands.

## When to load

- Agent Home chat stuck “thinking” / no stream / composer locked
- User says interactive / WebSocket / Redis live bus is broken
- Tokens delayed or never appear while the run completes server-side
- URL like `https://apex.amergis.com/home?thread=…` or staging/dev equivalent

Do **not** use for interview tool hangs (use `hung-interview-troubleshoot`) or Terraform apply questions (use `terraform-infra`).

## Invariants (read once)

1. Client on `ai-runs-interactive` uses **WebSocket** → gateway → **Redis** live bus (`apex:interactive:live:<threadId>`).
2. Turns may run **actor (ACA)** or **in-process** (fail-closed). In-process must still publish to the live bus (`publishInteractiveLive` in `chatAgentService`).
3. SSE uses in-memory + `pg_notify`; WS must get Redis (or same-instance in-memory).
4. Silent Redis + in-process = client never gets `done` → UI stuck.

Details: [reference.md](reference.md).

## Scripts (run these — do not reinvent)

All paths relative to repo root. Prefer PowerShell on this team’s Windows machines.

| Script | Purpose |
|--------|---------|
| `scripts/print_env.py --env <dev\|stg\|prd>` | Show resolved resource map |
| `scripts/check_app_settings.py --env …` | REDIS_* present? websockets? dispatch URL? (no secret values) |
| `scripts/diagnose_thread.js --env … <threadId>` | DB: thread / runs / recent events + verdict |
| `scripts/fetch_app_logs.py --env … --thread … [--minutes 20]` | Download + filter App Service docker logs |
| `scripts/query_insights.py --env … [--hours 2] [--thread …]` | Fixed App Insights queries (route/dispatch/live) |
| `scripts/probe_live_bus.js --env … [--thread …] [--wait 60]` | Subscribe Redis; exit 0 if TOKEN seen |

Secrets: scripts fetch `DATABASE_URL` / Redis key via `az` into env vars and **never print** them.

### Common flags

```text
--env dev|stg|prd     required (except print helper)
```

### Typical PowerShell sequence

```powershell
# 0) Confirm map
python .cursor/skills/interactive-chat-troubleshoot/scripts/print_env.py --env stg

# 1) Config drift (fast)
python .cursor/skills/interactive-chat-troubleshoot/scripts/check_app_settings.py --env stg

# 2) DB snapshot (stg/prd: open temp Postgres firewall first if needed — see below)
$env:APEX_TROUBLESHOOT_DATABASE_URL = <from az — use helper in diagnose script>
node .cursor/skills/interactive-chat-troubleshoot/scripts/diagnose_thread.js --env stg <threadUuid>

# 3) Logs for that thread
python .cursor/skills/interactive-chat-troubleshoot/scripts/fetch_app_logs.py --env stg --thread <threadUuid>

# 4) Telemetry
python .cursor/skills/interactive-chat-troubleshoot/scripts/query_insights.py --env stg --thread <threadUuid>

# 5) Optional live prove (ask user to send "hello" on a fresh thread while this runs)
node .cursor/skills/interactive-chat-troubleshoot/scripts/probe_live_bus.js --env stg --thread <threadUuid> --wait 90
```

`diagnose_thread.js` and `probe_live_bus.js` can fetch credentials themselves when `--env` is set and `az` is logged into the right subscription.

## Postgres firewall (stg / prd)

When `needsPostgresFirewall` is true in environments.json:

1. `az account set --subscription "MSS-Production"`
2. Open temp rule on `psql-apex-eus2` / `rg-apex-prd-data` named `temp-interactive-chat-<you>`
3. Run diagnose
4. **Always delete** the firewall rule when finished

Reuse patterns from `prod-db-migrate` / `hung-interview-troubleshoot` for open/close. Never print `DATABASE_URL`.

## Decision tree (classify only — then open code)

Run in order; stop at first match:

| # | Check | If true → bucket |
|---|--------|------------------|
| 1 | `check_app_settings`: REDIS_* missing on target slot | **A — config drift** |
| 2 | `diagnose_thread`: no run / no sendMessage for send time | **B — send never hit** (client stuck / auth / blocked composer) |
| 3 | Logs show `Acquired local agent slot` and probe silent | **C — in-process, no live-bus publish** |
| 4 | Run `lane=ai-runs-interactive` but probe silent | **D — actor / ACA publish** |
| 5 | Probe sees TOKEN but UI stuck | **E — gateway / WS client** |
| 6 | Insights: zero `interactive.route.decision` while flag on | **F — early gate** (`nativeReads` / grounding) — still expect C if bridge missing |
| 7 | Thread `running` for many minutes, run terminal | **G — client stuck / missing done** |

Report: env, threadId, bucket letter, evidence (1–3 script lines), next fix. Do **not** start a broad multi-hour exploration.

## Output format

```markdown
## Interactive chat diagnosis
- **env:** stg
- **thread:** …
- **bucket:** C — in-process, no live-bus publish
- **evidence:** …
- **next action:** …
```

## Rules

- Ask for **env** first every time.
- Prefer scripts in this folder; do not invent long `az` one-liners.
- Bound waits (`--wait` ≤ 120). No open-ended console awaits.
- Never log secrets / connection strings / Redis keys.
- Clean up temp log zips and Postgres firewall rules.
