---
name: post-skill-bootstrap
description: Project adapter for post-skill-bootstrap. Customize for your project.
---

# post-skill-bootstrap — Project Adapter

**Invocation:** `/post-skill-bootstrap`

- Project: {{slot:projectName}}
- Repo context file: {{slot:contextFile}}
- Agents / glossary file: {{slot:agentsFile}}
- Lockfile (scan only these skills): `apex-skills.lock.json`
- Skill install root: `.cursor/skills/`

## How to use here

1. Finish `npx @apex/skills install` and `npx @apex/skills bootstrap` for the released skills.
2. In Cursor, run `/post-skill-bootstrap`.
3. Answer AskQuestion prompts one at a time. Confirmed values replace `APEX:unfilled` markers inside `APEX:slot` anchors (markers are removed when addressed).
4. Re-running with no markers left is a no-op. Later install/bootstrap keeps filled slots and may add new unfilled markers for new gaps only.
