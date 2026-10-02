# Playbook Phase 2 — design-doc validation demo runbook

The Phase 0 runbook drives two synthetic definitions that deliberately touch no pipeline artifact.
This one drives the first Playbook that does: the canonical design-doc validation graph, running
the same scoring and status transition the hand-written watcher already performs.

That difference is the whole point of the demo, and it is also the risk. A beat that goes wrong
here writes a real design doc's status. Rehearse against a throwaway design doc you own, not
against anything a person is waiting on.

Rehearse **beat 4** first — the branch. It is where the run stops looking like a script and starts
looking like a decision, and it is the beat most likely to surprise you, because which way it goes
depends on a score you do not control.

---

## Before the room

| # | Do | Expect |
|---|----|--------|
| P1 | `npm run migrate:up` | Migrations current, including `run_input` on `playbook_runs`. |
| P2 | Platform Admin → Feature Flags → enable `playbooks-production-adapters` for the project | Seeded `false`. Every Phase 2 surface stays hidden until this is on. |
| P3 | Project Admin → Skills → set the design-doc validation Skill | `.cursor/skills/design-doc-validation/SKILL.md`. There is no default; publishing fails without it. |
| P4 | `npx ts-node --project tsconfig.server.json scripts/seed-design-doc-validation-playbook.ts --project Apex` | One definition printed, with its id and the scoring Skill it resolved. |
| P5 | Run it a second time | `already present`. Nothing duplicated, no version bump. |
| P6 | Confirm you hold `playbooks:view` and `playbooks:run` in *this* project | Phase 1 seeds both to `admin` only. |
| P7 | Open a design doc **you own**, in this project | The start action only renders for the owner. |
| P8 | Confirm something is claiming agent runs | The scoring step enqueues and waits. With no worker, beat 3 never ends. |

P2 and P3 are both preconditions of P4, and the script checks them in that order, so a failure
message tells you which one you skipped.

---

## The sequence

### Beat 1 — the definition exists and is immutable

**Do:** Open `/playbooks`.

**Expect:** **Design-Doc Validation** in the definition list, published, five steps.

Worth saying before anything runs: this graph was published through the same lifecycle any
author's definition goes through, which means the read-only-MCP refusal ran against it. A version
of this Playbook with a write-capable agent step cannot be published at all.

### Beat 2 — start it as the owner

**Do:** In Design Doc Review, click **Start validation Playbook**.

**Expect:** A run appears at `/playbooks`, pinned to the current published version, status
**Running**, with `score` active.

Two things to say out loud here. The run executes as the document's owner, not as whoever pressed
the button — the two are the same person today only because the action is owner-only. And the
document's `validationThreadId` is now bound into the run, which is what the next beat depends on.

**Do:** Click it again.

**Expect:** The same run, not a second one. Starting twice against a document with a live run
returns the run that is already going.

### Beat 3 — scoring, with a real deadline

**Do:** Expand the run and inspect `score`.

**Expect:** **Waiting**, with a 60-minute deadline.

Sixty minutes is not a round number someone liked. It is the existing watcher's ceiling — five
seconds times 720 attempts — carried across deliberately, so an orchestrated run times out when
the hand-written one would have. The blanket step default is 48 hours; if you see that here, the
definition was published from stale configuration.

### Beat 4 — ingest and branch ⭐

**This is the beat. Rehearse it first.**

**Do:** Let `score` finish. Watch `ingest`, then `route`.

**Expect:** `ingest` completes, and `route` sends the run one of two ways — to `approve-ready` if
the scorecard cleared the readiness threshold, or to `notify-revision` if it did not.

The claim to make: `ingest` did not write the document's status itself. It called
`ingestValidationScorecard`, the same exported function the watcher calls. There is one writer of
design-doc validation status in this codebase, and both paths go through it. That was the
precondition for this Playbook existing at all — a step that re-implemented the status logic would
have been a second writer free to drift.

Have an answer ready for the score you get. You do not control which branch fires, and rehearsing
only the ready path means the revision path is unrehearsed in front of an audience.

### Beat 5a — the gate renders its own inputs

*If the run routed to `approve-ready`.*

**Do:** Inspect the suspended gate.

**Expect:** An approval form built from the gated step's schema, populated with the resolved
values the step actually produced — not a bare approve/reject.

**Expect:** The approver pool resolved from current design-doc approver membership, at suspend
time. Not a snapshot taken when the definition was published.

If the pool resolves empty, the step **fails** in the same cycle rather than passing. That
inversion is deliberate and worth naming: an unattended document approval auto-completes, but a
Playbook gate with nobody in it is a missing precondition, not consent.

### Beat 5b — the owner is told to revise

*If the run routed to `notify-revision`.*

**Do:** Check the owner's notifications.

**Expect:** "Design doc needs revision", linking back to the document.

Less dramatic than the gate, and equally the point: the branch chose this without any code knowing
which document was being scored.

### Beat 6 — pending work on Home

**Do:** As a resolved approver, open Home.

**Expect:** The assigned-to-me tile lists the gate, ordered by deadline, with the soonest expiry in
the summary. A viewer who is not a resolved approver does not see it.

This is the beat that answers "how would anyone know a gate is waiting for them", which Phase 0
could not answer — there, the only person who needed to find a gate was the one running the demo.

### Beat 7 — approve, and land the status

**Do:** Approve the gate.

**Expect:** The run reaches **Completed**, and the design doc lands in the same status the watcher
would have set for that score.

The sentence to end on: nothing in this run was special-cased for design docs. Scoring, ingestion,
branching and the gate are registry step types, driven by a stored graph.

### Beat 8 — the second take

**Do:** Re-run the seed script, then start the Playbook against a different design doc you own.

**Expect:** No duplicate definition, and a fresh run. No SQL run by hand.

---

## If a beat diverges

| Symptom | Most likely cause |
|---------|-------------------|
| No **Start validation Playbook** button | The flag is off for this project, you are not the document's owner, or you lack `playbooks:run`. |
| Seed script: "flag is disabled" | P2 skipped. |
| Seed script: "no design-doc validation Skill configured" | P3 skipped. |
| Start returns 403 | Someone else owns the document. |
| Start returns 404 | The document is in a different project, or the flag is off — a disabled flag reports not-found rather than advertising the feature. |
| `score` sits at **Waiting** past its deadline | Nothing claimed the agent run. Worker problem, as in Phase 0. |
| `score` shows a 48-hour deadline | The definition carries stale configuration; re-run the seed script. |
| `ingest` completes but the document did not change | An arbiter discard. A newer validation thread won, so the step is a no-op, not a failure. Correct behavior, and awkward to demo — check the document's current thread before starting. |
| The gate fails immediately | The resolved approver pool is empty. Add a design-doc approver. |
| Publish rejected for MCP | A `cursor-agent` step is configured write-capable. Refused by design. |

---

## What this demo deliberately does not show

- **Automatic triggering.** Starting is a manual, owner-only act. Firing this Playbook from a
  design-doc status transition is later work.
- **Replacing the watcher.** With the flag off, the hand-written path is unchanged. With it on,
  this is an equivalent alternative on the same transition, not a cutover.
- **Authoring.** Still no UI for composing a definition; this one is seeded. The canvas is Phase 4.
- **Spend admission.** Configured in Project Admin and enforced on start, but demonstrating a
  rejection needs a project already near its cap, which is not something to stage live.
