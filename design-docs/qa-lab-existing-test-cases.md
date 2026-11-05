# QA Lab: flag test cases that already exist

## Problem

QA Lab generates cases for a PBI without looking at Azure DevOps. When the PBI already has Test Cases, or the module suite already covers the scenario, QA gets duplicates. This happens on regeneration, when QA wrote cases by hand, and when a new PBI changes behavior an existing suite covers. Test Plans are long-lived modules, so the last case is common.

## Outcome

For each scenario the agent would write, it first checks what Azure DevOps already has:

- **Existing, up to date**: the case already covers the scenario as the work item now describes it. QA Lab shows it tagged *Existing* with its ADO id, a one-line reason, and no suggested change. It is never published as a new case.
- **Existing, needs update**: a case covers the scenario but no longer matches the work item. QA Lab shows it tagged *Existing · Needs update* with the reason, the current ADO steps, and the suggested steps as a diff. On publish, QA can choose to apply the suggestion to that existing ADO case. Nothing is written until QA chooses it.
- **New**: no existing case covers it. Unchanged from today.

## Where Apex looks

1. **Linked cases**: Test Cases linked to each target PBI by Tested By. Apex fetches title, steps, and state before the run.
2. **Suite cases**: every case in the project's static suites, titles only, with ADO id and suite path. The agent picks the suite during the run, so it gets the whole index and compares against the suite it chose. Apex fetches full steps afterwards only for suite cases the agent flags.

## Design

### Azure DevOps reads (`azureDevOps.ts`)

- `listLinkedTestCases(workItemIds)`: reads each PBI's relations, keeps `Microsoft.VSTS.Common.TestedBy-Forward` targets, batch-fetches `System.Title`, `System.State`, `Microsoft.VSTS.TCM.Steps`. Steps XML is parsed into `{ action, expected }`.
- `listSuiteCaseIndex(plans)`: for each static suite already returned by `listStaticTestPlanSuites`, `getTestCaseList` gives case id and title. Bounded at 5,000 entries; past that the index is cut and the kickoff says so.
- `getTestCasesById(ids)`: full title and steps for flagged suite cases.

### Generation inputs (`adoTestCaseSuiteService.ts`)

`startAdoTestSuite` writes two files next to `test-plans.md`:

- `.ai-pilot/existing-test-cases.json`: linked cases per PBI, full steps.
- `.ai-pilot/test-case-index.md`: one line per suite case, `{adoId} | {suite path} | {title}`, grouped by plan.

Both are added to the `test-cases` scratch-input allow-list (`aiRunV2DocumentSpec.ts`, `readDocumentScratchInputs`) so the V2 worker receives them. The kickoff gains an `## Existing test cases` section that names the files and the rule below. If either read fails, generation still runs; the kickoff says existing cases were not checked and the agent adds a coverage gap "Existing cases not checked".

### Agent output (skill and schema)

Each case may carry:

```json
"existing": {
  "adoTestCaseId": 61234,
  "status": "up-to-date" | "needs-update",
  "reason": "Same approve flow; acceptance criterion 3 now requires a comment",
  "source": "linked" | "suite"
}
```

- `up-to-date`: the case's title and steps copy the existing case; it does not count toward the per-PBI case limit.
- `needs-update`: title and steps are the suggested version; it counts toward the limit.
- The agent writes a new case only when no linked or suite case covers the scenario.

The foundation `create-test-case` skill and schema add `existing` (shipped in foundation 2.2.0). MatterWorx gets the same in `## Project notes` and its schema now, as with `placement`.

### After the run

The sync step reads `existing` into `QaLabTestCase.existing`. For flagged suite cases, Apex calls `getTestCasesById` and stores the current title and steps on the suite row (`existingCases` in `test_cases_json` metadata), so the UI can show the diff without another ADO call. A flagged id that no longer exists in ADO turns the case back into a new case with a gap note.

### QA Lab UI

- Case card: *Existing* tag (links to the ADO case), status pill *Up to date* or *Needs update*, and the reason.
- Needs update: the open card shows current ADO steps versus suggested steps, reusing `QaLabCaseDiff`.
- Filter chips on the case list: All, New, Existing.

### Publish

- Up-to-date existing cases are left out of the publish window.
- Needs-update cases are listed separately as "Update existing #61234", unchecked by default.
- Applying an update patches `System.Title` and `Microsoft.VSTS.TCM.Steps` on that ADO case, and adds the Tested By link to the PBI if it is missing. It does not move the case to another suite. The result is saved in `publishedCases` with `action: "updated"`, so a retry does not apply it twice.

## Errors

- ADO reads fail: generate without existing-case context, with the gap above.
- Index over 5,000 entries: cut, with a kickoff note and a gap.
- Update rejected by ADO: listed as a publish failure for that case; other cases continue.

## Tests

- ADO reads: Tested By parsing, steps XML parsing, index cap.
- Scratch inputs: both files reach the V2 worker spec for `test-cases`.
- Sync: `existing` parsed; flagged suite case fetched and stored; missing ADO id falls back to new.
- Publish: up-to-date skipped; needs-update patches title and steps once, adds a missing Tested By link, records `action: "updated"`.
- UI: tag, status, reason, diff, filter chips, unchecked update rows.

## Out of scope

- Fuzzy matching in Apex itself; the agent decides what counts as the same scenario.
- Moving existing cases between suites.
- Creating Test Plans or suites (separate design).
