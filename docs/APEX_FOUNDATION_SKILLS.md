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
| **Azure Artifacts feed auth** | The package is published to a private feed | Configure `.npmrc` + PAT (see §5) | `npm view @apex/skills version` |

**Quick start:**

```bash
# 1. Verify environment
npx @apex/skills doctor

# 2. Install selected skills (creates .apex/foundation/ + .cursor/skills/ adapters)
npx @apex/skills install ui-lab to-prd grill-with-docs

# 3. Install all skills
npx @apex/skills install
```

---

## 3. Team onboarding — install for a new repo

### 3a. Configure .npmrc for the Azure Artifacts feed

```
# .npmrc (project-level — commit this; the token is a separate secret)
@apex:registry=https://pkgs.dev.azure.com/{ORG}/_packaging/{FEED}/npm/registry/
```

Set the auth token (do NOT commit):

```bash
# Windows (PowerShell / cmd) — vsts-npm-auth handles token refresh
npx vsts-npm-auth -config .npmrc

# macOS / Linux — set NPM_TOKEN or use `npm config`
npm config set //pkgs.dev.azure.com/{ORG}/_packaging/{FEED}/npm/registry/:_authToken "${AZURE_ARTIFACTS_PAT}"
```

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
git add .apex/ .cursor/skills/ apex-skills.lock.json
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
4. Click **Publish** — this promotes the tarball from Local to Release view and
   records the SHA-256 integrity.
5. Consumer repos see the update notice in AgentHome.

---

## 7. Consumer update flow — team

Teams adopt updates on their own schedule — nothing is ever applied automatically.

### Option A — CLI (recommended)

```bash
# Check what version is available
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
