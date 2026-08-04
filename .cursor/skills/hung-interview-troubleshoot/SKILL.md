---
name: hung-interview-troubleshoot
description: Diagnoses and unsticks hung Apex interview (or ADR) chat turns stuck on running/generating with no stream. Use when the user says an interview is hung, stuck, spinning, lost context, restarting from scratch, or links a /backlog/interview/{id} URL that will not accept the next answer.
---

# Hung Interview Troubleshoot

Diagnose why an interview chat turn is stuck, classify the failure mode, recover safely when appropriate, and report the root cause — without forcing a new interview.

## When to load

Load immediately when any of the following are true:

- User says an interview / grill session is hung, stuck, spinning, or not responding.
- User links `https://apex.amergis.com/backlog/interview/{uuid}` (or local equivalent) and reports a hang.
- User says the agent "lost context" / "started from scratch" mid-interview after a long wait.
- User asks to unstick, cancel, or reset a stuck interview thread.

Do **not** use this skill for PRD/design-doc `generating` limbo unless the hang is on the interview chat thread itself — those use generation watchers + `recoverInFlightWork`.

---

## Extract IDs

From a URL like `/backlog/interview/8d9a5528-…` the path segment is the **interview id**.

Resolve `chat_thread_id` from `interviews` before inspecting runs.

---

## Prod access (required for live hangs)

Local `.env` points at localhost. For production:

1. Confirm Azure CLI auth: `az account show`
2. Open a **temporary** firewall rule on `psql-apex-eus2` / `rg-apex-prd-data` for the current public IP (name it `temp-interview-debug-<you>`).
3. Fetch `DATABASE_URL` from `app-apex-prd` / `rg-apex-prd-app` app settings into `PROD_DATABASE_URL`.
4. Prefer `node` + `pg` (see `scripts/diagnose-interview.js`) over `psql` when PATH is incomplete.
5. **Always delete the temp firewall rule** when finished.

Never print full connection strings or secrets in chat.

---

## Diagnostic checklist (run in order)

Use `.cursor/skills/hung-interview-troubleshoot/scripts/diagnose-interview.js`:

```bash
# PowerShell — after setting $env:PROD_DATABASE_URL
node .cursor/skills/hung-interview-troubleshoot/scripts/diagnose-interview.js <interviewId>
```

Or run the equivalent SQL manually.

### 1. Interview + thread snapshot

| Field | Healthy | Hung signal |
|-------|---------|-------------|
| `interviews.status` | `in_progress` | (status alone is not a hang) |
| `chat_threads.status` | `idle` | `running` for many minutes with no tokens |
| `chat_threads.active_run_id` | `null` when idle | set while UI spins |
| `chat_threads.last_error` | empty | reaper / cancel message |
| `last_activity_at` | recent | stale vs wall clock |

### 2. Active / latest `agent_runs`

For the thread, load the latest runs (status, `progress_label`, `progress_phase`, `heartbeat_at`, `progress_at`, ages, `last_error`).

Assess health the same way `agentRunReaperService.assessAgentRunHealth` does:

| Signal | Meaning |
|--------|---------|
| `heartbeat_age` ≫ 5m | `worker_lost` — App Service process died / deploy |
| `progress_age` ≫ 5m, label not `… running` | `progress_timeout` — model/tool stalled |
| label ends with `running` (e.g. `mcp:get_skill_file running`) for ≫ minutes | **Hung MCP/tool** — common interview hang |
| `status=queued` for ≫ 90s | never claimed by a worker |
| `last_error` contains `No meaningful progress` | reaper already aborted |

### 3. Last tool event on the active/terminal run

```sql
SELECT event_type, status, detail, event_timestamp
FROM agent_run_events
WHERE run_id = $runId AND event_type = 'tool'
ORDER BY ordinal DESC
LIMIT 10;
```

If the newest tool row is `status=running` with no matching `completed`, the turn is pinned on that tool.

**Important:** Prefer the tool event's `event_timestamp` age over `agent_runs.progress_at`. Heartbeat/progress can keep refreshing while an MCP tool is wedged, which makes the run look healthy when the UI is frozen.

### 4. Message pattern (context loss)

Check recent `chat_messages` for agent text that restarts pre-reads (`mandatory pre-read`, `scratch folder`, `I'll start by checking`) right after a cancelled/failed run — that is the **"starting from scratch"** user experience, not a separate bug.

---

## Known failure modes (interview)

### A. Hung MCP repo tool (most common)

**Symptom:** Thread `running`, `progress_label` like `mcp:get_skill_file running` / `mcp:search_repo_code running` / `in-flight running`, little or no streamed text.

