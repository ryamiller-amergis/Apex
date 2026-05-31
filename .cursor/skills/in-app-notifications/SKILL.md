# In-App Notifications Skill

Send persistent, real-time notifications to users from any server-side service.

## Sending a notification

```typescript
import { createNotification } from '../services/notificationService';

await createNotification(userId, {
  type: 'ai',            // 'system' | 'ai' | 'user-action' | 'background'
  title: 'PRD review complete',
  body: 'Your PRD "User Auth Flow" has been reviewed.',  // optional
  link: '/backlog/prd/abc-123',                           // optional deep-link
});
```

The service automatically:
1. Inserts a row in the `notifications` table
2. Checks the user's `notification_preferences` for the given type
3. Pushes the notification to all active SSE connections for that user (if `enabled` is true)
4. Sets the `toast` flag based on the user's `toast_enabled` preference

## Notification types

| Type | Use for |
|------|---------|
| `system` | Deployments, builds, releases, infrastructure events |
| `ai` | Design doc reviews, PRD reviews, AI interview completions |
| `user-action` | Mentions, assignments, approvals, status changes by a person |
| `background` | Long-running job completions, background task status updates |

## How SSE delivery works

- The client opens an `EventSource` to `GET /api/notifications/stream` on mount
- The server holds the connection in an in-memory `Map<string, Set<Response>>`
- When `createNotification` is called, the service writes an SSE event to all active connections for that user
- The `NotificationContext` on the client receives the event, increments the unread count, and optionally shows a toast popup

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/notifications` | Paginated list (`?limit=20&offset=0`) |
| `GET` | `/api/notifications/stream` | SSE stream |
| `PATCH` | `/api/notifications/:id/read` | Mark single as read |
| `PATCH` | `/api/notifications/read-all` | Mark all as read |
| `GET` | `/api/notifications/unread-count` | Returns `{ count }` |
| `GET` | `/api/notifications/preferences` | User preference list |
| `PATCH` | `/api/notifications/preferences` | Upsert a preference |

## Client components

| Component | Purpose |
|-----------|---------|
| `NotificationBell` | Bell icon with unread badge, toggles NotificationCenter |
| `NotificationCenter` | Dropdown panel listing notifications grouped by date |
| `ToastContainer` | Fixed bottom-right toast popup stack (max 3, auto-dismiss 5s) |
| `NotificationPreferences` | Toggle panel for per-type enabled/toast settings |
| `NotificationProvider` | Context providing `unreadCount`, `toasts`, `dismissToast`, `isConnected` |

## Client hooks

| Hook | Purpose |
|------|---------|
| `useNotifications(opts?)` | Paginated notification list query |
| `useUnreadCount()` | Unread count query |
| `useMarkAsRead()` | Mutation to mark single notification read |
| `useMarkAllAsRead()` | Mutation to mark all read |
| `useNotificationPreferences()` | Query for user preferences |
| `useUpdateNotificationPreference()` | Mutation to upsert a preference |

## RBAC

The notification UI is gated behind the `notifications:view` permission, assigned to `admin` and `member` roles by default.
