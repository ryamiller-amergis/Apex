# QA Lab: Ask Apex reviews before it changes

Ask Apex in QA Lab knows the whole of QA Lab for the project, and every change it suggests waits for QA to confirm it. The chat shows each change as the old and new text of the case, field by field, with Confirm and Discard.

## What the chat knows

The chat's context (`qaLabAssistantService.ts`, written to `.ai-pilot/kickoff-context.md` when the chat opens) holds:

- the open work item in full: every case, its open comments, whether it is published and where, its latest run (outcome, steps passed and failed, Bugs), and any changes waiting for review;
- every other work item in the project's QA Lab, as one line each: type, id, title, case count, published count, suite id. Only the latest ready suite per work item is listed, up to 200;
- how QA Lab works: generate, review, comment, regenerate, test, file Bugs, publish.

The chat can read any listed suite with `qa_lab_get_cases` and `qa_lab_list_suites`. It can only touch suites in the same project as the chat.

## Proposals

The MCP tools that change a suite (`qa_lab_update_case`, `qa_lab_add_case`, `qa_lab_delete_case`, `qa_lab_comment_case`, `qa_lab_regenerate_case`) no longer change it. Each saves a row in `qa_lab_assistant_proposals` with the case before and after, an optional reason, and status `pending`, then tells the chat the change is waiting for review.

The tools check what they can up front, so the chat hears about a bad change at once: published cases cannot be edited or deleted, unknown cases are refused, and a regenerate needs an open comment or a pending comment proposal.

A new edit, delete or regenerate for a case replaces any earlier pending one of those kinds for the same case, so QA reviews only the latest idea. Comments and new cases do not replace each other.

## Review in the chat

Change cards sit above the composer (`QaLabAssistantProposals.tsx`). An edit shows before and after; a new case shows the whole case as added; a delete shows the whole case as removed; a comment shows its text; a regenerate explains what it will do. Confirm all and Discard all appear when more than one change is waiting. Confirm waits until the assistant has finished its turn.

Confirm applies the change through the same functions QA Lab uses when QA edits by hand, as the signed-in user. Comments are written as "Ask Apex". Confirm all applies changes in the order they were proposed, so a comment lands before the regenerate that relies on it.

If the case changed after the proposal (QA edited it, or a regenerate rewrote it), Confirm does not overwrite it. The card shows the error and QA can dismiss it or ask the chat again. Any other failure is shown on the card the same way.

## API

All under `/api/interviews/qa-lab/assistant-threads/:threadId/proposals`, with `interviews:manage`, and only for the user's own QA Lab chat:

- `GET` lists pending and failed proposals;
- `POST /:proposalId/confirm`, `POST /:proposalId/discard`;
- `POST /confirm-all`, `POST /discard-all`.

## Tests

- `qaLabAssistantService.test.ts`: the context lists runs, Bugs, other work items and how QA Lab works; apply functions keep ids and refuse published cases.
- `qaLabAssistantProposalService.test.ts`: proposals change nothing until confirmed, stale cases are not overwritten, another user's chat is refused, Confirm all keeps order.
- `QaLabAssistantProposals.test.tsx`: old and new text, Confirm and Discard, Confirm all, failed cards.
