---
name: in-app-notifications
description: Patterns for sending persistent real-time in-app notifications from server-side code. Use when adding notifications to a feature or integrating with the project's notification system.
---

# In-App Notifications — Foundation

Patterns for sending notifications to users from server-side code.

## Core pattern

The project adapter defines the exact API for this project's notification service. The generic pattern is:

1. Import the notification service.
2. Call `createNotification(userId, { type, title, body?, link? })` (or the project-equivalent).
3. The service stores the notification, delivers it in real time (SSE/WebSocket), and respects user preferences.

## Notification types

| Type | Use for |
|------|---------|
| `ai` | AI agent completion, generation results |
| `system` | Platform-level announcements |
| `user-action` | Actions triggered by other users |
| `background` | Background job completion |

## Rules

- Always include a `title` — it is the primary user-visible text.
- Include `body` for additional context; keep it under ~100 characters.
- Include `link` for navigable notifications; use a relative app path.
- Never send a notification from a route handler directly — use a service or background job.
- Respect user notification preferences by type.

## Delivery mechanics

The project adapter describes:
- The real-time delivery mechanism (SSE, WebSocket, polling)
- User preference storage
- Notification persistence schema
- The notification bell/center component
