# TDD prompts (Feature Executor Phase F4)

Read this file immediately before dispatching inner-wave subagents. Paste the matching blocks into each item prompt.

## Subagent task template

```
## Task: <item id> — <item title>

### Goal
<1-2 sentences: the deliverable for this PBI/TBI>

### Full work-item contract (from backlog — paste verbatim fields)
<For PBI: userStory, businessRules, NFRs, outOfScope, and EVERY acceptanceCriteria entry as AC-N: Given/When/Then>
<For TBI: description, technicalDependencies, NFRs, and EVERY definitionOfDone entry as DoD-N: …>

### Design-spec anchors (excerpts — do not paraphrase away constraints)
From {feature-slug}-tech-spec.md:
<relevant sections: data model, API, modules, errors, flag behavior>
From {feature-slug}-design.md:   (required for PBIs; include for TBIs when UI-adjacent)
<relevant UX flows, states, a11y>
From {feature-slug}-assumptions.md:
<assumptions that constrain this item>

### Requirements → Test Matrix rows for this item
<table rows for this item only — each AC/DoD must appear>

### Files to create or edit
<explicit list — no others unless unavoidable; align with tech-spec module/file guidance>

### Verification targets (from test-cases.json)
<the test cases whose traceability.pbiId maps to this item, by id + acceptanceCriteriaIndex>
<e2e-playwright: AUTHOR the Playwright spec; DEFER execution only when Playwright env is unavailable>
<Reminder: backlog AC/DoD remain authoritative even when a TC execution is deferred>

### Constraints
- Follow all rules in the Context Block below
- Load the skills listed in the Context Block before writing code
- Implement ONLY behavior justified by the work-item contract + design-spec anchors above
- Do NOT modify protected files without user approval
- Do NOT run `git commit` or `git push`
- If feature-flag gating applies: top-level split from `feature-flags` at the entry route/component with the agreed flag key; keep the disabled branch functional
- UI: every interactive element in a staged client TSX file MUST have data-testid via spread `{...{ 'data-testid': 'kebab-id' }}` (not `data-testid="…"`; match design.md; whole-file scan). When editing existing screens, add/convert ids on all interactive controls in that file. Pre-commit enforces this. Hook failures → /resolve-pre-commit-data-testid.

### TDD Instructions (see below)
<paste the TDD block matching this item's layer>
<also paste the AC/DoD binding rules below>

### Cross-item contracts
<interfaces / types / signatures this item must respect from earlier inner waves>
<relevant sibling PBI/TBI fields this item depends on>

<paste the Context Block from Phase F1>
```

## AC/DoD binding rules (paste into every item prompt)

```
AC/DoD binding (mandatory):

- RED tests MUST encode the Given/When/Then (PBI) or DoD bullet (TBI) as assertions — one focused test (or describe block) per matrix row for this item.
- Name or document each test with its criterion id (e.g. `AC-0`, `DoD-2`, or `TC-PBI-001-001`) so traceability is greppable.
- GREEN implementation must make those assertions pass without weakening the Then/DoD.
- Do not mark an AC/DoD done because a vaguely related test passes — the assertion must match the criterion.
- Prefer design-spec details (status codes, field names, UI states) when the AC is abstract.
- Re-run the item's tests after GREEN and confirm every matrix row for this item is covered.
```

## Server task TDD block

```
TDD — Red to Green:

1. RED: Write src/server/__tests__/<module>.test.ts first.
   - Derive cases from this item's matrix rows (AC-*/DoD-*/BR/NFR) BEFORE writing implementation
   - Mock the Drizzle db instance: jest.mock('../db/drizzle', () => ({ db: { ... } }))
   - Follow the mock shape in src/server/__tests__/rbacService.test.ts
   - Use AAA (Arrange / Act / Assert); test public API only
   - Arrange = Given / DoD precondition; Act = When / operation; Assert = Then / DoD outcome
   - Run: npm test -- <testfile> — confirm tests FAIL before writing implementation

2. GREEN: Write the implementation (minimum code to pass every matrix row).
   - Run: npm test -- <testfile> — confirm all tests PASS

3. REFACTOR: Clean up; re-run tests to confirm still green.

4. TYPE-CHECK: npx tsc -p tsconfig.server.json --noEmit — fix all errors.
```

## Client task TDD block

```
TDD — Red to Green:

1. RED: Write src/client/components/__tests__/<Component>.test.tsx
        or src/client/hooks/__tests__/<hook>.test.ts first.
   - Derive cases from this item's matrix rows (AC-*/linked TCs) BEFORE writing implementation
   - Use @testing-library/react + jest-environment-jsdom
   - Mock fetch and external hooks; use MSW or inline jest.fn() mocks
   - Use AAA pattern; test user-visible behavior matching Given/When/Then, not implementation details
   - Align UI assertions with {feature-slug}-design.md states/labels where specified
   - Prefer querying by data-testid from the design-spec list (getByTestId) for interactive controls
   - Run: npm test -- <testfile> — confirm tests FAIL before writing implementation

2. GREEN: Write the implementation.
   - data-testid policy (pre-commit enforced): every interactive UI element in a staged client TSX file MUST have a stable kebab-case id via spread syntax
     `{...{ 'data-testid': 'test-id-example' }}` (whole-file scan — not only new lines). Never write kebab-case JSX attrs `data-testid="…"` / `data-testid={…}`.
     Covers button, input, select, textarea, a, form, dialog; elements with onClick/onSubmit/onChange/etc.; UI components whose names end in
     Button/Modal/Dialog/Input/…. Match ids listed in {feature-slug}-design.md when present.
   - Dynamic: `{...{ 'data-testid': \`work-item-${id}\` }}`. Walkthrough: `{...anchorTestIdProps('registry-key')}`.
   - When extending an existing screen, add missing ids AND convert any legacy `data-testid="…"` / `data-testid={…}` on interactive controls in that file to spread form.
   - Screen / landmark roots (page container, primary panel, empty/error states used by E2E) also need the spread form.
   - Do not rely on CSS class or text selectors for new E2E/unit queries when a test id exists.
   - Hook failures: /resolve-pre-commit-data-testid (or /resolve-pre-commit-eslint for lint-staged).
   - Run: npm test -- <testfile> — confirm all tests PASS

3. REFACTOR: Clean up; re-run tests to confirm still green.

4. TYPE-CHECK: npx tsc -p tsconfig.client.json --noEmit — fix all errors.
```

## Shared-types task TDD block

```
TDD — Red to Green:

1. RED: Write tests that import and validate the new types/utilities.
   - Map each DoD/AC row that constrains the shared contract to a type or pure-function assertion
   - For pure functions, use standard Jest unit tests
   - Run: npm test -- <testfile> — confirm tests FAIL

2. GREEN: Implement the types and utilities.
   - Run: npm test -- <testfile> — confirm PASS

3. TYPE-CHECK (both configs):
   npx tsc -p tsconfig.server.json --noEmit
   npx tsc -p tsconfig.client.json --noEmit
```
