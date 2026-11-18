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

- `up-to-date`: the case's title and steps copy the existing case.
- `needs-update`: title and steps are the suggested version.

Apex's prompt states only this contract. When each status applies, case limits, and format rules belong to the project's skill. MatterWorx keeps them in QA's own files: its `create-test-case` project notes point at `qa-automation/.github/skills/testing/apex-qa-lab.md` and `ado-manual-test-cases.md`, so QA changes them without an Apex PR.

The foundation `create-test-case` skill and schema add `existing` (shipped in foundation 2.2.0).

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

### Existing cases in no Test Plan

Removing a case from a static suite in Azure DevOps leaves the Test Case and its Tested By link, so the agent still finds it and marks it existing. Without this step it would never return to a suite.

- At sync, Apex asks Azure DevOps which suites each flagged case is in (`getSuitesByTestCaseId`) and stores `existing.inTestPlan`. If that read fails, the field stays unset and the case is treated as placed.
- A case with `inTestPlan: false` shows *Existing · Not in a Test Plan*, and appears in the publish window like a new case, with the skill's proposed plan and suite.
- Publishing it adds the existing Test Case to the chosen suite and creates nothing. It is saved with `action: "placed"`. A needs-update case with the update ticked is updated, then placed.
- A deleted Test Case is not returned by Azure DevOps, so its flag is dropped at sync and the case is new, as before.

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
- In no Test Plan: sync stores `inTestPlan`; publish adds the existing case to the chosen suite without creating one and records `action: "placed"`; the publish window lists it.

## Out of scope

- Fuzzy matching in Apex itself; the agent decides what counts as the same scenario.
- Moving existing cases between suites. A case in no suite can be placed; one already in a suite is not moved.
- Creating Test Plans or suites (separate design).
