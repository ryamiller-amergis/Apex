# ATS agent board

The board proposes a Phase 1 ATS. Leadership ratifies it. Until that gate is approved, the synopsis is not a requirement and cannot become PRD input.

## What shipped

A linear Playbook template, `ats-agent-board`, installed as an unpublished draft. A Project Admin publishes it. Someone with `playbooks:run` starts it from the playbook dashboard by filling a charter.

The graph is fifteen steps and counts as ten agent steps under the existing caps. Template version
7 keeps the seven specialists on `repository-public-web-read-only` (repository reads plus the
project **Interview web MCP**). Moderator, chair, the revision pass, and deliberation internals stay
`repository-read-only`. Role members receive only `${input.charter}` plus bounded public research.
A durable
`board-deliberation` step validates every reported role, selects at most three material disputes,
and runs one structured round before the chair writes the synopsis. Leadership then reviews the
selected chair and deliberation items, and one revision agent applies those notes. The first step is an
approval gate that authorizes public research. Ratification remains the final human decision. A reusable
`capture-outcome-feedback` step then stores that decision, the feedback choices, and the selected AI
steps. It does not store prompts or change a skill.

Each role writes `.ai-pilot/output/review-scorecard.json` and `.ai-pilot/output/review-scorecard.md`. The synopsis panel reads the chair's `scorecard` or a fenced JSON block in `reportMd`. The panel is on the live run page and on the expanded run in the playbook list, so it is visible when the canvas flag is off.

The charter form removes emails, phone numbers, prices, and identifiers before the run starts. The start route does the same. Naming Aya or eRecruit requires the authorization checkbox, on the form and again on the server.

A ratification note is stored on the approval-gate output. The decision values stay `approved` and `rejected`. The board gate button says Ratify.

`formatAtsBoardTranscript` throws unless leadership approved. The copy button appears only then. Paste that transcript into `.ai-pilot/kickoff-transcript.md` before `/to-prd`.

## Decision states

The stored package status stays `Board approved — awaiting leadership` until the ratify gate.
The UI labels that state **Board recommendation — awaiting leadership ratification**. A single
decision may be that status, `Open — insufficient evidence`, or `Blocked — violates charter`. A
one-source claim is not a decided fact. Compliance and data migration stay open or blocked when that
member's report is missing or objects. The chair does not ratify.

Specialists may return `recommendationType` `insufficient_evidence` with checklist results,
`missingInputs`, and an evidence register with stable IDs. Public web findings are not Amergis
facts.

## Deliberation and audit

Deliberation sessions and turns are stored against the Playbook step run. The moderator creates an
agenda, affected specialists respond, and a rebuttal round runs only when a challenge or new
evidence exists. The inquiry budget reserves a final synthesis turn. A failed or invalid turn
parks the step as retryable; reconciliation recovers missed terminal events.

The moderator audits evidence in agenda and synthesis JSON: evidence gaps, single-source claims,
charter conflicts, cited evidence IDs, unsupported claims, and an evidence audit table. The audit
API returns only allow-listed structured fields from those shapes. Prompts, workspace prose, and
chain-of-thought are not returned.

The executive package is schema version 4 when the chair uses the current skill. It adds a focused
`leadershipBrief` (`headline`, 1–5 `aiDecisions`, 1–3 `expectedOutcomes`, and 0–3
`materialExceptions` restricted to `charter_change`, `legal_compliance`, `real_pii`,
`production_cutover`, `material_spend`, or `external_commitment`) while retaining the full V3
readiness, evidence register, cross-cutting lenses, domain decision ledger, and deliberation record
under the collapsible supporting-detail section. Earlier runs on schema versions 1–3 continue to
render unchanged.

On schema version 4 runs, the ratification gate offers one primary **Approve AI plan** action
(prefilled with the AI board's recommended exception resolutions), **Send back**, and an optional
**Override** editor so leadership only intervenes when overriding a material exception. Once the
chair completes, the 12-step agent execution list collapses behind **View agent activity**.

Configure **Interview web MCP** (and enable interview web research) in project skill settings before
publishing template version 4. Specialist steps fail retryably when that MCP is missing.

## Learning record

After ratification, the generic learning step records whether leadership approved or sent the
synopsis back, the optional overall note, the item choices from the feedback review, and provenance
for the chair, deliberation, and revision steps that actually finished. Later review can use those
outcomes to propose skill changes. A person still reviews, tests, and publishes any skill update.
One response does not rewrite a skill.

## Still deferred

Parallel graph fan-out, joins, and repeated revision loops remain out of scope. Leadership can
review selected AI items once, then ratify or reject the revised synopsis. Skill updates are
not applied automatically from captured outcomes.
