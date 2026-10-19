# ATS agent board runbook

## Start

1. Open Playbooks and choose ATS agent board. That installs an unpublished draft. A second click opens the draft that is already there. If it was already published, open that playbook from the list instead.
2. A person with `playbooks:author` publishes the draft.
3. Open that playbook and choose Start board review.
4. Fill the charter. Check the authorization box if the charter names Aya or eRecruit.
5. Approve the first gate, "Authorize public research and a Phase 1 proposal".

You can leave. The run keeps its place in Apex's playbook tables.

After the independent reports, the board validates that each agent returned its assigned role. A
role mismatch or invalid structured response stops the deliberation step and makes it retryable.
Do not ratify a package produced from mismatched roles.

## Return

When the chair finishes, you get a notification titled "ATS board synopsis is ready". The link opens the run list. Expand the run, or open the live canvas if that flag is on.

The synopsis shows the decisions requested, recommendation, outcomes, Phase 1 and deferred scope,
options and trade-offs, evidence quality, dissent, risks, assumptions, unresolved items, Day-1
cutover, and the Amergis separation impact. Expand **Board discussion audit** to review the
structured agenda, specialist positions, challenges, and revisions. It reads
"Board approved — awaiting leadership" until you decide the last gate.

## Ratify

On "Ratify the ATS board synopsis", add a note if you want one, then Ratify or Reject. The note stays on the gate.

After you ratify, the synopsis shows a requirements transcript. Copy it into `.ai-pilot/kickoff-transcript.md` and then run `/to-prd`. A package that is still awaiting leadership is not a requirement.

## If a member fails

A blank report leaves that domain open. Compliance and data migration are not settled when those reports are missing. Reject the synopsis, or ratify only the parts the note names, and start another run with a tighter charter.

If a deliberation turn fails, retry the current step. The persisted session resumes the failed
turn; completed turns are not repeated. A run expires after the deliberation deadline rather than
waiting indefinitely.
