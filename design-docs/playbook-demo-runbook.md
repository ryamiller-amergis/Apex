# Playbook Phase 0 — demo runbook

The sequence to rehearse, and then to run live. Every beat lists **what you do** and **what you
should see**, because the point of a rehearsal is catching the moment reality diverges from the
script — and a script that lists only the actions gives you nothing to notice the divergence
against.

Rehearse the **restart-while-suspended** beat first (beat 5). It is the centrepiece and the hardest
to fake, and if it does not work, nothing else in this document matters.

The whole sequence is repeatable with no manual database cleanup between attempts. If you find
yourself reaching for a `DELETE`, something has regressed — the seed script is idempotent by design
precisely so the second take works as well as the first.

---

## Before the room

| # | Do | Expect |
|---|----|--------|
| P1 | `npm run migrate:up` | Migrations current; `playbook_definitions` and friends exist. |
| P2 | `npx ts-node --project tsconfig.server.json scripts/seed-playbook-demos.ts --project Apex` | Two definitions printed. A fresh database gets published v1; an installation with legacy ungated Demo A v1 gets a corrected immutable v2. |
| P3 | Run it a second time | The same two, now `already present`. Nothing duplicated. This is the check that the demo survives a second take. |
| P4 | Confirm you hold `playbooks:view` and `playbooks:run` in the project | Epic 1 seeds both to `admin` only. |
| P5 | Open `/playbooks` | The status view renders. |

**Do not stage E2 or E4 live.** Killing the server mid-step and dropping the engine's schema are
both recorded as test evidence (`playbook-exit-criterion-e2.integration.test.ts` and
`playbook-exit-criteria.integration.test.ts`). Neither is a good thing to attempt in front of an
audience, and neither shows an audience anything a passing test does not.

---

## The sequence

### Beat 1 — the definition exists

**Do:** Open `/playbooks`.

**Expect:** The run list, or the empty state — "No Playbook runs in this project yet." — if this is
a fresh environment. An empty project is a normal state here, not an error; if you see an error
panel instead, stop and check your permissions before going further.

### Beat 2 — start definition A

**Do:** `POST /api/playbooks/runs` with `{ "project": "Apex", "definitionId": "<Demo A's id>" }`.
The seed script prints the id.

**Expect:** `201` with a run handle. Refresh `/playbooks`: a row appears reading
**Demo A — Ask, Approve, Notify**, pinned to the current published version, status **Running**.

Say out loud what "pinned version" means here, because it is the thing the demo is really about: the
run named the version it started on, and that version can never be edited afterwards. A later
version of the same definition will not change what this run is executing.

### Beat 3 — the gate parks before external work

**Do:** Expand the run row.

**Expect:** Three steps. `approve` reads **Waiting**. `ask` and `announce` read **Not started**.
No agent run has been enqueued: FEAT-008 requires approval before a `leaves-apex` step.

### Beat 4 — the gate parks

**Do:** Inspect `approve`.

**Expect:** Under `approve`, a suspension block shows the cause — "Waiting for someone to approve
this step" — and a deadline in both forms, e.g.
`Deadline 2026-09-22 14:30 (in 2 days)`.

If the deadline field instead shows a red warning about no deadline being recorded, **stop the
demo**. That is a data-integrity bug, not a display quirk: a suspension with no deadline is
invisible to the reconciliation sweep and will wait forever.

### Beat 5 — restart the server while it is suspended ⭐

**This is the beat. Rehearse it first.**

**Do:** Kill the server process and start it again. Then reload `/playbooks` and expand the run.

**Expect:** Exactly what was on screen before the restart — `approve` still **Waiting** with the
same deadline, while `ask` remains **Not started**. Nothing was lost and no external work ran.

The point to make: the run's state was never in the process. It is in Apex's own tables, which is
why killing the process changed nothing. This is exit criterion E1, and there is a test for it
(`VT-17`) so it is not a one-off.

### Beat 6 — approve, run the agent, and notify

**Do:** `POST /api/playbooks/runs/:runId/steps/:stepRunId/decision` with
`{ "decision": "approved" }`.

**Expect:** `approve` moves to **Completed**. `ask` moves through **Running** and **Waiting** while
the agent run is processed, then **Completed**. `announce` runs, the Playbook reaches **Completed**,
and a notification arrives for the initiator.

The view polls every five seconds while anything is non-terminal. If `ask` does not move for more
than a minute after approval, the agent run has not been claimed; that is a worker problem, not a
Playbook one.

Worth saying: the approval worked after a restart, on the first attempt. The gate did not need to be
re-created or nudged.

### Beat 7 — run definition B, with nothing changed

**Do:** Start a run of **Demo B — Approve, Ask, Notify**. Same deployment, same build, no restart.

**Expect:** A second row appears. B parks immediately at its gate. Approve it, and its differently
configured agent step then runs, followed by its notification.

The point: B uses the same safe step order with different ids and configuration, and no application
line knows B exists. It runs from its stored graph alone. That is exit criterion E3, tested as
`VT-19` — including a check that no application source file names definition B.

### Beat 8 — the second take

**Do:** Re-run the seed script, then start Demo A again.

**Expect:** No duplicate definitions, and a fresh run of A. No SQL was run by hand between the two
takes.

---

## If a beat diverges

Correct the script before the live demo. Do not explain the divergence away on stage — a rehearsal
exists to find exactly this, and a beat that "usually works" is a beat that will not.

| Symptom | Most likely cause |
|---------|-------------------|
| `/playbooks` shows "Page not found" | The route is missing from this build. |
| The API returns 404 with the view rendering | The request did not name a project, or the requested run does not exist in that project. |
| The API returns 403 | You hold `playbooks:view` but not in *this* project — Epic 1 grants it to `admin` only. |
| A step sits at **Waiting** forever | The agent run was never claimed, or its terminal event was missed and the sweep has not yet run. The sweep ticks roughly every minute. |
| The deadline shows the red warning | A real data error. Stop; do not demo around it. |
| Definition duplicated after re-seeding | The idempotence check regressed. `VT-14` covers this. |

---

## What this demo deliberately does not show

- **Authoring.** There is no UI for creating a definition; that is the Phase 4 canvas.
- **Acting on a run from the view.** The status view is read-only; the gate is approved through the
  API. Approving from the view is Phase 1's.
- **E2 and E4.** Process death mid agent-step and dropping the engine's tables are recorded as test
  evidence, for the reason given above.
