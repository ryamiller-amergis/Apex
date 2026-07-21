---
name: feature-flags
description: APEX adapter for feature-flags. Binds to APEX's featureFlagService and flag evaluation hook.
---

# feature-flags — APEX Adapter

<!-- Managed loader: loads .apex/foundation/feature-flags/SKILL.md -->

- Project: {{slot:projectName}}
- Service: `src/server/services/featureFlagService.ts`
- Client hook: `src/client/hooks/useFeatureFlag.ts`
- Admin UI: `src/client/components/PlatformAdmin.tsx` → Feature Flags tab
- Flag names registry: `src/shared/types/featureFlags.ts` (or equivalent constants file)
