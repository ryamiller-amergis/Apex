# ATS agent board runbook

## Start

1. Open Playbooks and choose ATS agent board. That installs an unpublished draft. A second click opens the draft that is already there. If it was already published, open that playbook from the list instead.
2. A person with `playbooks:author` publishes the draft.
3. Open that playbook and choose Start board review.
4. Fill the charter. Check the authorization box if the charter names Aya or eRecruit.
5. Approve the first gate, "Authorize public research and a Phase 1 proposal".

Before publishing template version 4, set **Interview web MCP** in project skill settings (same MCP
used for discovery interviews). Without it, specialist steps stop with a human-retryable error.

You can leave. The run keeps its place in Apex's playbook tables.

After the independent reports, the board validates that each agent returned its assigned role. A
role mismatch or invalid structured response stops the deliberation step and makes it retryable.
Do not ratify a package produced from mismatched roles.

## Return

When the chair finishes, you get a notification titled "ATS board synopsis is ready". The link opens the run list. Expand the run, or open the live canvas if that flag is on.

The V4 synopsis leads with a concise AI-decided Phase 1 plan (`headline`, up to 5 `aiDecisions`,
up to 3 `expectedOutcomes`, and 0–3 `materialExceptions` with prefilled AI recommendations). Full
scope, options, evidence register, domain decisions, risks, assumptions, and the **Board discussion
audit** remain available inside **Supporting research and delivery detail**, and the completed step
list collapses behind **View agent activity**. The header reads **Board recommendation — awaiting
leadership ratification** until you decide the last gate.

## Ratify

On "Ratify the ATS board synopsis", click **Approve AI plan** to accept the AI plan and its
recommended exception resolutions in one action, click **Override** to change any material exception
resolution first, or click **Send back** with a note. Legacy V1–V3 runs continue to use the
step-by-step decision review and **Ratify** button.

After you ratify, the synopsis shows a requirements transcript. Copy it into `.ai-pilot/kickoff-transcript.md` and then run `/to-prd`. A package that is still awaiting leadership is not a requirement.

## If a member fails

A blank report leaves that domain open. Compliance and data migration are not settled when those reports are missing. Reject the synopsis, or ratify only the parts the note names, and start another run with a tighter charter.

If a deliberation turn fails, retry the current step. The persisted session resumes the failed
turn; completed turns are not repeated. A run expires after the deliberation deadline rather than
waiting indefinitely.
