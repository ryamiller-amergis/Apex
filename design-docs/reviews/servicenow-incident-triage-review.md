# Phase A Agent Review Metrics - #61556

| Field | Value |
|---|---|
| Work item | #61556 - Apex: triage ServiceNow MaxView incidents and post results to Teams |
| ADO link | https://dev.azure.com/Amergis/_workitems/edit/61556 |
| Branch | feature/61556-servicenow-incident-triage |
| Reviewed by | reviewer subagent, round 2 pending |
| Team member | laleduy@maximstaffing.com |
| Generated at | 2026-11-23T12:00:00-06:00 |
| Review invoked | yes |
| Outcome tag | pr-reviewed |

## Scope
The diff adds:
- the ServiceNow client;
- redaction;
- the sweep scheduler with its lease and watermark;
- V2 document-run admission and harvest for the `incident-triage` workflow;
- the Teams Adaptive Card poster;
- the encrypted webhook setting;
- routes, the `/incident-triage` page, and admin settings;
- migrations, the feature flag, and permissions.

Reviewed with `git diff origin/main` plus untracked files.

## Review status
- Invoked: yes
- Skip reason (if any): N/A
- Round 1 (2026-11-20): FAIL with 2 Major findings. Two Minor findings were raised to must-fix because they broke the project scoping and the retry behavior the acceptance criteria require.
- Fix round (2026-11-20): implemented test-first. 10 server suites (292 tests) and the client page suite (27 tests) pass.
- Round 2 (2026-11-20): FAIL. All round 1 fixes were verified, with 1 new Major finding (R2-M1) and 4 Minors. The second fix round is in progress.

## Findings
**Round 1 (2026-11-20)**

Must-fix:
- **M1, addressed:** the Teams card link left out `project`, and the page ignored `?incident=`. The link now carries both, and the page opens the detail from the URL.
- **M2, partly addressed:** text from the person who filed the incident reaches an agent that has shell and Azure CLI access, and card text could carry links.
  - Done:
    - the prompt marks the incident text as untrusted data, and marker text inside an incident is neutralised;
    - card text has its links and URLs stripped;
    - a Risks entry and a Security operator item are added.
  - Not done: no supported setting limits shell to Azure CLI for this run, so the tool limit is listed as a remaining risk.
- **m2, addressed (raised to must-fix):** admission and Teams retries crossed projects and ignored the flag. They now run once per tick, limited to eligible projects, and the on-demand sweep handles only its own project.
- **m4, addressed (raised to must-fix):** `running` rows had no reaper. The sweep now fails rows older than 45 minutes that have no active agent run.

Should-fix:
- **m3, addressed:** failed rows kept `teams_status = pending`; they are now `skipped`.
- **m7, addressed:** error logs could include query text. They now log only the error name and code.
- **m8, addressed:** webhook fetches followed redirects. They now use `redirect: 'error'`.
- **m9, addressed:** the design doc disagreed with the code. Fixed the architecture, the data columns, VT-19, VT-27 to VT-39, and the T14 task.
- **m10, addressed:** analyze returned 409 for a missing incident. It now returns 404.

Nice (not addressed; follow-ups to file after merge):
- **m1:** rows skipped because they are already running still use an admission slot, and two pending hashes for one incident can cause a duplicate run.
- **m5:** offset paging can skip a row that is updated during a sweep.
- **m6:** redaction misses 9-digit SSNs without dashes, ids of 5 or 9+ digits, and addresses.
- **m11:** overriding the skill path silently drops Azure sign-in.

**Round 2 (2026-11-20)**

Must-fix:
- **R2-M1, fix in progress:** the reaper failed `running` rows whose agent run had finished but was not harvested yet. The late harvest then kept `teams_status = skipped`, so the card never posted. The fix skips rows that are waiting for harvest, and a late completion resets the Teams status to pending.

Should-fix:
- **R2-m1, fix in progress:** the untrusted-marker regex missed whitespace variants.
- **R2-m3, fix in progress:** a lost claim returned 404; it now returns 409.
- **R2-m4, addressed:** the design doc now gives the reaper's scope, states the shell limit, and adds VT-40 and VT-41.

**Round 3 (2026-11-23)**: FAIL, with 1 open Major. This was the last review round the harness allows. The developer chose to fix the findings without another review round.
- **R3-M1, addressed (fix-3, no further review):** the reaper's harvest-pending check did not skip a run that a newer run on the same thread had superseded. The harvester never offers such a run, so its analysis row stayed `running` and blocked the incident. The `harvestPending` clause now matches `isDocumentHarvestPending` in `finishedAttemptReader.ts` (lines 333-346). A store test pins the clause. The reaper SQL was run against local Postgres in a rolled-back transaction: the superseded, harvested and no-agent-run rows were reaped; the newest and lone rows were left alone.
- **R3-m1, addressed:** the marker regex now matches any run of whitespace or format characters between the words, with no leading or trailing word boundary. Tests cover `_END`, `xEND`, a zero-width space, and a word joiner with a soft hyphen.
- **R2-M1, R2-m1, R2-m3:** verified fixed in round 3.

Verification after fix-3 (orchestrator rerun, 2026-11-23): server 10 suites / 305 tests pass; client 27 tests pass.

**Live test (2026-11-23, local Apex stack with stubs)**: 8 PASS, 0 FAIL, 3 BLOCKED.
- BLOCKED: VT-06 and VT-07 model output (need a cloned repository mirror, the V2 worker, Docker for Redis and Dapr, and a real model); VT-10 Teams rendering (needs a real webhook and the data-policy sign-off).
- The live test's first server run had the third-party keys in its environment and made about 77 read-only outbound calls (Cursor hosts). No ServiceNow or Teams calls were made. Later runs blocked outbound calls.
- Finding (fixed in fix-4): the webhook settings mask showed the last 4 characters of the URL, which for Workflows URLs are part of the signature. The mask now shows the host only, and a non-URL value shows a fixed placeholder.
- Also observed, not fixed (Minor): scheduled admission failures log only "Error", and a double-click on Re-analyze sends two requests, with the duplicate guard not exercised.

**Fix round 4 (2026-11-23)**: webhook mask host only. Tests: server 305 pass; client 27 pass.

Nice (not addressed; to check during the live test):
- **R2-m2:** bare domains such as `evil.example/login` and the escaped brackets need checking against how Teams renders them (VT-10).

## Counts
| Severity | Raised | Addressed | Not addressed |
|---|---|---|---|
| Must-fix | 4 | 4 | 0 |
| Should-fix | 5 | 5 | 0 |
| Nice | 4 | 0 | 4 |
| **Total** | 13 | 9 | 4 |

## Confidence
- **Implementation Readiness:** 70% - unit and route tests pass (292 server, 27 client). Live ServiceNow and Teams checks are still pending.
- **Review Thoroughness:** 75% - round 1 read the full diff but ran no commands itself; round 2 is pending.

## Self-healing updates
Design doc updated for m9 and T14.
