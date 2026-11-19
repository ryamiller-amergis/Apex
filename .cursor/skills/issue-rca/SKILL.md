---
name: issue-rca
description: >-
  Investigates a reported Apex issue, including attached screenshots, logs, or
  files, against the application code, PostgreSQL, and the Azure resources
  described in infra/. Produces a root-cause analysis that says whether it is
  a bug and gives a coding agent a concrete fix handoff. Use when the user
  asks for an RCA, a root cause, or "is this a bug" on an Apex issue,
  incident, ticket, or error report.
disable-model-invocation: true
---

# Issue RCA

Investigate one reported Apex issue and publish a root-cause analysis. Do not change product code, Terraform, data, or Azure resources. A later coding agent uses the handoff section to make the fix.

## Read-only rule

The investigation runs in a subagent that must not mutate anything.

- Launch one `generalPurpose` subagent, `environment: "local"`. Do not use a cloud subagent.
- The Task tool has no read-only switch. The prompt below is the contract, and the scripts enforce it for Postgres and Azure.
- The subagent reads files and runs only the commands in [Allowed commands](#allowed-commands). It does not edit, create, or delete files, and it does not run git writes, `terraform`, `psql`, `node-pg-migrate`, or `az` directly.
- You write the RCA in chat after the subagent returns. That is the only write.

If the report is a stuck interview or Agent Home turn with no stream, load `.cursor/skills/hung-interview-troubleshoot/SKILL.md` or `.cursor/skills/interactive-chat-troubleshoot/SKILL.md` for the live checks, then fold those findings into the RCA template here.

## Workflow

```
- [ ] 1. Intake: issue text and every attachment
- [ ] 2. Route: pick the areas in ARCHITECTURE.md
- [ ] 3. Investigate: one read-only subagent
- [ ] 4. Judge: bug or not, from evidence only
- [ ] 5. Report: RCA plus coding-agent handoff
```

### 1. Intake

Take the issue from the user message, a ticket paste, or a file they point at. Record:

- what the user saw, what they expected, and when
- environment: local, cloud dev, staging, or production. Ask once if it is ambiguous. Do not guess production.
- ids in the report (user, project, thread, interview, request, work item, trace)
- every attachment. Read images with the Read tool. Read text, json, csv, and log files. For a file you cannot read, say so in the RCA instead of guessing its contents.

### 2. Route

Read [ARCHITECTURE.md](ARCHITECTURE.md). Pick the rows whose symptoms match the report. Read those Terraform files and the code they name. Do not read all of `infra/`.

### 3. Investigate

Launch the subagent with this prompt, the issue text, the environment, the attachment summaries, and the areas you picked. Pass image paths in `file_attachments` so the subagent sees the pixels.

```
You are a read-only investigator for one Apex issue. Do not edit, create, or delete files. Do not run git commits, terraform, psql, node-pg-migrate, or az. Postgres only through:
  node .cursor/skills/issue-rca/scripts/readonly-query.js "<sql>" [params...]
Azure only through:
  node .cursor/skills/issue-rca/scripts/readonly-az.js <allowlisted az args>
You may also run the existing readers named in the parent prompt. Never print connection strings, keys, tokens, or passwords.

Issue:
<paste>

Environment: <local|dev|stg|prd>
Areas to check: <from ARCHITECTURE.md>
Attachment notes: <what the parent already read>

Return:
- evidence (file path and line, query row count, or log line) for each claim
- checks you could not run and why
- the most likely cause
- what you ruled out
Do not recommend a code edit that you did not tie to a file.
```

Resume the same subagent once if a specific check would resolve a gap. Do not keep it going past that.

### 4. Judge

Pick one verdict. A missing log line is not evidence of a bug.

| Verdict | Use when |
|---------|----------|
| `bug` | Code does something other than what the product intends, and you can point at the file |
| `not_a_bug` | Behavior matches the code and the docs; the report is a misunderstanding or expected limit |
| `config` | An app setting, feature flag, or Terraform value explains it, and the code is consistent |
| `data` | A row is missing or wrong, and no code path would have written it that way on its own |
| `infra` | A resource is down, full, throttled, or unreachable, and the app is reacting to that |
| `insufficient_evidence` | The report plus the checks you could run do not support a cause |

Confidence is `high` only when two independent sources agree (for example a stack trace and the line it names). One plausible reading is `medium`. A guess is `low`, and the verdict is then `insufficient_evidence`.

### 5. Report

Use this template. Drop a section only when it does not apply.

```markdown
# RCA: <one line>

**Verdict:** bug | not_a_bug | config | data | infra | insufficient_evidence
**Confidence:** high | medium | low
**Environment:** <local|dev|stg|prd>

## What happened
<2–4 sentences: symptom, who it hits, whether it is still happening>

## Evidence
- <source>: <fact>

## Root cause
<The mechanism. Name the file and the resource. If the verdict is not a bug, say what the code actually does.>

## Ruled out
- <check>: <why it is not the cause>

## Could not check
- <check>: <why>

## Coding-agent handoff
- **Change:** <bug only — file, what to change, what must stay the same>
- **Do not change:** <config / data / infra / not_a_bug — say so and stop>
- **Tests:** <existing test file to extend, or the case to add>
- **Verify:** <command or click-path>
```

For `bug`, the handoff names files and the behavior change. It does not include a patch. For every other verdict, the handoff tells the coding agent not to edit application code and names the real next step (setting, row, resource, or a question for the reporter).

## Allowed commands

From the repo root. The scripts refuse writes before they connect.

Postgres. One statement, `SELECT`, `WITH`, `EXPLAIN`, or `SHOW`. The script opens a `READ ONLY` transaction, sets a 15s statement timeout, returns at most 50 rows, and redacts credential columns.

```bash
node .cursor/skills/issue-rca/scripts/readonly-query.js "SELECT id, status FROM chat_threads WHERE id = $1 LIMIT 5" <id>
```

`DATABASE_URL` (then `.env` / `.env.local`) is the local database. `PROD_DATABASE_URL`, when it is already set, is production. Do not open a firewall rule and do not fetch `DATABASE_URL` out of App Service settings. If production Postgres is not reachable, record that under "Could not check" and use App Insights instead.

Azure. Read-only `az` only: `show`, `list`, and `query` for the resources in [ARCHITECTURE.md](ARCHITECTURE.md). Resource names live in `.cursor/skills/interactive-chat-troubleshoot/environments.json`.

```bash
node .cursor/skills/issue-rca/scripts/readonly-az.js monitor app-insights query --app appi-app-apex-prd -g rg-apex-prd-data --analytics-query "exceptions | where timestamp > ago(6h) | take 20" -o json
```

These existing readers are also allowed. They do not print secret values.

- `.cursor/skills/hung-interview-troubleshoot/scripts/query-window-logs.py`
- `.cursor/skills/interactive-chat-troubleshoot/scripts/query_insights.py`
- `.cursor/skills/interactive-chat-troubleshoot/scripts/fetch_app_logs.py`
- `.cursor/skills/interactive-chat-troubleshoot/scripts/check_app_settings.py`

Confirm `az account show` matches the environment (`MSS-DevTest` for dev, `MSS-Production` for staging and production) before querying. Do not run `az account set` unless the user asked you to switch subscriptions.

## Secrets

Never print connection strings, keys, tokens, passwords, or App Service setting values. Ids, status fields, timestamps, and error messages are fine.
