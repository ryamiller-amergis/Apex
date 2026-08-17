---
name: copilot-review-fix
description: Fetch GitHub Copilot PR review comments and apply or dismiss each finding.
---

# /copilot-review-fix

Follow `.cursor/skills/copilot-review-fix/SKILL.md`. Do not improvise a
different Copilot-comment workflow.

## Usage

`/copilot-review-fix` — current branch PR

`/copilot-review-fix 123` or a GitHub PR URL — that pull request

## Procedure

1. Read and follow the skill.
2. Run `scripts/fetch-copilot-threads.js` (do not hand-roll GraphQL).
3. Triage each Copilot thread: fix, dismiss, or ask.
4. Reply + resolve after each fix or dismiss.
5. Do not commit or push unless the user asks.
