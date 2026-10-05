---
name: post-skill-bootstrap
description: After APEX skills are installed and bootstrapped, scan lockfile-installed skill files for unfilled markers, interview the user, replace markers with confirmed values inside APEX:slot anchors, and report readiness. Use when the user runs /post-skill-bootstrap or asks to finish preparing APEX skills for use.
---

# Post Skill Bootstrap — Foundation

Make installed APEX skills ready for day-to-day use by resolving gaps that machine bootstrap could not fill.

## When to load

Load immediately when any of the following are true:

- The user sends `/post-skill-bootstrap`.
- The user asks to "finish skill setup", "ready the APEX skills", "fill skill TODOs", or "clear unfilled skill markers".
- Install/bootstrap just finished and the user wants a readiness pass.

## Scope (hard constraints)

1. **Only skills in `apex-skills.lock.json`** at the repo root. Read `lock.skillRoot` for the canonical root; treat a missing field as legacy `.cursor/skills`. Do **not** scan an entire skill tree.
2. **Never edit** between the `APEX:BEGIN managed` and `APEX:END managed` structural markers (foundation fence).
3. **Do edit** unfilled markers inside the **adapter** zone (`APEX:BEGIN/END adapter`) — replace them with confirmed values so the markers are gone.
4. Do **not** invent file paths. Confirm paths exist before writing them.
5. One question at a time via the **AskQuestion** tool. Wait for the answer before the next.

## Markers to find

In each lockfile skill's `<lock.skillRoot>/<skill>/SKILL.md` **adapter zone**, search for:

- `<!-- APEX:unfilled(slotName): … -->` (current)
- Legacy `<!-- TODO(slotName): … -->`

Ignore fence chrome (`APEX:BEGIN` / `APEX:END` notices).

**Skip the skill entirely** when it has no unfilled/TODO markers. A mistaken re-run should report Ready with nothing to do.

## How to write answers (remove the marker)

Slots are anchored like this:

```html
<!-- APEX:slot(slotName) -->
<!-- APEX:unfilled(slotName): … -->
<!-- APEX:/slot(slotName) -->
```

When the user answers:

1. Replace the **inner** content of that `APEX:slot(slotName)` block with the confirmed value only (plain text/path — no unfilled comment left behind).
2. Keep the `APEX:slot` / `APEX:/slot` anchors.
3. If you find a bare unfilled/TODO comment with no slot anchors, replace that comment with:

```html
<!-- APEX:slot(slotName) -->
confirmed value
<!-- APEX:/slot(slotName) -->
```

4. Do **not** leave the unfilled/TODO comment in the file once addressed.
5. Optional: one short bullet under `## Project notes` for audit (`Resolved contextFile → docs/CONTEXT.md`). Not required for readiness.

## Classification

| Kind | Examples | Action |
|---|---|---|
| Path / doc | `contextFile`, `agentsFile`, `skillsDir`, `aiPilotDir` | Ask which real path to use; verify it exists; write that path into the slot. |
| Human / semantic | `mission`, glossary nuances | Ask a short clarifying question; write the answer into the slot. |
| Waive | User says not applicable | Write `*(waived — reason)*` into the slot (marker removed). |

## Procedure

1. Read `apex-skills.lock.json`. If missing, tell the user to run install first and stop.
2. Resolve the canonical root from `lock.skillRoot` (legacy fallback: `.cursor/skills`), then read each `lock.skills` entry's `<skillRoot>/<skill>/SKILL.md` if present.
3. Collect **remaining** unfilled markers only (adapter zone). Skip skills with zero markers.
4. If none across all skills: report **Ready — no unfilled markers** and stop.
5. Otherwise show a short summary, then resolve one skill at a time, one slot at a time.
6. Before asking about a slot, read nearby adapter text and `## Project notes` for existing context so questions stay specific to that skill’s role — do not paste generic product dumps into every skill.
7. After each answer, rewrite the slot as above (marker gone).
8. Finish with a readiness report:

```markdown
## APEX skills readiness

| Skill | Markers cleared | Remaining | Status |
|---|---|---|---|
| … | N | 0 | Ready / Needs input |

Next: commit skill files + `.apex/config.json` + `apex-skills.lock.json`.
```

## Re-run and re-install behavior

- **Slash again with no markers:** skip — Ready.
- **install / bootstrap again:** filled `APEX:slot` values are preserved; only new or still-unfilled slots get new `APEX:unfilled` markers.
- **Slash after a later install:** address only the new markers; leave already-filled slots alone.

## What this skill does NOT do

- Does not run `install` or `bootstrap`.
- Does not scan non-lockfile skills.
- Does not modify the foundation fence or companion JSON/schema files.
- Does not invent product facts — only records what the user confirms.
- Does not dump the same generic context into every skill — only fill that skill’s open slots.
