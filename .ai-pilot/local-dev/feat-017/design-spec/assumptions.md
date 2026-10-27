# Assumptions & Unresolved Items — Platform Engineering Handoff Package

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.

---

## Unresolved Items

Items that could not be inferred from the PRD, backlog, or codebase. Each must be decided before the relevant implementation step starts.

- ⚠ **Review surface and the `/template-preview` route**: Every Feature in the backlog carries `route: "/template-preview"`, but the PRD says the template "has no Apex navigation entry", and a search of the Apex checkout finds no `template-preview` route, nav item, or permission. Platform Engineering is also not an Apex persona (the backlog maps it to `Platform Admin`, which in Apex is the super-admin panel). This spec assumes Platform Engineering reads `templates/full-stack-express/docs/handoff.md` in the repository and that no Apex screen is built. Blocks: whether any `src/client/` work, a `can()` guard, or a menu entry belongs in this Feature. Decision needed: confirm "repository read only", and remove or correct the `route` value on FEAT-001 through FEAT-017 in the backlog.

- ⚠ **Where contract resolution lives**: PBI-040 (stale contract) and PBI-041 (stale extension point) require the documentation validation to reject a handoff document that names a script, manifest, endpoint, environment variable, or interface that does not exist. TBI-034 (FEAT-014) only checks internal links, required sections, stale file paths, and agent-index coverage. A script name or environment variable is not a file path, so TBI-034 as written cannot satisfy those two acceptance criteria. This spec adds a contract-resolution check as step S3 in this Feature, extending the TBI-034 script. Blocks: S3 and VT-04, VT-05, VT-08, VT-10. Decision needed: either widen TBI-034 to include contract resolution, or add a TBI to FEAT-017 for it.

- ⚠ **TBI-034 priority is lower than the work that depends on it**: TBI-034 is `Should Have`. PBI-040, PBI-041, and TBI-042 are `Must Have`, and TBI-042's definition of done requires "The documentation validation passes for the document". If TBI-034 slips, three Must Have items cannot be verified. Decision needed: raise TBI-034 and PBI-031 to `Must Have`, or accept that FEAT-017 ships unverified.

- ⚠ **Knowledge-base file names are not fixed**: The handoff document must be linked from the agent entry-point document and listed in the plain-text agent index, and its required headings must be registered with the validator. TBI-033 and TBI-034 create those three artifacts, but the backlog gives no file names or config format. This spec refers to them by role and proposes `templates/full-stack-express/docs/handoff.md` for the handoff document and `docs:validate` as the validation script name. Blocks: S1 and S6. Decision needed: confirm the real names once TBI-033 and TBI-034 land, and substitute them in the implementation.

- ⚠ **FEAT-017 does not depend on FEAT-008**: The register's feature-flag-provider entry names the provider-neutral flag-evaluation interface from FEAT-008 as its extension point. FEAT-017 declares `dependsOn: FEAT-013, FEAT-014`, and FEAT-008 is not reachable through either. The implementation phases happen to build FEAT-008 earlier (phase 3), but the declared graph does not enforce it. Decision needed: add `FEAT-008` to FEAT-017's `dependsOn` in the backlog.

- ⚠ **Apex root formatting check scans the template**: Apex's `npm run lint` is `prettier --check .` with the root `.prettierrc` (single quotes, 80 columns, ES5 trailing commas), and the root has no `.prettierignore`. Prettier reformats Markdown tables, so every table in the handoff document must already be Prettier-formatted or the Apex root check fails. This restates the PRD assumption that asks maintainers to choose "conform" or "approved minimal ignore entry". Adding an ignore entry edits a root config file, which `scope-discipline.mdc` allows only with explicit permission. This spec assumes "conform". Decision needed: confirm "conform", or approve the ignore entry.

---

## Assumptions Accepted

Inferences made during synthesis that were treated as resolved. Confirm these with stakeholders before implementation locks.

- **Output file names**: The generation task fixes the names `design-doc-design.md`, `design-doc-tech-spec.md`, and `design-doc-assumptions.md` in `.ai-pilot/output/`. The skill's `{slug}-design-spec/{feature-slug}-*.md` layout is not used. Risk: none for content; only cross-links depend on the names.

- **Scope is one Feature**: Only FEAT-017 (TBI-042, PBI-040, PBI-041) is covered. Other features appear only where the handoff document names their artifacts. Risk: none.

- **Docs-only Feature**: The deliverable is one hand-written Markdown file, one validator extension, and tests, all inside `templates/full-stack-express/`. It adds no Apex route, service, component, shared type, migration, permission key, or Feature Flag. Derived from the PRD's "The template does not change Apex's runtime". Risk: if the open `/template-preview` question resolves to "build a screen", this assumption fails and the spec needs a UI section.

