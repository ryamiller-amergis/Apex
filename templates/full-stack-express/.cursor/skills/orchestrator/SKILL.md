---
name: orchestrator
description: Runs one prompted build in order. Writes a brief, asks the recorded questions, waits for plan approval, then loads the planner, developer, UI, QA, and integration skills. Use when a person asks to build or change an app. The person sees the integration verdict.
---

# Orchestrator

## Purpose

The orchestrator is the only skill that talks to the person during a prompted build. It writes the brief, asks the questions in the build-artifacts guide, and loads the other skills in order. It does not write application code.

## When to use

Use this skill when a person describes an app or a change and wants it built in this repository. Do not use it to skip plan approval, to deploy, or to run a pipeline.

## Inputs

Read these before the brief. Paths are relative to the repository root. Stop if one of them cannot be read. Name the missing path and write nothing.

- [Agent guide](../../../AGENTS.md)
- [Build artifacts](../../../docs/plans/README.md) (`docs/plans/README.md`)
- [Feature slices](../../../docs/feature-slices.md) (`docs/feature-slices.md`)
- [Evidence reports](../../../quality/evidence/README.md) (`quality/evidence/README.md`)
- [Planner](../planner/SKILL.md) (`.cursor/skills/planner/SKILL.md`)
- [Developer](../developer/SKILL.md) (`.cursor/skills/developer/SKILL.md`)
- [UI role](../ui/SKILL.md) (`.cursor/skills/ui/SKILL.md`)
- [QA](../qa/SKILL.md) (`.cursor/skills/qa/SKILL.md`)
- [Integration](../integration/SKILL.md) (`.cursor/skills/integration/SKILL.md`)
- [Quality manifest](../../../quality/quality-manifest.json) (`quality/quality-manifest.json`)

## Required references

The Inputs list is the required set. Read every path before writing a brief. A missing path is a stop, not a guess.

## Rules

The Enforced by cell is a gate id from `quality/quality-manifest.json`, or `Review`.

| ID      | Rule                                                                                                                                               | Enforced by |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| ORC-R01 | Read every Inputs path before the brief. If one cannot be read, name the missing path and write nothing.                                           | Review      |
| ORC-R02 | Ask a question from `docs/plans/README.md` verbatim, and only when that guide says to ask. Record the answer in the brief before the planner runs. | Review      |
| ORC-R03 | A pause answer stops the build. Write no plan and no code.                                                                                         | Review      |
| ORC-R04 | The developer skill starts only after the person approves the plan file. Silence is not approval.                                                  | Review      |
| ORC-R05 | Load the skills in order: planner, developer, UI role when a screen changes, QA, then integration.                                                 | Review      |
| ORC-R06 | The status shown to the person is the integration verdict in the readiness report.                                                                 | Review      |
| ORC-R07 | The brief, the plan, and the evidence contain no secrets and no identity values.                                                                   | Review      |

## Procedure

1. Read every file under Inputs. If one cannot be read, stop and name the missing path. Write nothing.
2. Choose a kebab-case slug from the prompt. Write `docs/plans/<slug>.brief.md` with the prompt summary. Set Authorization, Identity, and Performance to `not asked`.
3. Ask the Authorization, Identity, or Performance question when `docs/plans/README.md` says to ask it. Use the words in that guide. Wait for the answer. Record it in the brief. A pause answer stops the build.
4. Load the planner skill. It writes `docs/plans/<slug>.md`. If the planner stops, show that stop and write no code.
5. Show the plan to the person. Wait for approval. A change request is another planner pass. A refusal stops the build.
6. Load the developer skill. When the plan includes a screen, the developer skill loads the UI role skill, which writes `quality/evidence/<slug>-ui.md`.
7. Load the QA skill. It writes `quality/evidence/<slug>.md`. That verdict is verified only when every gate passed.
8. Load the integration skill. It writes `quality/evidence/<slug>-readiness.md`. Show that verdict to the person.

## Outputs

- The brief at `docs/plans/<slug>.brief.md`
- The plan at `docs/plans/<slug>.md`, after the planner runs
- The UI evidence note, when a screen changes
- The QA evidence report
- The readiness report, which is the status the person sees

## Review checklist

Mark each item yes, no, or not applicable. A no is a failure.

| Item                                                                              | Evidence source                        | Met? (yes, no, not applicable) |
| --------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------ |
| Every Inputs path was read, or nothing was written (ORC-R01)                      | The missing-path line, or the brief    |                                |
| Questions match the build-artifacts guide, and answers are in the brief (ORC-R02) | `docs/plans/README.md` and the brief   |                                |
| A pause answer produced no plan and no code (ORC-R03)                             | The stop report                        |                                |
| The developer skill waited for approval (ORC-R04)                                 | The plan file and the reply            |                                |
| Skills ran in order (ORC-R05)                                                     | The evidence files                     |                                |
| The person was shown the integration verdict (ORC-R06)                            | `quality/evidence/<slug>-readiness.md` |                                |
| Artifacts have no secrets or identity values (ORC-R07)                            | The brief, the plan, and the evidence  |                                |

## Stop conditions

Stop and report the missing piece. Do not guess. Write no application code.

- An Inputs path cannot be read. Name that path.
- The brief records pause for authorization, identity, or performance.
- The planner, the developer, the UI role, QA, or integration stops. Show that stop.
- The person does not approve the plan.

## Boundaries

- Do not write or edit application code, tests, or migrations. The developer skill does that.
- Do not invent a role model, an identity provider, or a performance number.
- Do not start the developer skill before the person approves the plan.
- Do not deploy, and do not run a pipeline.
- Do not treat the QA verdict as the status the person sees. Show the readiness report.
