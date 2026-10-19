# ATS agent board

The board proposes a Phase 1 ATS. Leadership ratifies it. Until that gate is approved, the synopsis is not a requirement and cannot become PRD input.

## What shipped

A linear Playbook template, `ats-agent-board`, installed as an unpublished draft. A Project Admin publishes it. Someone with `playbooks:run` starts it from the playbook dashboard by filling a charter.

The graph is twelve steps and counts as nine agent steps under the existing caps. Every agent uses
`repository-read-only`. Role members receive only `${input.charter}`. A durable
`board-deliberation` step validates every reported role, selects at most five material disputes,
and runs at most two structured rounds before the chair writes the synopsis. The first step is an
approval gate that authorizes public research. The last step is the ratification gate.

Each role writes `.ai-pilot/output/review-scorecard.json` and `.ai-pilot/output/review-scorecard.md`. The synopsis panel reads the chair's `scorecard` or a fenced JSON block in `reportMd`. The panel is on the live run page and on the expanded run in the playbook list, so it is visible when the canvas flag is off.

The charter form removes emails, phone numbers, prices, and identifiers before the run starts. The start route does the same. Naming Aya or eRecruit requires the authorization checkbox, on the form and again on the server.

A ratification note is stored on the approval-gate output. The decision values stay `approved` and `rejected`. The board gate button says Ratify.

`formatAtsBoardTranscript` throws unless leadership approved. The copy button appears only then. Paste that transcript into `.ai-pilot/kickoff-transcript.md` before `/to-prd`.

## Decision states

The package stays `Board approved — awaiting leadership` until the ratify gate. A single decision may be that status, `Open — insufficient evidence`, or `Blocked — violates charter`. A one-source claim is not a decided fact. Compliance and data migration stay open or blocked when that member's report is missing or objects. The chair does not ratify.

## Deliberation and audit

Deliberation sessions and turns are stored against the Playbook step run. The moderator creates an
agenda, affected specialists respond, and a rebuttal round runs only when a challenge or new
evidence exists. The inquiry budget reserves a final synthesis turn. A failed or invalid turn
parks the step as retryable; reconciliation recovers missed terminal events.

The audit endpoint returns only allow-listed structured fields: role, topic, phase, position,
evidence, challenge, revision, confidence, status, and timestamps. Prompts, workspace prose, and
chain-of-thought are not returned.

The executive package is schema version 2. It adds decisions requested, recommendation, business
outcomes, options and trade-offs, leadership actions, evidence quality, and the deliberation
summary while continuing to read version 1 runs.

## Still deferred

Parallel graph fan-out and joins, vote tables, and leadership actions for amend, return, or
conditional approval remain out of scope. Leadership still ratifies or rejects.
