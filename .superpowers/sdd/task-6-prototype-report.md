# Task 6 Prototype Completion Report

Status: DONE

Commits:
- `82755f09` — EXTEND context and image parity.
- `4f2213fe` — relevance and byte-budget source selection.
- `6787a889` — Bedrock retry parity.
- `0dbff585` — generation-owned stale-artifact fencing.
- `72fed35a` — Task 6 plan update.

Verification:
- Retry RED: five suites failed as expected; GREEN: five suites, 96 tests passed.
- Ownership RED: four suites failed; GREEN: five suites, 68 tests passed.
- EXTEND/request-response/source budget: eight suites, 118 tests passed.
- Regression matrix: 35 suites, 446 tests passed.
- Server build/type-check and diff checks passed.

No migration, push, PR, cloud, infrastructure, deployment, or protected-config change.

## Needs-fixes remediation — 2026-09-22

Status: DONE

Fix commits:
- `5fb9a06b` — normalize prototype responses across transports.
- `e9100c85` — align V1/V2 source coverage and bound the relevance cache.
- `60e35144` — reconcile ambiguous prototype admission before fallback.

Resolved findings:
- V1 and V2 now share one response normalizer. Markdown fences, whitespace,
  empty completions, accepted/refused verdicts, and final stored HTML are
  identical for the same Bedrock reply.
- The live ADO design-system path no longer stops at twenty component files.
  It reads every relevance-ranked candidate with at most four concurrent
  requests, applies the explicit byte budget, and reports unreadable and
  budget-omitted paths deterministically. Omission text renders even when no
  source file fits.
- V1 and V2 resolve the same pinned source files, catalog, screen inventory,
  byte budget, and omission list. The request comparator no longer removes a
  worker-only source section.
- Prototype generations use deterministic V2 run IDs. Admission throws,
  timeouts, or missing responses query the durable run by run/thread/subject
  identity; V1 starts only after the database proves the intended run absent.
  Intended conflicts are treated as admitted, while unrelated conflicts keep
  the existing explicit fallback behavior.
- The feature-text catalog cache removes expired entries and retains at most
  64 deterministic insertion-ordered entries.

TDD evidence:
- Response normalization RED: 2 suites failed, 5 tests failed / 3 passed;
  GREEN: 3 suites / 22 tests passed. Request plus stored-response parity:
  2 suites / 21 tests passed.
- Source coverage RED: 4 suites failed, 4 tests failed / 53 passed. The
  non-empty cross-transport source fixture also failed 3 parity tests before
  V1 shared the source context. GREEN: 7 suites / 102 tests passed.
- Admission reconciliation RED: 2 suites failed, 6 tests failed / 28 passed;
  GREEN: focused ownership/admission coverage passed, followed by 7 suites /
  117 regression tests.
- Cache RED: 1 test failed / 12 passed; GREEN: 13 tests passed.

Final verification:
- Covering prototype/V2/worker/orchestrator/Bedrock matrix: 37 suites /
  471 tests passed.
- Server build/type-check: passed.
- Unstaged and staged diff checks: passed.

No migration, push, PR, cloud, infrastructure, deployment, or protected-config
change was made for this remediation.
