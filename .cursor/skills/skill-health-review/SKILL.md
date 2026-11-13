---
name: skill-health-review
description: >-
  Turns the Skill Health overview JSON (GET /api/platform-admin/skill-health) into a
  findings report grouped by project: symptom, evidence, likely cause (shared Skill vs
  that project), a proposed SKILL.md change, where to file it (Apex Backlog or the
  project's Azure DevOps), and how to verify it. Use when a Platform Admin asks to review
  Skill Health, explain why a Skill scores badly, or draft improvements to a PRD or
  design-doc Skill. Read-only: proposes changes, never edits a SKILL.md, files a work
  item, or publishes a release.
---

# skill-health-review

Reads Skill Health metrics and writes a findings report a Skill owner can act on. It proposes
changes; a person reviews and applies them.

## Input

One of:

- A saved overview JSON (the response of `GET /api/platform-admin/skill-health?days=30|90|180`).
- The user pasting that JSON into chat.

Shape: `SkillHealthOverview` in `src/shared/types/skillHealth.ts`. Read the `caveats` array first;
every limit listed there applies to the report.

The overview is grouped by `projects`. Each project's Skills live in its own `skillRepo`, so the
same `skillPath` in two projects is two different files. `isFoundation` marks the Apex project,
whose Skills are the foundation every other project's adapter is built from.

To propose a change, read the current `SKILL.md` at each finding's `skillPath` in that project's
`skillRepo`. For the foundation project that is this repo. If the path is null the project uses the
app default; say so and stop at the finding. If you cannot read another project's repo, say so and
label the proposed change "Likely".

## Procedure

Work one project at a time, foundation project first.

1. **Skip what cannot be judged.** List the project's Skills with `status: insufficient_data` once,
   with their document count, and write no findings for them.
2. **Rank the rest** by status (`poor`, then `fair`, then `good`), then by `documents`.
3. **For each ranked Skill, find at most three findings.** Candidate signals, strongest first:
   - `recurringGaps` with `documentCount >= 3`, or `>= 2` when the Skill has fewer than 20 documents.
   - `sections` that hold a large share of `reviewComments`.
   - `acceptanceRate` below 0.7 with `revisionRequested >= 2`.
   - `overrides > 0`: people are bypassing the gate. Either the Skill or the judge is wrong.
   - `costPerDocument` well above the other Skill of the same `artifactKind` in the same project.
4. **Locate the cause for each finding** by comparing projects:
   - The same gap section on the same Skill name in most projects points to the **shared Skill**
     (the foundation, or the fenced foundation region of each project's adapter).
   - A gap or section found in one project only points to **that project's notes, settings, or
     outdated copy of the foundation**.
   - A high `attribution.project-default` or `attribution.unattributed` share lowers confidence;
     say so.
5. **Choose where to file each finding:**
   - Cause is the shared Skill, or the project is the foundation project: **Apex Backlog**.
   - Cause is one non-foundation project: **{project} Azure DevOps**.
   - Report a shared-Skill finding once, under the foundation project, and list the other projects
     it appears in as evidence. Do not repeat it under each project.
6. **Propose one change per finding:** the smallest `SKILL.md` edit that targets the evidence.
   Quote the existing line you would change and give the replacement. Keep the change inside the
   Skill's own instructions. Never edit frontmatter, tool permissions, or the fenced foundation
   region of a project adapter; file those to the Apex Backlog.
7. **Say how to verify:** which metric should move, in which direction, and over how many new
   documents, given the current sample size.
8. **Hand off filing.** Each finding is written so a Platform Admin can paste it into
   Platform Admin → Skill Health → *Create work item*: the title as the title, the rest as the
   description, and the "File to" value as the destination. The tab creates Azure DevOps items as
   the signed-in user. This skill does not file anything itself.

## Output

Write `.ai-pilot/output/skill-health-report.md`, or reply in chat when there is no workspace.

```markdown
# Skill Health report — last {periodDays} days (generated {generatedAt})

## Verdict
One line per project, then one line per ranked Skill in it: path, output type, status, documents,
pass rate, trend direction.

## {project} ({foundation | skillRepo}) — files to {Apex Backlog | {project} Azure DevOps}

### {skillPath} ({artifact kind})
#### Finding 1: {symptom in one sentence}
- Title: Skill Health: {skill name} — {symptom in a few words} ({project})
- File to: Apex Backlog | {project} Azure DevOps
- Evidence: {counts in this project, other projects with the same gap, up to three quoted gap descriptions}
- Likely cause: Shared Skill | Project {name} | Unclear — {one-line reason}, confidence {low|medium|high}
- Proposed change: {quoted current line} -> {replacement}
- Verify by: {metric, direction, sample}

### Not enough data
{This project's Skills skipped in step 1}

{Repeat for each project in the input.}

## Limits of this report
{The caveats from the input, verbatim}
```

## Rules

- Every claim cites a number or a quoted gap from the input. Leave out anything you cannot cite.
- Separate what the data shows from what you suspect; label suspicions "Likely".
- Show sample sizes beside every rate.
- Never present a validation score as ground truth. The judge is itself a Skill and may be wrong,
  especially where `overrides` are high.
- Do not rewrite the judge (`design-doc-validation`, `prd-spec-review`) in the same report that
  relies on its scores.
