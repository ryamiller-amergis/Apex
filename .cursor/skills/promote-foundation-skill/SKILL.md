---
name: promote-foundation-skill
description: Use when promoting an existing Apex project skill into the shippable @apex/skills foundation package or when the user invokes /promote-foundation-skill.
disable-model-invocation: true
---

# Promote Foundation Skill

Convert one dogfooded Apex skill into a project-agnostic, adapter-aware
`@apex/skills` entry and leave the local package release-ready.

## Invocation

```text
/promote-foundation-skill <skill-name>
```

`<skill-name>` is the kebab-case directory under `.cursor/skills/`.

## Completion boundary

Release-ready means the approved local files exist, validation and tests pass,
and the npm tarball contains every declared file.

**Do not commit, push, publish, or create an APEX release.** Report the next
human/admin steps instead.

## Safe defaults

- Source: `.cursor/skills/<skill-name>/`.
- Tier: `shippable`.
- New skill versioning: additive minor bump for both
  `foundation-skills/catalog.json#suiteVersion` and
  `foundation-skills/package.json#version`.
- Scan scope: `targeted`; use `full-repo` only when targeted evidence cannot
  satisfy the skill.
- `alwaysInstall`: omit. Add it only with explicit user approval for a
  universally required companion.
- Existing target directories or catalog entries mean this is an update, not a
  promotion. Stop and ask the user which workflow they intend.
- Preserve all unrelated worktree changes.

Use **AskQuestion** only when a required decision cannot be derived safely:

- a statement could be either invariant procedure or project-specific context;
- no existing detector can supply a required adapter slot;
- companion-file ownership is ambiguous;
- the source behavior is contradictory or incomplete.

Ask one focused question at a time. Do not ask the user to choose defaults
already defined above.

## Promotion workflow

### 1. Preflight

1. Validate `<skill-name>` against `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`.
2. Read `.cursor/skills/<skill-name>/SKILL.md` and all directly referenced
   companion files.
3. Read:
   - `docs/APEX_FOUNDATION_SKILLS.md` section “Adding a new skill”
   - `foundation-skills/catalog.json`
   - `foundation-skills/lib/detectors.mjs`
   - two catalogued skills with similar inputs/outputs
4. Inspect git status. Never overwrite or revert unrelated edits.
5. Stop with an actionable error if the source is missing, a target already
   exists, or the skill is not suitable for consumer-repo invocation.

### 2. Define the split before editing

Prepare a short file plan and obtain one batch approval before writing:

```text
foundation-skills/foundation/<skill-name>/...
foundation-skills/adapters/<skill-name>/SKILL.md
foundation-skills/adapters/<skill-name>/apex-skill.json
foundation-skills/adapters/<skill-name>/recipe.json
foundation-skills/catalog.json
foundation-skills/package.json
foundation-skills/test/... (only when generic tests do not cover behavior)
```

Classify source content:

- **Foundation:** invariant role, procedure, rules, output contract, and generic
  templates. It must not assume Apex’s repository layout, services, tables,
  teams, design system, or product terminology.
- **Adapter:** consumer-project paths, commands, architecture, glossary,
  personas, design tokens, services, and other evidence-backed context.
- **Companion:** reusable schemas/templates belong to foundation; files whose
  values vary by project belong to adapter.

Do not copy the Apex skill verbatim and merely remove obvious names. Preserve
its role and behavior while replacing concrete assumptions with explicit
adapter slots.

### 3. Write the package files

Create:

```text
foundation-skills/foundation/<skill-name>/SKILL.md
foundation-skills/adapters/<skill-name>/SKILL.md
foundation-skills/adapters/<skill-name>/apex-skill.json
foundation-skills/adapters/<skill-name>/recipe.json
```

Requirements:

1. Foundation `SKILL.md` has matching kebab-case `name` and a specific
   description.
2. Adapter `SKILL.md` uses `{{slot:slotName}}`; never hand-write
   `APEX:slot` anchors. The bootstrap renderer adds anchors.
3. Every slot has a recipe directive backed by a detector in
   `foundation-skills/lib/detectors.mjs`.
4. `apex-skill.json` uses the live `contractApiVersion`, names
   `@apex/skills`, and lists every consumer-managed companion in
   `managedFiles`.
5. Catalog `foundationFiles`, `adapterFiles`, `dependsOn`, and
   `supportingOwners` exactly match files on disk.
6. Dependencies reference existing catalog skills and must not form cycles.
7. Do not add unresolved prose placeholders such as `TODO`, `TBD`, or
   “fill manually.” Runtime detection gaps are represented by bootstrap as
   `APEX:unfilled(...)`.
8. The promoted foundation must direct teams to `/post-skill-bootstrap` only
   when unresolved adapter context blocks correct operation.

### 4. Register and version

1. Add the new shippable entry to `foundation-skills/catalog.json`.
2. Apply an additive minor bump to `suiteVersion`.
3. Apply an additive minor bump to `foundation-skills/package.json#version`.
4. Keep the contract’s foundation range compatible with the new suite version.
5. Confirm `foundation-skills/package.json#files` includes both
   `foundation/` and `adapters/`.

Never reuse an npm version already published to Azure Artifacts.

### 5. Validate behavior and package contents

Run from the repository root:

```bash
node scripts/validate-foundation-skills.mjs
node --test foundation-skills/test/*.test.mjs
```

Then run from `foundation-skills/`:

```bash
npm pack --dry-run --json
```

Parse the JSON and assert it includes:

- `foundation/<skill-name>/SKILL.md`;
- every declared foundation companion;
- `adapters/<skill-name>/SKILL.md`;
- `adapters/<skill-name>/apex-skill.json`;
- `adapters/<skill-name>/recipe.json`;
- every declared adapter companion;
- `catalog.json`, `bin/`, and `lib/`.

Also assert there are no secrets, credentials, `.env` files, or unexpected
project-specific files. Warnings about undeclared/missing files are blockers.

### 6. Consumer smoke test

In a temporary git repository, use the local package root to:

1. install only `<skill-name>`;
2. confirm the lockfile lists it;
3. confirm `.cursor/skills/<skill-name>/SKILL.md` has managed, adapter, and
   Project notes zones;
4. run bootstrap twice;
5. confirm filled `APEX:slot` values survive and new detection gaps remain
   `APEX:unfilled(...)`;
6. confirm companions match the catalog and contract.

Do not smoke-test against MaxView, MatterWorx, or another real consumer repo.

## Completion report

Report:

- promoted skill and source;
- created/modified files;
- foundation/adapter split;
- version changes;
- validation, tests, pack-content assertion, and smoke-test results;
- unresolved warnings or decisions;
- next step: merge to `main`, let CI publish the candidate, then select the
  skill and audience in Platform Admin → APEX Skills.

If any gate fails, state **Not release-ready** and stop. Never soften a failed
packaging or smoke-test gate into a warning.
