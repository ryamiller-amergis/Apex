# Task 6 UI Lab Completion Report

Status: DONE

Commits:
- `d2edcac5` — shared prompt parity.
- `d12f8368` — durable streaming progress.
- `31359c09` — flagged V2 routing and harvest.
- `bdf8755f` — reserved UI Lab capacity.
- `998013c4` — streaming parity.
- `321cbcd6` — replay hardening.
- `6d13c306` — master-plan update.

Implemented:
- Separate default-off `ui-lab-v2-transport`.
- Bounded worker streaming through durable checkpoints and SSE replay.
- Immediate generation-owned artifact/usage harvest with recovery fallback.
- Shared visual queue, provider cap 2, one prototype-ineligible slot reserved for UI Lab.

Verification:
- 41 suites, 490 tests passed.
- Server and client builds passed; client only had existing bundle warnings.
- Worker DB-isolation and diff checks passed.
- No protected, cloud, infrastructure, deployment, push, or PR changes.

## Review remediation — 2026-09-22

Status: DONE

Commits:
- `cda0e454` — count only published provider work and use generic capacity classes.
- `3dce2688` — reconcile active UI Lab V2 runs before flag evaluation.
- `8d443124` — paginate durable replay and persist final snapshots.
- `637a63ef` — persist UI Lab output, usage, and harvest completion atomically.
- `e8d05729` — freeze Bedrock region, enforce the V2 stream deadline, and align raw-response estimates.
- `939dba34` — recover missing final snapshots on ready reconnect.

Resolved:
- Dispatched attempts no longer consume capacity until their outbox command is
  published. Running, checking, and finalizing attempts still count. Provider
  cap 2 and the one-slot interactive reservation remain enforced.
- Orchestrator capacity uses only `interactive` and `batch`; UI Lab and
  prototype names remain in the visual specification/worker domain.
- Active V2 generation wins before the flag is read, so a disabled or
  unavailable flag cannot start V1 over it.
- UI Lab event replay pages oldest-first past 500 events, keeps run filtering,
  and persists a deterministic final snapshot event. Ready reconnects restore
  any missing tail before completion and deduplicate the snapshot event.
- The generation CAS, usage insert, and harvest completion now commit in one
  database transaction. Usage failure rolls the output write back and leaves
  the durable claim open for replay.
- App Service resolves the Bedrock region into every visual specification.
  Workers construct clients from that required region and hold no environment
  fallback.
- V2 streaming timeout now covers retries, backoff, request send, and full
  response-body iteration. V1 keeps its previous per-request behavior.
- V1 and V2 estimate missing usage from the same raw response, including
  markdown fences.

TDD evidence:
- Capacity accounting RED: 5 suites failed, 10 tests failed; GREEN: 6 suites,
  44 tests passed, including unpublished-attempt and two-interactive-run cases.
- Reconnect-before-flag RED: 1 focused test failed; GREEN: 9 routing tests passed.
- Replay RED: 5 tests failed; GREEN: replay and notification suites passed,
  including more than 500 events and final snapshot reconnect cases.
- Usage RED: awaited insert and harvest durability tests failed; GREEN:
  usage/harvest suites passed, including replay without duplicate usage.
- Region/timeout/estimate RED: missing region validation, stalled-body timeout,
  and fenced estimate tests failed; GREEN: the covering visual policy/parity
  matrix passed.

Final verification:
- Covering matrix: 45 suites, 588 tests passed.
- Server build/type-check: passed.
- Client build/type-check: passed with existing Vite third-party annotation and
  chunk-size warnings only.
- Worker database-isolation guard: passed.
- Committed and working-tree diff checks: passed.

No migration, protected config, infrastructure, cloud, deployment, push, or PR
change was made. Task 6 remains pending final review rather than declared
complete.
