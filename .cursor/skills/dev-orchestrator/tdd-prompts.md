# TDD prompts (Feature Executor Phase F4)

Read this file immediately before dispatching execution-wave subagents. Paste the matching blocks into each execution-bundle prompt.

## Subagent execution-bundle template

```
## Execution Bundle: <bundle id> — <task ids>

### Goal
<1-2 sentences describing the bundle deliverable>

### Tech-spec tasks
<For every task: ID, goal verbatim, blockers, owning item IDs, criteria/VT mappings, verification-owner rows, and expected files>

### Full owning-item contracts (from backlog — paste verbatim fields)
<For every owning PBI: userStory, businessRules, NFRs, outOfScope, and EVERY acceptanceCriteria entry relevant to or constrained by this bundle as AC-N: Given/When/Then>
<For every owning TBI: description, technicalDependencies, NFRs, and EVERY definitionOfDone entry relevant to or constrained by this bundle as DoD-N: …>
<Include the complete item contract when the bundle is its final implementation task; never omit sibling criteria that constrain the implementation>

### Design-spec anchors (excerpts — do not paraphrase away constraints)
From {feature-slug}-tech-spec.md:
<relevant sections: data model, API, modules, errors, flag behavior>
From {feature-slug}-design.md:   (required for PBIs; include for TBIs when UI-adjacent)
<relevant UX flows, states, a11y>
From {feature-slug}-assumptions.md:
<assumptions that constrain this item>

### Requirements → Test Matrix rows for this bundle
<table rows enabled or verification-owned by these tasks; label each row as enabling-only or verification-owner>

### Files to create or edit
<explicit list — no others unless unavoidable; align with tech-spec module/file guidance>

### Verification targets (from test-cases.json)
<the test cases whose traceability.pbiId maps to an owning item, by id + acceptanceCriteriaIndex>
<e2e-playwright: AUTHOR the Playwright spec; DEFER execution only when Playwright env is unavailable>
<Reminder: backlog AC/DoD remain authoritative even when a TC execution is deferred>

### Constraints
- Follow all rules in the Context Block below
- Load the skills listed in the Context Block before writing code
- Implement ONLY behavior justified by the work-item contract + design-spec anchors above
- Do NOT modify protected files without user approval
- Do NOT run `git commit` or `git push`
- If feature-flag gating applies: load `feature-flags`; use a top-level split at the entry route/component with the agreed key; keep the disabled branch functional; add its exact balanced `@feature-flag:<key>` start/end and enabled/disabled branch markers so `feature-flag-cleanup` can retire it deterministically
- UI: every interactive element in a staged client TSX file MUST have data-testid via spread `{...{ 'data-testid': 'kebab-id' }}` (not `data-testid="…"`; match design.md; whole-file scan). Source of truth: `scripts/check-data-testid.mjs` (includes `form`, `*Panel`, and the full PascalCase suffix list — do not use a shortened list). After GREEN, run `node scripts/check-data-testid.mjs` (stage touched client TSX first) and fix until exit 0. Also clear ESLint **errors** on touched files (`cross-env ESLINT_USE_FLAT_CONFIG=false npx eslint <files>`). Hook failures → /resolve-pre-commit-data-testid or /resolve-pre-commit-eslint.

### TDD Instructions (see below)
<paste the TDD block for every layer touched by this bundle>
<also paste the AC/DoD binding rules below>

### Cross-task and cross-item contracts
<interfaces / types / signatures produced by completed predecessor tasks>
<relevant sibling PBI/TBI fields and item-completion constraints>

<paste the Context Block from Phase F1>
```

In item fallback mode, use one item as the bundle and omit only the inapplicable multi-task labels.

## AC/DoD binding rules (paste into every execution-bundle prompt)

```
AC/DoD binding (mandatory):

- RED tests MUST encode the Given/When/Then (PBI) or DoD bullet (TBI) as assertions — one focused test (or describe block) per verification-owner matrix row for this bundle.
- Name or document each test with its criterion id (e.g. `AC-0`, `DoD-2`, or `TC-PBI-001-001`) so traceability is greppable.
- GREEN implementation must make those assertions pass without weakening the Then/DoD.
- Do not mark an AC/DoD done because a vaguely related test passes — the assertion must match the criterion.
- Prefer design-spec details (status codes, field names, UI states) when the AC is abstract.
- Enabling-only tasks must run their assigned deterministic check but leave the criterion `enabled`; only its verification owner may mark it `covered`.
- Re-run the bundle's tests/checks after GREEN and confirm every owned matrix row is covered and every enabling row is reported accurately.
```

## Server task TDD block

```
TDD — Red to Green:

1. RED: Write src/server/__tests__/<module>.test.ts first.
   - Derive cases from this bundle's verification-owner matrix rows (AC-*/DoD-*/BR/NFR/VT-*) BEFORE writing implementation
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
   - Derive cases from this bundle's verification-owner matrix rows (AC-*/linked TCs) BEFORE writing implementation
   - Use @testing-library/react + jest-environment-jsdom
   - Mock fetch and external hooks; use MSW or inline jest.fn() mocks
   - Use AAA pattern; test user-visible behavior matching Given/When/Then, not implementation details
   - Align UI assertions with {feature-slug}-design.md states/labels where specified
   - Prefer querying by data-testid from the design-spec list (getByTestId) for interactive controls
   - Run: npm test -- <testfile> — confirm tests FAIL before writing implementation

2. GREEN: Write the implementation.
   - data-testid policy (pre-commit enforced): every interactive UI element in a staged client TSX file MUST have a stable kebab-case id via spread syntax
     `{...{ 'data-testid': 'test-id-example' }}` (whole-file scan — not only new lines). Never write kebab-case JSX attrs `data-testid="…"` / `data-testid={…}`.
     Source of truth: scripts/check-data-testid.mjs — mark ALL of:
       • tags: a, button, dialog, form, input, select, textarea
       • handler props: onClick, onSubmit, onChange, onKeyDown, onKeyUp, onPointerDown, onDoubleClick
       • PascalCase suffixes: Button, Modal, Dialog, Drawer, Input, Select, Checkbox, Toggle, Switch, Tab,
         Menu, MenuItem, Dropdown, Popover, Tooltip, Form, Field, Panel, Card, Banner, Badge, Chip, Fab, Link, NavItem
     Common agent misses: <form>, *Panel, *Card, *Field, and the parent mount site for a new interactive component.
     Match ids listed in {feature-slug}-design.md when present.
   - Dynamic: `{...{ 'data-testid': \`work-item-${id}\` }}`. Walkthrough: `{...anchorTestIdProps('registry-key')}`.
   - When extending an existing screen, add missing ids AND convert any legacy `data-testid="…"` / `data-testid={…}` on interactive controls in that file to spread form.
   - Screen / landmark roots (page container, primary panel, empty/error states used by E2E) also need the spread form.
   - Do not rely on CSS class or text selectors for new E2E/unit queries when a test id exists.
   - Img alt: do not use redundant words like "image"/"photo"/"picture" in alt (jsx-a11y/img-redundant-alt is an ESLint error).
   - Run: npm test -- <testfile> — confirm all tests PASS
   - Verify pre-commit gates before claiming done:
       git add -- <touched-client-tsx>
       node scripts/check-data-testid.mjs
       cross-env ESLINT_USE_FLAT_CONFIG=false npx eslint --max-warnings=-1 <touched-ts-tsx>
     Fix data-testid violations and ESLint **errors**; do not boil the ocean on unrelated pre-existing warnings.
     Hook recovery: /resolve-pre-commit-data-testid or /resolve-pre-commit-eslint.

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