**Which MCP server?** Check `chat_threads.kickoff.skillProvider` (and project skill settings):

| `skillProvider` | Repo browse MCP | Notes |
|-----------------|-----------------|-------|
| `github` | `github-repo` (`src/server/mcp/github/server.ts`) | Handlers use `raceWithTimeout` (default `MCP_TOOL_TIMEOUT_MS` = 35s). Hangs that last **minutes** usually mean the Cursor SDK stream did not observe tool completion even after the handler timed out/returned. |
| `ado` (default if unset) | `ado-skills` (`src/server/mcp/ado/server.ts`) | Repo tools are **not** wrapped in `raceWithTimeout` — a stuck ADO API call can pin the turn until cancel/reaper. |

Apex project interviews are often `skillProvider: github` even though the product historically defaulted to ADO — do **not** assume ADO from the tool name alone (`get_skill_file` exists on both servers).

**Confirm:** Last `agent_run_events` tool row stuck in `running`; often `progress_label = 'in-flight running'` after cancel. Also log `kickoff.skillProvider` in the report.

### B. Progress timeout during `analysis`

**Symptom:** `last_error = 'No meaningful progress for more than 5 minutes — run aborted'`, `progress_phase = analysis`.

**Why:** Heartbeat may still tick while no meaningful progress events fire; reaper aborts after `AGENT_PROGRESS_ABORT_MS` (default 5m).

### C. Stale `running` with no live run

**Symptom:** `chat_threads.status = running` but no queued/running `agent_runs` (or only terminal rows).

**Why:** Crash/deploy mid-turn. `recoverStuckInterviewThreads` in `startupRecovery.ts` clears these when `isThreadRunAlive` is false.

### D. False alarm — turn still healthy

**Symptom:** Fresh `heartbeat_at` / `progress_at` (seconds old), phase `analysis` or streaming about to start.

**Action:** Tell the user it is still working; wait ~30–60s before canceling. Do not reset.

### E. Hung non-MCP tool

**Symptom:** The latest tool event is still `running` for minutes but is not prefixed `mcp:` — for example `shell running`, `edit running`, or `read running`.

**Why:** The Cursor SDK tool process has not emitted a terminal event. MCP transport fixes do not address this class; recovery still requires cancelling the run so the owner force-disposes the agent. The shared in-flight watchdog is the fallback.

---

## Recovery (after classification)

Prefer least destructive:

1. **False alarm** → wait; do not mutate.
2. **Active hang, user wants to continue same interview**
   - Cancel via API: `POST /api/chat/threads/{threadId}/cancel` (calls `cancelRun` + `clearStaleRun`). Prefer this — it NOTIFYs the owner and force-disposes the Cursor CLI.
   - Or SQL only if API unreachable (prod, with care):
     - Mark active run `cancelled`/`failed` with a clear `last_error`.
     - Set thread `status='idle'`, `active_run_id=null`, optional `last_error`.
     - Run as **separate autocommit statements** (not one transaction with optional inserts). A failed follow-up statement aborts the PG transaction and silently rolls back the cancel.
   - Re-diagnose after ~3s to confirm the owner did not keep the run `running` (heartbeat still ticking).
3. **After cancel** → tell the user to send a short resume message that **re-states locked Q answers** (the next turn often re-runs skill pre-reads and looks like "starting from scratch"). Paste a compact decision log if they have one.
4. **Do not** create a new interview unless the thread/workspace is corrupt or the user explicitly wants a restart.

Never delete `chat_messages` as part of recovery.

---

## Report format (always)

```markdown
## Verdict
<one line: hung | recovering | healthy | false alarm | recovered_from_hang>

If the latest user message has no following agent reply and the latest run is `cancelled`/`failed` with a stuck MCP tool event, report **recovered_from_hang** (thread idle but turn incomplete — user must resend / resume).

## Evidence
- Interview / thread / active run ids
- Thread status, run status, progress_label, ages, last_error
- Last tool event (if any)

## Root cause
<mode A–E + one sentence>

## Recovery applied
<none | cancel | SQL reset | …>

## Next step for user
<how to continue without losing the interview>
```

---

## Follow-up fixes (mention, do not implement unless asked)

- For **ADO** projects: add `raceWithTimeout` to ADO MCP repo tools (parity with GitHub MCP).
- For **GitHub** hangs that last minutes despite `raceWithTimeout`: investigate Cursor SDK / MCP Streamable HTTP path — handler timeout may return while the agent tool_call stays `running` until cancel/reaper.
- Durable worker tier / event-driven completion (see ADR on worker-tier + artifact handoff) so hung tools cannot pin the web instance.

---

## Cleanup

Delete any temp Postgres firewall rule opened for diagnosis before ending the session.
