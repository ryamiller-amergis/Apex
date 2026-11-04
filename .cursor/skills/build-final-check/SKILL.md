---
name: build-final-check
description: Runs the final check, standards review, or accept sync on a build's integration branch and emits a structured report block.
disable-model-invocation: true
---

# Build Final Check and Standards Review

You verify the combined changes on a build's integration branch before deployment (mode `final-check`) or merge the default branch into the integration branch at accept time (mode `sync`).

## Mode: `final-check`

Follow these steps in order:

1. **Read the three standards files first**:
   - Open the frozen `designSystemFile`, `codingRules`, and `codeMap` paths supplied in the prompt.
   - If any of the three files cannot be read, stop immediately, make no changes, and report `standards: { "status": "unreadable_input", "path": "<unreadable file path>" }` in your `apex-final-check-report` block.
2. **Run the quality manifest checks on the integration branch**:
   - Run the **full unit suite** (`unit_full`).
   - Run the **related tests** for every file changed since the base commit (`unit_related`).
   - Run **type-check** (`type_check`) and **lint** (`lint`).
3. **Review the combined change against the standards contract and reuse list**:
   - Follow [standards-review.md](standards-review.md) for `duplicate_helper`, `hard_coded_colour`, `off_library_component`, and `missing_accessibility`.
4. **Repair policy**:
   - If a check fails and repair budget is left (`repairAttemptsLeft > 0`), fix the code on your branch and set `repairedInSession: true`.
   - Never delete, skip or weaken a test to pass.
   - If no repair budget is left (`repairAttemptsLeft === 0`), run in **report-only** mode and change nothing (`repairedInSession: false`).
   - Always **re-run** the checks after any fix so the reported outcomes reflect the final commit on your branch.
5. **Emit the `apex-final-check-report` block**:
   - End your final message with a fenced `apex-final-check-report` JSON block matching `schemaVersion: 1`.

```apex-final-check-report
{
  "schemaVersion": 1,
  "validatedCommit": "<40-char git head sha>",
  "repairedInSession": false,
  "checks": [
    { "kind": "unit_full", "outcome": "passed", "summary": "All unit tests passed" },
    { "kind": "unit_related", "outcome": "passed", "summary": "All related tests passed" },
    { "kind": "type_check", "outcome": "passed", "summary": "Type-check passed" },
    { "kind": "lint", "outcome": "passed", "summary": "Lint passed" }
  ],
  "standards": {
    "status": "reviewed",
    "findings": [],
    "reviewSeconds": 30
  },
  "summary": "All checks and standards review passed."
}
```
