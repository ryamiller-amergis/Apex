---
name: apex-skills
description: Install, check, and update APEX foundation skills in this repo by delegating to the @apex/skills CLI. Never reimplements install/update logic.
---

# /apex-skills

Thin wrapper over the `@apex/skills` CLI so `/apex-skills <subcommand>` runs the
same code path as a terminal invocation. Do not reimplement any install, update,
bootstrap, or validation logic here — always shell out to the CLI.

## Usage

`/apex-skills <install|check|update|bootstrap|doctor|validate> [skills...] [flags]`

## Procedure

1. Verify prerequisites first:

```bash
npx @apex/skills doctor
```

If any hard prerequisite fails, stop and show the remediation from the output.

2. Run the requested subcommand from the repository root. Examples:

```bash
# Install selected skills (vendors foundations + scaffolds pre-filled adapters)
npx @apex/skills install ui-lab

# See installed vs available version and per-skill compatibility
npx @apex/skills check

# Move to the current published suite (never clobbers edited adapters)
npx @apex/skills update

# Re-draft an adapter from the repo and show evidence sources
npx @apex/skills bootstrap ui-lab --explain

# Preview an install without writing
npx @apex/skills install --dry-run
```

## Rules

- Run from the repository root so `.cursor/skills/` and `apex-skills.lock.json` land in the right place.
- Put project customization **below** `<!-- APEX:END managed -->` in each `SKILL.md`. Content above the fence is replaced on update/bootstrap.
- Companion files (schemas/templates) under `.cursor/skills/<skill>/` are fully managed and overwritten on update.
- Report the CLI's output verbatim; do not paraphrase compatibility results.