- **Persona mapping**: Platform Engineering is represented by `Platform Admin`, as the PRD and backlog state. Developers and development agents who read the document are `Developer`. Risk: the Apex `Platform Admin` group is super-admin only, so it does not match the real reviewers; see the first ⚠ item.

- **Handoff document location**: `templates/full-stack-express/docs/handoff.md`, one file, section order fixed by the tech spec. Derived from the PRD folder name and the TBI-033 docs-as-code layout. Risk: TBI-033 may place documents elsewhere; only paths in S1 and S6 change.

- **Contract kinds and how each resolves**: The handoff document's contracts table has a `Kind` column with these values, resolved by the validator as follows. `script` must be a key in `scripts` of the template root `package.json`. `manifest` and `container` must be an existing file. `endpoint` (method and path) must exist in the committed OpenAPI 3.1 document. `env` must be a key listed in the example environment file. The migration command is a `script` row. Derived from TBI-042's NFR "Every contract named in the document must exist in the template". Risk: if the committed OpenAPI document omits the health endpoints, `endpoint` rows for `/health/live` and `/health/ready` need a second source.

- **Ownership vocabulary**: The `Owner` cell holds exactly `Template` or `Platform Engineering`. Derived from PBI-040 (a), "has a named owner". Risk: none.

- **"Deployment packaging" is two rows**: The template owns the container definition (BR-014). Platform Engineering owns image publishing and deployment stages (PRD Out of Scope). One row cannot name a single owner for both, so the ownership table has "Deployment packaging — container definition" (owner `Template`) and "Deployment packaging — image publishing and deployment stages" (owner `Platform Engineering`). Risk: reviewers may expect one row; this keeps both facts true.

- **Ownership table rows**: AWS infrastructure (includes ECS configuration), CI/CD pipelines, migration execution, deployment packaging (two rows), and repository governance. The PRD Out of Scope list is the source. Risk: none.

- **Register columns**: `Decision`, `Extension point`, `Template behavior until decided`, `Decision needed from Platform Engineering`. There is no status column, because PBI-041 puts "Tracking decision status over time" out of scope. The FEAT-016 integration skill reads this table to list open decisions (PBI-038), so the headings are a contract and the validator checks them. Risk: renaming a column breaks the integration skill.

- **Register entries**: Production identity provider (extension point: identity-provider adapter interface and authentication middleware, FEAT-005). RBAC (authentication middleware and route definitions; BR-003). Data classification (the `app_users` fields and the log redaction configuration; FEAT-003, FEAT-007). NFR targets and test execution policy (the NFR manifest and the quality manifest; FEAT-012; BR-013). Feature-flag provider (flag-evaluation interface; FEAT-008; BR-011). Derived from PRD Assumptions Made, last bullet. Risk: exact file paths are known only after those features land; S1 reads them.

- **Data classification entry wording**: The entry says the classification of display name, email, and external identity subject is unresolved, and that synthetic fixtures and identity redaction are engineering practice, not a classification. It never names a classification level. Source: PBI-041 (c) and its security NFR. Risk: none.

- **Derived negative scenarios**: The backlog gives four acceptance criteria per PBI, none of them a clear negative case. This spec adds one per PBI. PBI-040 (d): an ownership row with an empty or unrecognized owner is rejected. PBI-041 (d): a register row with an empty extension point is rejected. Both need small validator rules (S3). Risk: if S3 drops those rules, remove the two rows and their VTs.

- **No secrets or internal host names**: The validator reports any absolute URL in the handoff document whose host is not `localhost`, `127.0.0.1`, or an `example.*` domain, and the template secret scan script (FEAT-013, TBI-030) runs over the file. Derived from PBI-040 and PBI-041 security NFRs. Risk: a legitimate public link, such as a standards document, needs an exception; the rule applies only to this file.

- **No Apex-side bookkeeping beyond the template folder**: This Feature adds files only under `templates/full-stack-express/`, which FEAT-001 creates. `.cursor/CODEMAP.md` must list the new top-level `templates/` folder per `codemap-sync.mdc`, but FEAT-001 owns that change, not this Feature. No `public/CHANGELOG.json` entry, because no Apex user-visible behavior ships. Risk: if FEAT-001 omits the CODEMAP entry, `npm run lint:check` does not fail (it only checks listed paths), so the gap would go unnoticed.

- **Isolation proof is a command, not a test file in Apex**: Apex's `jest.config.js` matches only `src/server/**/__tests__` and `src/client/**/__tests__`, so template tests never run under Apex Jest. Isolation is verified by running Apex's root `npm run lint` and `npm test` with and without the folder. Risk: none.

- **ADR text unavailable**: The accepted ADR "Build from prompt (single-prompt-build-orchestration)" could not be read, per the PRD. It shapes the role skills (FEAT-016), not this Feature. Risk: none for FEAT-017.
