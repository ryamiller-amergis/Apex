---
name: Document-Scoped Thread Read Access
overview: Allow read access to interview/PRD/design-doc linked chat threads for users with interviews:view, while keeping write owner-only (with assistant-thread exceptions for approvers).
todos:
  - id: phase-1-access-service
    content: "Phase 1: Add threadAccessService + requireThreadRead/Write in chat.ts; server tests"
    status: completed
  - id: phase-2-assistant-route
    content: "Phase 2: Harden POST design-docs/:id/assistant-thread so viewers cannot overwrite doc_assistant_thread_id"
    status: completed
  - id: phase-3-interview-ui
    content: "Phase 3: InterviewChatView read-only viewer UI + seed messages from useChatThread"
    status: completed
  - id: phase-4-designdoc-ui
    content: "Phase 4: DesignDocReviewView Q&A/assistant send gating aligned with server write rules"
    status: completed
  - id: phase-5-design-doc
    content: "Phase 5: Write design-docs/document-scoped-thread-read-access.md and run full verification gate"
    status: completed
isProject: false
---

# Document-Scoped Thread Read Access

## Problem

PRD and design-doc **markdown** was already readable via `interviews:view`, but **chat transcripts** loaded through `GET /api/chat/threads/:id` were owner-only. Non-author viewers saw empty conversations because `requireThreadOwner` returned 404.

## Solution

### Server

- **`threadAccessService.ts`** — centralizes `resolveThreadAccess`, `canWriteThread`, and `canCreateDesignDocAssistantThread`.
- **`chat.ts`** — `requireThreadRead` for GET/stream/prd/backlog; `requireThreadWrite` for POST/PUT/PATCH/DELETE. Unauthorized access returns **404** (no existence leak).
- **`interviews.ts`** — `POST /design-docs/:id/assistant-thread` only creates or replaces `doc_assistant_thread_id` for author/admin; viewers reuse the existing thread id.

### Client

- **`InterviewChatView`** — read-only banner and locked compose for non-author viewers; seeds `useChatStream` from `useChatThread`.
- **`DesignDocReviewView`** — Q&A send gated by `canEdit`; assistant panel respects `docAssistantThreadId`, skips auto-create for viewers, read-only send for users without write.

## Access matrix

| Actor | Interview / PRD / design-doc threads (read) | Write messages |
|-------|---------------------------------------------|----------------|
| `interviews:view` viewer | Yes (when linked) | No (except assistant: approver/admin) |
| Author | Yes | Yes (own threads) |
| Assigned approver | Yes | Assistant thread only |
| `chat:view_all` | Yes (any thread) | Per write rules |

Content edit remains **author + admin** only (unchanged).

## Tests

- `src/server/__tests__/threadAccessService.test.ts`
- `src/server/__tests__/chatThreadReadAccess.test.ts`
- `src/server/__tests__/designDocAssistantThread.test.ts` (create permission)
- `src/client/components/__tests__/InterviewChatView.ExistingInterview.test.tsx` (read-only viewer)
