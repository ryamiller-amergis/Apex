---
name: feature-flags
description: Wrap existing features with feature flags (top-level split pattern) and clean up retired flags. Use when the user mentions feature flags, gating, rollout, flag cleanup, or retiring a flag.
---

# Feature Flags — Foundation

## When to use a feature flag

Add a flag when: the feature is risky enough to warrant gradual rollout, it needs A/B testing, it will be deployed before it's complete, or it has dependencies on external systems not yet ready.

Do NOT add a flag for: every minor change, pure refactors, bug fixes that must ship immediately.

## Top-level split pattern

The safest pattern: one flag check at the highest relevant component/route, not scattered throughout the code.

```typescript
// Good — single entry point check
if (!featureEnabled('my-feature', { userId, project })) {
  return <OldComponent />;
}
return <NewComponent />;

// Avoid — scattered throughout
function Form() {
  const label = featureEnabled(...) ? 'New label' : 'Old label';
  const handler = featureEnabled(...) ? newHandler : oldHandler;
  // ...
}
```

## Flag lifecycle

1. **Draft** — flag created, default off, not targeting anyone
2. **Active** — targeting specific users/projects for rollout
3. **General availability** — targeting everyone
4. **Retired** — flag removed from code and DB after cleanup window

## Adding a flag

1. Check if the project adapter defines a specific flag service API.
2. Create the flag in the project's flag management system.
3. Wrap the feature at the top-level entry point.
4. Document the flag in the project's flag registry.

## Cleaning up a flag

1. Confirm the feature has been in general availability for the cleanup window.
2. Remove all flag checks from code (keep the "on" path, remove the "off" path).
3. Remove the flag from the project's flag management system.
4. Update documentation.
