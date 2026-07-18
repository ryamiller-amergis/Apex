# E2E Test Quarantine Policy

## What is a quarantined test?

A quarantined test is one that has been temporarily marked with `test.fixme()` or `test.skip()` because it is failing and cannot be fixed immediately. Quarantining is a last resort — not a routine practice.

A test may be quarantined when:
1. It fails consistently (not a transient infrastructure issue) and fixing it would take more than one business day.
2. It fails nondeterministically (true flake) at a rate above 10% across 10+ runs.
3. The underlying product behavior it tests has changed intentionally and the test needs to be updated.

## How to quarantine

1. Add `test.fixme(true, 'QUARANTINE-<issue-number>: <one-line reason>')` or `test.skip(true, 'QUARANTINE-<issue-number>: <one-line reason>')` to the test.
2. Create or link an Azure DevOps work item (Bug or TBI) to track the fix.
3. Add an entry to the register below within the same PR.
4. Notify the QA lead in the PR description.

**Example:**

```typescript
test.fixme(
  true,
  'QUARANTINE-12345: PRD approve button selector changed after MUI upgrade — selector needs updating',
);
test('approved PRD shows confirm panel', async ({ page }) => {
  // ...
});
```

## Maximum quarantine age

**14 calendar days.** If a test is not fixed or deliberately removed within 14 days of quarantine:
- The QA lead escalates to engineering leadership.
- The test is removed from the suite if no fix plan exists.

A removed test must be logged in this register with `Removed` status.

## Register

| Test name | Spec file | Issue | Reason | Quarantined date | Owner | Status |
|-----------|-----------|-------|--------|-----------------|-------|--------|
| *(none)* | | | | | | |

## Flake SLO

A test is considered a flake candidate when it fails and then passes on retry more than **3 times in 7 days** with no code change. Flake candidates are reviewed weekly and classified as:
- **True flake** (quarantine + fix within 14 days): timing dependency or uncontrolled shared state.
- **Infrastructure issue** (no quarantine): CI runner instability, rate limits, DB provisioning lag.
- **Hidden product bug** (Bug work item): flake exposes real edge-case defect.

## Quarantine budget

**≤ 2% of total tests** may be in quarantine at any time. If the budget is exceeded, no new tests may be merged until the quarantine count falls below threshold.

Current count: 0 / ~40 test cases (0%)

## Metrics reviewed weekly

- Total quarantined tests and age
- Flake rate per spec file (fail-then-pass-on-retry %)
- Smoke suite reliability (target ≥ 99%)
- PR E2E duration trend
- WCAG critical/serious violation count

These metrics are reviewed in the weekly QA sync and tracked in the team's quality dashboard.
