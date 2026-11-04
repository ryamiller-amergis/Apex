# QA Lab: create Test Plans and suites that don't exist yet

## Problem

When QA Lab generates cases for a new feature, the skill proposes a Test Plan and suite by name. If none fits, the publish window shows "(not found)" and QA has to leave Apex, create the plan or suite in Azure DevOps, and come back.

## Outcome

The skill proposes the missing plan or suite with a reason. QA reviews it in the publish window. Apex creates it in Azure DevOps on publish, then places the cases in it.

## How projects file cases

Each project's skill says which pattern it uses. MatterWorx uses two:

- **Module plans** (`15 Create, Save, Submit Timesheet`) with static suites (`Feature > Sub-feature`). Apex adds cases to a static suite explicitly.
- **Feature plans** (`Delete User - Functional Testing`) with one requirement suite per PBI (`40249 : Add Delete User Button`). A requirement suite shows every Test Case linked to its PBI by Tested By, so a case needs only that link.

For MatterWorx, a brand-new feature gets a `<Feature> - Functional Testing` plan with requirement suites. Work that fits an existing module keeps going to that module plan's static suite.

## Skill output

Top-level `newPlacements` in `{slug}.test-cases.json`:

```json
"newPlacements": [
  {
    "testPlan": "Delete User - Functional Testing",
    "createPlan": true,
    "suiteType": "requirement",
    "reason": "No plan covers Delete User; it is a new feature"
  },
  {
    "testPlan": "15 Create, Save, Submit Timesheet",
    "testSuite": "Geofence Clock In and Out > Outside Radius Warning",
    "createPlan": false,
    "suiteType": "static",
    "reason": "The timesheet module has no suite for the new radius warning"
  }
]
```

- Cases point at a proposal through their normal `placement.testPlan` / `placement.testSuite`. For a requirement suite, `testSuite` is the PBI's suite name `{id} : {title}`, or omitted and Apex derives it.
- The skill never proposes a plan or suite that is already in `.ai-pilot/test-plans.md`.

## What the skill sees

`.ai-pilot/test-plans.md` also lists requirement suites, marked `(requirement)`, so the agent can tell that a feature plan exists but has no suite for this PBI, and propose only that suite.

## Publish window

- A "Create in Azure DevOps" section lists each proposal: editable plan name, editable suite path (static only), type, and reason. Every row is unchecked by default.
- Cases that point at a proposal show "New: {plan} / {suite}" as their placement. While the proposal is unticked, they have no suite; when the project requires a suite, they cannot publish.
- Requirement suites in existing plans become selectable placements, so QA can choose one without a proposal.

## Creating on publish

For each ticked proposal, in order:

1. Look the plan up by name again (case-insensitive) and reuse it if it now exists. Do the same for each suite segment. A retry never creates a duplicate, and no database change is needed.
2. Create the plan. It copies the area path and iteration that most active plans in the project use (`MatterWorx` / `MatterWorx` for MatterWorx). Azure DevOps creates its root suite.
3. Static: create each missing suite along the path under the plan's root suite. Requirement: create a requirement suite for the PBI under the root suite.
4. Publish the cases. A case going to a static suite is added to it. A case going to a requirement suite needs only its Tested By link; Apex does not call add-to-suite for it.

Creation runs as the signed-in user, like publish.

## Errors

- A create fails (for example, no permission to create Test Plans): every case that depends on it fails with that message; other cases continue.
- A proposal's name collides with an existing plan or suite: Apex uses the existing one.
- The skill proposes a malformed entry: Apex ignores it when reading the suite, and its cases fall back to "(not found)".

## Out of scope

Editing or deleting plans, query-based suites, and choosing plan area or iteration by hand.

## Tests

- Reading the suite keeps valid `newPlacements` and drops malformed ones.
- `test-plans.md` lists requirement suites.
- Publish creates a plan, static suite path, or requirement suite once; a second publish reuses them.
- A requirement-suite case is linked and not added to the suite.
- A failed create fails only its cases.
- Publish window: proposals unchecked by default; ticking one lets its cases publish and sends it in the request.
