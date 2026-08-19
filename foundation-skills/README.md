# `@apex/skills`

APEX foundation skills packaged as
[Agent Skills](https://agentskills.io/specification). Every installed skill is a
directory with a specification-compliant `SKILL.md`; templates, schemas, and
other companion files remain inside that skill directory.

## Canonical skill root

Legacy installations use `.cursor/skills`. For a harness-neutral catalog, set
the canonical root during the first install:

```sh
npx @apex/skills install <skill...> --skill-root .agents/skills
```

`--skill-root` is first-install-only. There is no environment-variable default.
When no lockfile exists, root selection is:

1. Explicit `--skill-root` (or API `skillRoot`)
2. `.agents/skills` if that directory already exists (for example a catalog
   created by another harness)
3. otherwise `.cursor/skills`

Once a lockfile exists, that recorded root wins. Changing it requires
`migrate-root`; a later `--skill-root` that disagrees with the lockfile fails
install rather than silently forking the catalog.

The selected repository-relative path is persisted in `apex-skills.lock.json`.
Non-legacy roots write `lockfileVersion` 3 with a `skillRoot` field. Legacy
`.cursor/skills` installs keep `lockfileVersion` 2 and omit `skillRoot`, so
already-published 2.0.x CLIs keep reading those lockfiles. Install, update,
bootstrap, check, lockfile integrity, backup, and rollback then use that root
consistently.

Keep one canonical catalog. If another harness requires a different discovery
path, point that harness at `.agents/skills` or create a repository-owned
symlink to it; do not install a second copy. APEX blocks same-name skills found
across canonical and legacy roots.

## Migrating an existing installation

Preview and then move an existing installation:

```sh
npx @apex/skills migrate-root --to .agents/skills --dry-run
npx @apex/skills migrate-root --to .agents/skills
```

Migration moves each lockfile-owned skill directory intact, preserving adapter
slots and project notes. It updates managed-file paths, hashes, and lockfile
integrity transactionally. Migration stops without writing when managed files
have drifted, an installed file is missing, or a same-name destination exists.
Project notes are left intact; migrate-root scans the repository for remaining
mentions of the previous root (READMEs, CI, rules, and application code, not
only files under the skill roots) so they can be cleaned up deliberately.

Run `npx @apex/skills check` after migration and commit the moved directories
with `apex-skills.lock.json`.

## Validation

```sh
npx @apex/skills validate
```

Package validation enforces the Agent Skills frontmatter contract: required
`name` and `description`, directory/name equality, field length and naming
constraints, string metadata values, and the standard optional fields.
Unrecognized top-level keys used by other harnesses are warnings, not errors.

For an independent conformance check, run the Agent Skills project’s
[`skills-ref validate`](https://github.com/agentskills/agentskills/tree/main/skills-ref)
against any installed skill directory.
