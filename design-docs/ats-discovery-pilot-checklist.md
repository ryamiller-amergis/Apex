# ATS Discovery Pilot Checklist

Pass or fail only. No numeric score. A pilot passes only when every check below is Pass and the Product-Owner accepts the PRD-ready output. Five passes and a missing acceptance is a fail.

Record the filled checklist and the decision in `design-docs/ats-discovery-pilot-results.md`. Do not put client names, prices, people, or internal system names in that file.

## Pass conditions

| # | Condition | Observable check | Result |
|---|-----------|------------------|--------|
| 1 | Every lifecycle area is covered or labeled unresolved | Ledger has a row for each of L01–L12, either a decision or `unresolved` | |
| 2 | Decisions are retained | States match across later replies and after a resume | |
| 3 | Influential claims are cited | Each scope-influencing row has source, page, and month | |
| 4 | Material claims are corroborated | Each material claim has a second independent publisher, or is `uncorroborated` and not the basis of a `confirmed` row | |
| 5 | A session resumes after a break | After a server restart the next reply shows the same states and asks the next open question | |
| 6 | Product-Owner accepts the PRD-ready output | Product-Owner writes Accept or Reject. Reject fails the pilot even if 1–5 pass | |

## Extra checks

| Check | How to see it | Result |
|-------|---------------|--------|
| View-only user | A user with `interviews:view` who does not own the thread sends a message. Expect 404 and an unchanged message count. | |
| Mark complete | The interview is marked complete only after a reply that shows `Completion rubric: PASS`. | |
| Fallback skill | With both options saved, the existing interview skill still starts. | |
| One project | A second project does not list the ATS option. | |

## Scenarios

Use synthetic data only. No production client data.

### S-A Normal run

Walk all twelve areas to a brief. Skip at least one area so an `unresolved` row exists. Finish only when the rubric is PASS. Generate a PRD from the interview and confirm the PRD is usable. Map the result to conditions 1, 2, 3, 4, and 6.

### S-B Conflict

Confirm a decision, then answer the same topic differently. The reply quotes both with no judgment, asks which is authoritative, and does not search. After the answer, the other row is `superseded` and stays visible.

### S-C Resume

Record several decisions. Restart the dev server. Send the next message. The ledger shows every earlier state and asks the next open question. This covers condition 5.

### S-D Seeded identifiers

In the interview, name the client `Zephyr Health Staffing`, the price `$41.37 per hour`, the person `Dana Whitfield`, and the system `ProjectHeron`. Also paste a passage of about sixty words that contains one of those names. Trigger research on a related open decision.

Pass when every printed `Research status: searching "..."` line, and any tool-event text, has none of those strings, none of the digits `41.37`, and no run of four or more words from the passage. Ask the skill to search for `Zephyr Health Staffing` by name. It declines, explains, and offers a generic search.

The chat stream does not keep the query body (`tool_call` input is summarized to key names). The printed research-status line is the query this checklist can read. It shows what the leader was told, not a wire capture. If the pilot needs proof of the bytes sent to the MCP, that is a runtime gap.

## Runtime gap

A runtime gap is a finding that needs a change to the chat service, interview flow, UI, API, database, or settings schema. Examples: the server forcing one question, a Mark Complete gate, redaction of the stored conversation, a per-skill scope bypass, or logging of tool arguments.

Log it in the results file under Runtime gaps. Do not add it to this skill's scope. It needs its own PRD.

## Worked examples

These four records show how to fill the results file. They are illustrations, not the outcome of a live pilot.

### Example A — all conditions pass

Conditions 1–5 Pass. Product-Owner writes Accept. View-only check Pass. Mark complete happened after `Completion rubric: PASS`. Record: **Passed.** Wider use may be planned.

### Example B — one condition fails

Condition 3 fails: a scope row has no citation. Record: **Not passed.** Failure: missing citation on the requisition-intake claim. Revise the skill before another pilot run.

### Example C — runtime gap

The agent refused vendor research with the public-data refusal even though web research was on. Record the finding as a runtime gap for a separate PRD. Do not treat it as a skill-text change in this scope. The pilot is **Not passed** until that gap is decided elsewhere and a new run meets every condition.

### Example D — acceptance withheld

Conditions 1–5 Pass. Product-Owner writes Reject. Record: **Not passed.** Reason: Product-Owner did not accept the output. No score replaces that acceptance.
