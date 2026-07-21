---
name: daily-standup
description: APEX adapter for daily-standup. Binds to APEX's standup service, SSE delivery, and project settings.
---

# daily-standup — APEX Adapter

<!-- Managed loader: loads .apex/foundation/daily-standup/SKILL.md -->

- Project: {{slot:projectName}}
- Service: `src/server/services/standupService.ts`, `standupScheduler.ts`
- Delivery: SSE via `src/server/services/aiCompletionNotifier.ts`
- Components: `StandupCeremonyView.tsx`, `StandupManageView.tsx`, `StandupSummaryView.tsx`
- Output: stored via standup service; summary posted to project notification channel
