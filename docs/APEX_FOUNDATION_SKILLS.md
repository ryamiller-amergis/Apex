# APEX Foundation Skills Distribution

Operational guide for the `@apex/skills` foundation skills package — covering
prerequisites, team onboarding, the full release lifecycle, the one intended
UI Lab output change, and recovery / deprecation procedures.

---

## Contents

1. [What are foundation skills?](#1-what-are-foundation-skills)
2. [Prerequisites and environment setup](#2-prerequisites-and-environment-setup)
3. [Team onboarding — install for a new repo](#3-team-onboarding--install-for-a-new-repo)
4. [Per-skill scan scopes](#4-per-skill-scan-scopes)
5. [Azure Artifacts feed setup (human steps)](#5-azure-artifacts-feed-setup-human-steps)
5a. [Adding a new skill](#5a-adding-a-new-skill)
6. [Release lifecycle — Platform Admin](#6-release-lifecycle--platform-admin)
7. [Consumer update flow — team](#7-consumer-update-flow--team)
8. [The UI Lab design-source correction](#8-the-ui-lab-design-source-correction)
9. [Recovery and deprecation](#9-recovery-and-deprecation)
10. [Supported shells and OS](#10-supported-shells-and-os)
11. [Architecture reference](#11-architecture-reference)

---

## 1. What are foundation skills?

Foundation skills are the **project-agnostic workflow procedures** that power
APEX's AI-guided SDLC — `to-prd`, `grill-with-docs`, `ui-lab`, ADR interview,
standup, and 26 others. They ship as immutable markdown files vendored into a
consuming repo under `.apex/foundation/<skill>/`, alongside editable per-project
adapters in `.cursor/skills/<skill>/`.

```
Your repo/
  .apex/
    foundation/          ← managed by @apex/skills; do NOT edit
      ui-lab/
        SKILL.md
      to-prd/
        SKILL.md
        backlog-schema.json
  .cursor/
    skills/              ← owned by your team; edit freely
      ui-lab/
        SKILL.md         ← your project design tokens, components, rules
      to-prd/
        SKILL.md         ← your personas, context sources, schema extensions
  apex-skills.lock.json  ← managed; records version + file hashes
```

---

## 2. Prerequisites and environment setup

Before running the CLI, verify the following with `npx @apex/skills doctor`:

| Prerequisite | Why | How to install | Verify |
|---|---|---|---|
| **Node.js 18+ LTS** | The CLI is a Node ESM binary | [nodejs.org](https://nodejs.org) · `winget install OpenJS.NodeJS.LTS` · `nvm` | `node -v` (must be >= 18) |
| **npm / npx** | Ships with Node | Included in Node installer | `npm -v` |
| **Git 2.x** | Required for update/PR flow | [git-scm.com](https://git-scm.com) · `winget install Git.Git` | `git --version` |
| **Azure Artifacts feed auth** | The package is published to a private feed | `.npmrc.template` (committed) → local `.npmrc` via `init-registry` + PAT (see §3a) | `npm view @apex/skills version` |

**Quick start:**

```bash
# 1. Health check (fails hard if @apex registry / feed is missing — with remediation)
npx @apex/skills doctor

# 2. If doctor fails on apex-registry: create/merge local .npmrc from template
npx @apex/skills init-registry
npx vsts-npm-auth -config .npmrc

# 3. Re-check, then install
npx @apex/skills doctor
npx @apex/skills install ui-lab to-prd grill-with-docs

# 4. Or install all shippable skills
npx @apex/skills install
```

> **Chicken-and-egg:** the first `npx @apex/skills …` needs the feed already
> reachable. Until then, run the CLI from a local Apex checkout:
> `node /path/to/Apex/foundation-skills/bin/apex-skills.mjs <command>`.

---

## 3. Team onboarding — install for a new repo

### 3a. Registry template + local `.npmrc` (no tokens in git)

Many teams **gitignore** `.npmrc` because it may hold auth tokens. Ship a
committed **`.npmrc.template`** (registry URLs only) and generate the local
file with the CLI.

**Committed** (safe — no secrets):

```ini
# .npmrc.template — commit this
@apex:registry=https://pkgs.dev.azure.com/{ORG}/_packaging/{FEED}/npm/registry/
always-auth=true
```

Other scopes can coexist (example from MaxView):

```ini
@maxview:registry=https://pkgs.dev.azure.com/amergis/MaxView/_packaging/maxview-core/npm/registry/
@apex:registry=https://pkgs.dev.azure.com/amergis/_packaging/apex-skills/npm/registry/
always-auth=true
```

**Local** (gitignored):

```bash
# Creates .npmrc from .npmrc.template, or merges @apex into an existing .npmrc
npx @apex/skills init-registry
# Optional overrides:
# npx @apex/skills init-registry --org amergis --feed apex-skills

# Authenticate (token stays on the machine / in CI — never commit)
npx vsts-npm-auth -config .npmrc

# macOS / Linux alternative:
# npm config set //pkgs.dev.azure.com/{ORG}/_packaging/{FEED}/npm/registry/:_authToken "${AZURE_ARTIFACTS_PAT}"

# Verify
npm view @apex/skills version
npx @apex/skills doctor
```

`doctor` and `install` **hard-fail** until `@apex:registry` is present and the
package is reachable. Remediation text points at `init-registry` when a
template exists.

| File | Commit? | Purpose |
|---|---|---|
| `.npmrc.template` | Yes | Registry URLs for `@apex` (and other scopes) |
| `.npmrc` | No (often gitignored) | Local copy + auth; created/merged by `init-registry` |

### 3b. Run the installer

```bash
# Preview what will be written (no side effects)
npx @apex/skills install ui-lab --dry-run

# Install with adapter pre-fill from your repo's detected tokens/components
npx @apex/skills install ui-lab to-prd grill-with-docs

# Re-run adapter pre-fill without re-installing foundations
npx @apex/skills bootstrap ui-lab --explain
```

### 3c. Review adapter TODO placeholders

After install, each adapter in `.cursor/skills/<skill>/SKILL.md` will contain
your detected design tokens, component list, routes, and conventions. Fields
the scanner could not determine are marked:

```html
<!-- TODO(colorTokens): no css-variables evidence — fill in manually -->
```

Review these and fill them in for the best agent output. Run `--explain` to see
which evidence file backed each filled slot.

### 3d. Commit the results

```bash
# Commit template + skills — never commit .npmrc if it may contain tokens
git add .npmrc.template .apex/ .cursor/skills/ apex-skills.lock.json
git commit -m "chore: install @apex/skills foundation skills v<version>"
```

---

## 4. Per-skill scan scopes

Each skill declares a scan scope that controls how much of your repo the
bootstrapper reads when pre-filling its adapter:

| Scope | What it reads | Time budget |
|---|---|---|
| `targeted` | Specific globs (CSS files, `package.json`, component dir, routes) | A few seconds |
| `full-repo` | Entire repo, ignoring `node_modules`, `dist`, `.apex`, etc. | Up to **45 s per skill** |

Skills with `full-repo` scope (e.g. `app-knowledge`): the 45s is a hard ceiling
per skill, not a fixed wait. A skill that finishes in 10s immediately moves to
the next. If a skill hits the cap, its remaining adapter slots become TODO
placeholders — the adapter is still created and every other skill is unaffected.

---

## 5. Azure Artifacts feed setup (human steps)

> **These are one-time manual steps not performed by the agent.**

1. **Create the feed** in your Azure DevOps organization:
   - Organization → Artifacts → New feed
   - Name: `apex-skills` (or per `AZURE_ARTIFACTS_FEED` env var)
   - Visibility: Organization (private)

2. **Add two views** to the feed:
   - `Local` — CI publishes candidates here automatically
   - `Release` — Platform Admin promotes approved candidates here

3. **Provision a packaging PAT** with scope `Packaging (Read & Write)`:
   - User Settings → Personal Access Tokens → New Token
   - Save as `AZURE_ARTIFACTS_PAT` GitHub secret and in `.env`

4. **Configure `publishConfig`** in `foundation-skills/package.json`:
   Replace the `{AZURE_ARTIFACTS_ORG}` and `{AZURE_ARTIFACTS_FEED}` placeholders
   with real values. Alternatively, the CI workflow constructs the URL from
   `AZURE_ARTIFACTS_ORG`, `AZURE_ARTIFACTS_FEED`, and optionally
   `AZURE_ARTIFACTS_PROJECT`.

5. **Add secrets to GitHub Actions**:
   - `AZURE_ARTIFACTS_ORG`
   - `AZURE_ARTIFACTS_FEED`
   - `AZURE_ARTIFACTS_PAT`
   - (optional) `AZURE_ARTIFACTS_PROJECT` — only for project-scoped feeds

---

## 5a. Adding a new skill

A skill becomes releasable the moment it appears in `foundation-skills/catalog.json`.
The admin UI reads that file over `GET /api/platform-admin/foundation-skills/catalog`,
so **no client code changes are needed** to make a new skill selectable.

### Step 1 — Author it in APEX first

Build and dogfood the skill in `.cursor/skills/<name>/SKILL.md`, where it may freely
reference APEX's own services, tables, and tokens. This copy is never shipped.

### Step 2 — Create the project-agnostic foundation

Two directories, both named for the skill:

```
foundation-skills/foundation/<name>/
  SKILL.md          # required — the procedure, with no project specifics

foundation-skills/adapters/<name>/
  SKILL.md          # adapter template with {{slot:…}} placeholders
  apex-skill.json   # foundation dependency + contract version
  recipe.json       # scanScope, targetedGlobs, detectors, caps
```

`foundation/<name>/SKILL.md` needs YAML frontmatter with `name` and `description`.
It must contain **no project-specific identifiers** — `validate-foundation-skills.mjs`
fails the build on terms like `MaxView`, `TimeClock`, `Roboto`, or `MUI Material`.
Project context arrives at install time, when `bootstrap` fills the adapter's slots
from the consumer repo.

### Step 3 — Register it in the catalog

Add an entry to `foundation-skills/catalog.json` and bump `suiteVersion`:

```json
{
  "name": "my-new-skill",
  "summary": "One line describing what it does.",
  "tier": "shippable",
  "scanScope": "targeted",
  "foundationFiles": ["SKILL.md"],
  "adapterFiles": ["SKILL.md", "apex-skill.json", "recipe.json"],
  "dependsOn": [],
  "supportingOwners": {}
}
```

### Step 4 — Verify and release

```bash
node scripts/validate-foundation-skills.mjs   # must exit 0
```

Restart the APEX server — the catalog is cached per process, so a new skill will
not appear until the cache is rebuilt. It then shows up automatically in **Create
Draft → Skills**, in the **Skills** matrix, and in each project's read-only list.
From there, follow the normal release lifecycle below.

### Skill tiers

| Tier | Meaning |
|------|---------|
| `shippable` (default) | Lands in team repos. Offered in the release picker. Linted for project-specific terms. |
| `apex-only` | Executes inside the APEX platform itself and is never released to teams. Excluded from the release picker; `POST`/`PATCH` on a release rejects it with a 400. Exempt from the project-agnostic lint. |

Omitting `tier` means `shippable`. Use `apex-only` for skills the APEX server drives
on a team's behalf rather than skills a developer invokes in their own repo —
`design-doc-validation` is the current example, since it runs unattended via
`documentValidationService`.

### Why APEX skills and foundation skills are separate copies

`.cursor/skills/` and `foundation-skills/foundation/` hold deliberately different
files. The APEX copy is concrete and references this repo directly; the foundation
copy is de-projected and *must* be, because the validator rejects project-specific
identifiers there. The adapter layer re-injects project context per consumer repo.
Promoting a skill from "works in APEX" to "shipped to teams" is therefore an explicit
step: write the foundation version, write the adapter template, register it in the
catalog.

---

## 6. Release lifecycle — Platform Admin

All release management is in **Platform Admin → APEX Skills** (super-admin only).

```
foundation-skills/** changed + merged to main
        │
        ▼
CI: validate + test + publish candidate → Azure Artifacts Local view
        │
        ▼
Platform Admin inspects candidate
        │
        ▼
POST /api/platform-admin/foundation-skills/releases  (create draft)
        │
        ▼
POST /api/platform-admin/foundation-skills/releases/:id/publish
  → promotes to Azure Artifacts Release view
  → status: draft → published
        │
        ▼
Consumer repos see "Update available" banner in APEX
        │
        ▼
POST /api/platform-admin/foundation-skills/update-repo
  → clones repo, runs `npx @apex/skills install`, opens PR
```

### Candidate-to-release step-by-step

1. Merge a `foundation-skills/` change to `main`.
2. CI runs `validate-and-publish` and publishes a candidate to the Local view.
3. In Platform Admin → APEX Skills → **Create Draft**, enter the same version and
   artifact version as the CI-published candidate. Add release notes and mark any
   breaking changes.
4. **Select audience** — choose **All projects** (default) or **Specific projects**
   (searchable picker; e.g. select `MaxView` for a targeted rollout). Empty allowlist
   means every Apex project will see the update; a non-empty list restricts visibility.
5. Click **Publish** — promotes the tarball from Local to Release view and records SHA-256.
6. Only Apex projects in the allowlist (or all, if unrestricted) see the update
   notice in Agent Home.

---

## 7. Consumer update flow — team

Teams adopt updates on their own schedule — nothing is ever applied automatically.

### Option A — CLI (recommended)

```bash
# Check what version is available (only reports versions visible to your Apex project)
npx @apex/skills check

# Update foundations (never overwrites adapter files)
npx @apex/skills update

# Or update specific skills
npx @apex/skills update ui-lab to-prd
```

### Option B — Cursor slash command

```
/apex-skills update
/apex-skills check
```

### Option C — Accept an APEX-generated PR

A Platform Admin can open a PR on your behalf:
`Platform Admin → APEX Skills → Consumer Repos → Open PR`

The PR updates `.apex/foundation/` and `apex-skills.lock.json`. Your adapter
files in `.cursor/skills/` are never touched. Review, run
`npx @apex/skills validate`, and merge.

---

## 7a. MaxView — first-time install and update playbook

### Prerequisites

- Node.js 18+ LTS: `node -v` (must be `>= 18`)
- Git 2.x: `git --version`
- Repo-root **`.npmrc.template`** committed (includes `@maxview` + `@apex` scopes).
  Local **`.npmrc`** is gitignored — create it with `init-registry` (see §3a).
- For local branch testing (before the feed is reachable via `npx`):

  ```bash
  CLI="node /path/to/Apex/foundation-skills/bin/apex-skills.mjs"
  ```

### Step 1 — Health check + registry

```bash
cd /path/to/MaxView

$CLI doctor --skip-feed   # expect FAIL apex-registry until local .npmrc has @apex
$CLI init-registry        # merges @apex into gitignored .npmrc (keeps @maxview)
npx vsts-npm-auth -config .npmrc
npm view @apex/skills version
$CLI doctor               # hard checks should PASS when feed + auth are ready
```

### Step 2 — Install foundations in the MaxView repo

```bash
$CLI install ui-lab to-prd grill-with-docs
```

This creates:
- `.apex/foundation/<skill>/SKILL.md` — managed, do not edit
- `.cursor/skills/<skill>/SKILL.md` — your team adapter (safe to edit)
- `apex-skills.lock.json` — version + file hashes

### Step 3 — Review adapters

Adapter files include auto-detected tokens, components, and routes. Fields
the scanner could not determine are marked:

```html
<!-- TODO(designTokens): no css-variables evidence — fill in manually -->
```

Re-run the bootstrapper after filling in MaxView CSS files:

```bash
$CLI bootstrap ui-lab --explain
```

### Step 4 — Commit

```bash
# Include .npmrc.template once; keep local .npmrc gitignored
git add .npmrc.template .apex/ .cursor/skills/ apex-skills.lock.json
git commit -m "chore: install @apex/skills foundation skills"
```

### Step 5 — Day-to-day rules

- Edit only `.cursor/skills/**` adapters.
- Never edit `.apex/foundation/**` — drift blocks future installs.
- Run `$CLI validate` to verify no drift.

### Step 6 — Receiving a targeted update from APEX

When APEX publishes a release targeted at MaxView:

1. Agent Home → `MaxView` project shows the **Skills update** banner.
2. Click the `npx @apex/skills update` command to copy it, then run:

   ```bash
   cd /path/to/MaxView
   $CLI check        # verify the available version
   $CLI update       # re-vendors foundation files; adapters untouched
   $CLI validate     # confirm clean state
   git add .apex/ apex-skills.lock.json
   git commit -m "chore: update @apex/skills to vX.Y.Z"
   ```

3. Open Agent Home on a project that is **not** in the allowlist → no banner.

### Step 7 — Seeding Consumer Repos status (Platform Admin)

In Platform Admin → APEX Skills → **Consumer Repos**, fill in the
"Run compatibility check" form:

| Field | Value |
|---|---|
| Apex project name | `MaxView` |
| Provider | Azure DevOps |
| ADO project | `MaxView` |
| Skill repo name | `MaxView` |

Click **Check compatibility**. The row now appears in the table and
`updateAvailable` drives the banner on Agent Home for MaxView users.

---

## 8. The UI Lab design-source correction

This is the **single intended behavior change** in the foundation skills rollout.

### Before (current state)
The APEX UI Lab generates MaxView-styled prototypes regardless of which project
is selected, because `uiLabBedrockService` hardcodes the MaxView color token asset
and MaxView ADO component catalog.

### After
When the selected project is the APEX project (determined by `APEX_PROJECT_NAME`
env var, default `"Apex"`), the UI Lab generates **APEX-styled** output using:
- `src/server/assets/apex-colors.md` — APEX CSS custom properties
- `src/server/assets/apex-component-index.md` — APEX React components
- APEX `ui-lab` adapter (`.cursor/skills/ui-lab/SKILL.md`)

MaxView and all other projects continue to receive MaxView-styled output
**unchanged** until their own adapters are populated.

### Transitional fallback guarantee
Until the APEX `ui-lab` adapter is populated with APEX-specific content, the
service falls back to the current MaxView behavior. The fallback is byte-identical
to today's output and is tested in the server test suite.

### Setting APEX_PROJECT_NAME
In `.env` (and App Service config):
```
APEX_PROJECT_NAME=Apex
```
Must match the project name in the APEX project selector (case-insensitive).

---

## 9. Recovery and deprecation

### Deprecate a release

```
Platform Admin → APEX Skills → Releases → Deprecate
```

Or via API:
```bash
curl -X POST https://your-apex/api/platform-admin/foundation-skills/releases/{id}/deprecate \
  -H "Content-Type: application/json" \
  -d '{"reason": "superseded by v1.1.0"}'
```

Deprecation is recorded in the audit log. Consumer repos already on this version
continue working — the `check` command will warn that the installed release is
deprecated and a newer release is available.

### Handle foundation file drift

If a team hand-edited `.apex/foundation/` files (which they should not), the
`update` command will abort:

```
Foundation drift detected — existing managed files modified: .apex/foundation/ui-lab/SKILL.md
```

Resolution:
```bash
# Revert the edited foundation file to the installed version
git checkout HEAD -- .apex/foundation/ui-lab/SKILL.md

# Then re-run update
npx @apex/skills update
```

Or, if the edit was intentional, accept the drift and reset the lockfile:
```bash
npx @apex/skills install ui-lab --fill   # re-installs and refreshes lockfile
```

### Rolling back a bad release

1. Deprecate the bad release in Platform Admin.
2. Create and publish a patch release with the fix.
3. Consumers run `npx @apex/skills update` or accept the APEX-generated PR.

---

## 10. Supported shells and OS

The CLI normalizes file paths and line endings so output is byte-identical across:

| Shell | OS | Notes |
|---|---|---|
| PowerShell 5.1 / 7+ | Windows | Default on Windows; npx resolves Node from PATH |
| Git Bash | Windows | MSYS2; behaves like POSIX |
| cmd.exe | Windows | Supported; prefer PowerShell or Git Bash for richer output |
| Terminal (zsh/bash) | macOS / Linux | Default; no special configuration needed |

Line endings: adapters are written with LF and normalized on read, so PR diffs
are clean on all platforms regardless of `core.autocrlf` settings.
The lockfile uses POSIX paths internally for cross-platform consistency.

---

## 11. Architecture reference

```
foundation-skills/          @apex/skills npm package
  catalog.json              — skill index (name, scanScope, foundationFiles)
  foundation/<skill>/       — immutable generic SKILL.md + supporting files
  adapters/<skill>/         — adapter template + recipe.json + apex-skill.json
  lib/                      — installer, bootstrapper, detectors, lockfile, check
  bin/apex-skills.mjs       — CLI entry point
  test/                     — Node built-in test suite (23 tests)

src/server/services/
  foundationSkillResolverService.ts    — local disk skill resolution (Wave 4)
  foundationSkillReleaseService.ts     — release lifecycle + audit (Wave 6)
  foundationSkillCompatibilityService.ts — lockfile scanning + repo status (Wave 6)
  azureArtifactsSkillService.ts        — feed candidate discovery + promotion (Wave 6)
  foundationSkillRepoUpdateService.ts  — clone → install → PR (Wave 7)

src/server/routes/
  foundationSkillsAdmin.ts   — /api/platform-admin/foundation-skills/* (Wave 6-7)
  skills.ts                  — /api/skills/foundation-* consumer endpoints (Wave 6)
  platformAdmin.ts           — mounts foundationSkillsAdmin (Wave 6)

src/client/
  hooks/useFoundationSkillAdmin.ts        — Platform Admin mutations + queries (Wave 8)
  hooks/useFoundationSkillUpdateStatus.ts — team-facing update status check (Wave 8)
  components/FoundationSkillsAdmin.tsx    — Platform Admin APEX Skills tab (Wave 8)
  components/FoundationSkillUpdateBanner.tsx — team update notice (Wave 8)

src/server/db/schema.ts + migrations/
  foundation_skill_releases              — release lifecycle records (Wave 5)
  foundation_skill_release_audit         — append-only audit log (Wave 5)
  foundation_skill_repo_status           — consumer repo install state (Wave 5)

src/server/assets/
  apex-colors.md / .json      — APEX CSS token catalog (Wave 3)
  apex-component-index.md     — APEX React component index (Wave 3)

.github/workflows/publish-apex-skills.yml  — CI publish pipeline (Wave 9)
```
