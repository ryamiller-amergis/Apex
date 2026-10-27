# Design — Supply-Chain Baseline and Production Container

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Testing, Quality Manifest and Supply Chain | **Affected personas:** Platform Admin, Developer
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (7 unresolved)

---

## Feature Summary

**Description:** An agent or developer cannot show that a build is acceptable unless the repository holds scripts that check the supply chain and package the application. This Feature gives the full-stack Express template one hardened container definition that packages the API and the built web client, a script that generates a software bill of materials (SBOM), and three scan scripts for secrets, vulnerable dependencies and license violations. A Platform Admin (Platform Engineering) builds one image and deploys it with their own infrastructure and pipeline. A Developer sees supply-chain problems locally before merging. The Feature depends on the Health and Self-Service Profile API (FEAT-006) and the Self-Service Profile Screen (FEAT-010) for the artifacts it packages.

**Feature ID:** FEAT-013 | **Depends on:** FEAT-006, FEAT-010

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-030 | TBI | Add secret, vulnerability, and license scan scripts | Must Have |
| TBI-031 | TBI | Add SBOM generation | Must Have |
| TBI-032 | TBI | Create the production container definition | Must Have |
| PBI-027 | PBI | Build one hardened container image | Must Have |
| PBI-028 | PBI | Generate an SBOM for each build | Must Have |
| PBI-029 | PBI | Catch secrets, vulnerable dependencies, and license violations before merging | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- One multi-stage production container definition (`Dockerfile` and `.dockerignore`) in `templates/full-stack-express/`. It runs as a non-root user, has a minimal runtime surface, and packages the API and the built web client. The same process serves both.
- A `container:build` script that builds the image locally, and a `test:container` script that proves the image meets PBI-027.
- A secret scan, a vulnerability scan and a license check. Each is a named script that exits non-zero on findings and never prints a secret value.
- An allowed-license list and a reviewed-exception file, both committed to the repository, with documentation on how to record an exception.
- An SBOM script that writes a deterministic SBOM in a standard format from the lockfile, and optionally from image contents. Generated SBOM files are excluded from version control.
- Seeded tests that prove a planted fake secret is detected.
- Startup checks the container relies on: a missing required environment value aborts startup, and the development identity adapter aborts startup in production. Other Features own the checks. This Feature proves them inside the container.

**Out of scope:**
- Image publishing, registry configuration, and ECS deployment.
- Pushing the image to a registry, and ECS task and service configuration.
- SBOM storage, publication and signing.
- Automated dependency-update configuration and proposals.
- A security review workflow.
- CI/CD pipeline definitions, execution policy, and deployment stages (Platform Engineering).
- AWS infrastructure as code, Terraform, and any AWS or ECS assumption in the image.
- Production execution of database migrations. The image carries no migration tooling, and the application never changes schema at startup.
- A production identity provider, roles, permissions and RBAC.
- Fixed performance targets. Image size and start time are recorded by each project.
- Any change to Apex runtime behavior, its database, its services or its builds.

---

## Target Surface

**Primary surface:** Full-stack (both client and server)

**Experience notes:** The template is a standalone starter repository, not an Apex screen, and it has no Apex navigation entry. This Feature adds no screen. It packages the finished profile screen (FEAT-010) and the API (FEAT-006) into one image. The Developer and Platform Admin work from the command line through named scripts. The backlog `route` value for this Feature (`/profile/licenses/edit`) is wrong. See the first unresolved item in the assumptions file.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Run the secret, vulnerability and license scans locally | Developer (any person or agent with the template checkout) | No restriction (local checkout) |
| Generate the SBOM | Platform Admin, Developer | No restriction (local checkout) |
| Build the production container image | Platform Admin (Platform Engineering) | Global |
| Review the template in Apex and move it to the bootstrap source | Platform Admin (Platform Engineering) | Global |
| Call `/health/live` and `/health/ready` on the running container | None required | No restriction |
| Select the development identity adapter in the container | Not allowed in production. Local only: authentication mode `development` and a non-production environment | User-scoped (one fixed synthetic principal) |
| Role-based authorization inside the container | Not defined. Extension point for Platform Engineering (BR-003) | Not applicable |

**Feature flag:** `None` — rollout: Not applicable (a reviewable sample that does not change Apex runtime behavior)
**Behavior when flag is off:** Not applicable

---

## Acceptance Criteria

### PBI-027 — Build one hardened container image

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A clean checkout | I build the container image | The build succeeds and the image serves the API and the web client |
| (b) Error/failure | The container starts without required environment values | It boots | It aborts with an error naming the missing variable, and no secret values are printed |
| (c) Edge case/boundary | The container runs | I check the running user and installed packages | The process is non-root and no development dependencies or build tools are present |
| (d) Negative scenario | The development authentication mode is set while the environment is production | The container starts | It aborts and does not serve requests |

### PBI-028 — Generate an SBOM for each build

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The workspace is installed | I run the SBOM script | An SBOM is written that lists every production dependency and version |
| (b) Error/failure | The lockfile is missing or invalid | I run the SBOM script | It exits non-zero with a message and writes no partial file |
| (c) Edge case/boundary | The lockfile has not changed | I run the script twice | The package list in both outputs is identical |
| (d) Negative scenario | The repository contains development-only dependencies | I read the production SBOM | Development-only dependencies are not listed as production components |

### PBI-029 — Catch secrets, vulnerable dependencies, and license violations before merging

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | No secrets, vulnerable packages, or disallowed licenses are present | I run the three checks | Each exits zero |
| (b) Error/failure | A fake secret is committed in a test file | I run the secret scan | It exits non-zero, names the file and line, and does not print the secret |
| (c) Edge case/boundary | A dependency has a reviewed exception recorded in the repository | I run the vulnerability scan | The exception is honored and listed in the output |
| (d) Negative scenario | A dependency uses a license not on the allowed list | I run the license check | It exits non-zero and names the package and license |

---

## UI/UX

Not applicable. This Feature adds no screen, route, component or `data-testid`. The container serves the Self-Service Profile Screen that FEAT-010 owns, and FEAT-010 owns that screen's states, validation and accessibility. All output from the scan and SBOM scripts is plain text, so no accessibility rules apply to it.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
