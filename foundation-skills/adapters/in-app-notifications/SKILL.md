---
name: in-app-notifications
description: APEX adapter for in-app-notifications. Binds to APEX's notification service, SSE delivery, and UI components.
---

# in-app-notifications — APEX Adapter

<!-- Managed loader: loads .apex/foundation/in-app-notifications/SKILL.md -->

- Project: {{slot:projectName}}
- Service: `src/server/services/notificationService.ts`, `aiCompletionNotifier.ts`
- Delivery: SSE (Server-Sent Events)
- UI: `NotificationBell.tsx`, `NotificationCenter.tsx`, `ToastContainer.tsx`
- Context: `src/client/contexts/NotificationContext.tsx`
