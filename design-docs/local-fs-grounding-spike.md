# `local.fs` Grounding Spike (TBI-005)

> **Feature:** FEAT-001 (`SDK 1.4.0 upgrade and SDK adapter`)
> **SDK version evaluated:** `@cursor/sdk` `1.4.0`
> **Timebox:** 1 working day (static SDK contract + virtual filesystem benchmark)

---

## Question

Should Apex replace materialized on-disk workspaces (`local.cwd` + `BareRepoReader` / `LocalCheckoutReader` custom tools) with `@cursor/sdk` `1.4.0` virtual filesystem grounding (`local.fs`, `overlayFs`, `readOnlyFs`, `tempFs`, `unionFs`)?

---

## Findings on `@cursor/sdk` `1.4.0`

### 1. Startup gain

- Constructing an in-memory / bare-mirror-backed `FileSystem` tree (`unionFs` + `tempFs` overlay for `.ai-pilot/output`) avoids a working-tree checkout (`git worktree` / file materialization) before `Agent.create`.
- Cold-thread repository preparation drops from roughly **1.2 s – 6.5 s** (working-tree materialization on medium/large repos) to **< 50 ms** for virtual mount wiring, because file bytes are read lazily through `FileSystem` methods (`readFile`, `readdir`, `stat`, `grep`) only when the model invokes a file tool.
- However, Apex already avoids full working-tree clones on most read-only turns via `BareRepoReader` + `createNativeReadTools(checkout)` over bare git mirrors, and `1.4.0` adds `CursorAgentPlatform.prewarmLocalWorkspace(options)` (exposed on `cursorSdkAdapter.prewarm`), which pays rule/ignore/executor initialization ahead of the first `send()`.

### 2. Capabilities lost or constrained

Inspecting `node_modules/@cursor/sdk/dist/esm/options.d.ts` (lines 248–287) and `filesystem/` in `1.4.0` confirms four hard constraints when `local.fs` is set:

1. **Shell tool incompatibility / host cwd leak:** `local.fs` virtualizes built-in file tools (`read`, `edit`, `ls`, `grep`, `glob`), not OS child processes. Playbook steps that run Azure CLI (`az`) or repository scripts still require a real host directory (`local.cwd`).
2. **Skill and rule discovery coupling:** Project rules and skills only load from `AGENTS.md` and `.cursor/rules/` inside `reportedWorkspacePath` when `settingSources` includes `'project'` and the virtual tree mounts those exact paths; Apex's frozen-skill and companion-file injection would need a custom overlay per turn.
3. **Subagent inheritance conflict (`ConfigurationError`):** `options.d.ts` documents that combining `local.fs` with `subagentInherit` or `resourceProviderOptions` throws a `ConfigurationError` at `Agent.create` / `Agent.resume`.
4. **Resume coupling (`fs` required on every resume):** An agent created with `local.fs` **must** be supplied `local.fs` again on `Agent.resume` (and per-send `LocalSendOptions.fs` if overridden). Any mismatch between warm/resumed turns fails resume or silently changes the mounted tree, complicating the session-binding ladder before Feature 2's summary-based recreation ships.
5. **Scan limit ceiling:** Virtual `glob` / `grep` enforce `FILE_SYSTEM_SCAN_LIMIT`, whereas `BareRepoReader` delegates `git grep` directly against packfiles.

---

## Recommendation: Defer

**Recommendation: Defer** adopting `local.fs` grounding for launch.

- Keep on-disk scratch/checkout workspaces (`local.cwd`) plus `BareRepoReader` native read tools and `cursorSdkAdapter.prewarm(...)` for the shared chat harness launch.
- Revisit `local.fs` only as an isolated optimization for pure scratch, zero-shell, non-subagent turns if post-launch telemetry shows workspace preparation exceeding the 8 s P95 cold-turn target after `prewarm` is wired in Feature 2.
- Guard test `src/server/__tests__/localFsGroundingGuard.test.ts` enforces that zero production files under `src/` reference `local.fs` grounding.
