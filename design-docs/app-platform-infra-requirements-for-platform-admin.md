# What Apex Needs From Platform Provisioning — AI-Generated Applications

Audience: platform admin team that owns the dynamic AWS provisioning (per-project stand-up).
Purpose: Apex will let internal users describe an application in chat; an AI workflow then generates the code, verifies it, and needs somewhere real for it to run. This document states what that workflow needs from your provisioning, per generated application, so you can mark each item **have it / partial / missing** and quote the gaps.

Context in one paragraph: Apex itself already exists (Entra-authenticated, RBAC, an orchestration engine with human approval gates). Generated applications are *separate, small CRUD/dashboard apps* owned by the person who described them. Apex generates and verifies the code; it does not want to own AWS accounts or VPCs. It needs provisioning as a callable service with a defined input/output contract.

Repo referenced by requestor: [apex-dochub pipeline folder](https://dev.azure.com/amergis/MatterWorx/_git/apex-dochub?path=/pipeline) — Apex could not read it (Azure DevOps sign-in), so nothing below assumes its contents; please correct the Have/Missing column against it.

---

## 1. The contract Apex needs (most important section)

Provisioning today is presumably triggered per new *project* by a person. Generated apps need it triggered **per application, by software**:

- [ ] A programmatic trigger Apex can call (ADO pipeline REST trigger, API, or queue) with parameters: `appId`, `projectId`, `owner`, `environment` (`preview` | `prod`), `archetype` (`crud` | `dashboard`), and an **idempotency key** so a retried call never creates two stacks.
- [ ] Asynchronous completion Apex can observe: status polling endpoint or a callback/webhook with states `provisioning | ready | failed`, plus failure reasons in plain text.
- [ ] A machine-readable **outputs document** returned on success (JSON), minimum fields:
  - `appUrl`, `apiUrl`
  - `databaseEndpoint`, `databaseName`, `databaseSecretArn` (never a plaintext password)
  - `storageBucketName` (if the archetype uses file storage)
  - `logGroupName`, `deployRoleArn`, `taskRoleArn`
  - `environment`, `region`, `provisionedAt`, `stackName` / equivalent handle for teardown
- [ ] A matching **deprovision** call with the same idempotency rules, used by preview expiry and app retirement.
- [ ] Provisioning time budget: a preview environment ready in **≤ 15 minutes**; prod in **≤ 30 minutes**. If real times are longer, tell us — the workflow can be designed around them, but it must know.

If only one thing gets built, build this section. Everything else can ride on your existing per-project stand-up; without a callable contract, a human stays in the loop for every generated app and the product does not work.

## 2. Compute and delivery (per app)

- [ ] Container runtime (ECS Fargate or equivalent): one service per app per environment, health check, rolling deploy.
- [ ] Container registry (ECR) with per-app repository or per-app prefix, plus a push identity Apex's build step can assume.
- [ ] Redeploy by new image digest, and **rollback to the previous task definition/image digest in one call** — Apex stores versions and will ask for this by digest.
- [ ] Scale-to-zero (or scheduled scale-down) for preview and idle apps; generated apps are mostly small and idle.
- [ ] Resource defaults enforced server-side (CPU/memory ceilings per app), not honour-system parameters.

## 3. Networking and TLS

- [ ] One public HTTPS endpoint per app: ALB (shared ALB with host-based routing preferred — per-app ALBs will hit cost and quota fast), ACM certificate, and a DNS name per app, e.g. `<appId>.apps.<project-domain>`.
- [ ] App compute in private subnets; only the ALB is public. Database never publicly reachable — no exceptions for generated apps.
- [ ] Egress control: generated apps get outbound internet only if the archetype asks; default is VPC-internal + AWS APIs.
- [ ] Preview environments reachable only from the corporate network / identity-aware access, never the open internet.

## 4. Data (per app)

- [ ] PostgreSQL per app: dedicated database + dedicated user on a shared cluster is acceptable for v1; dedicated instance is **not** required. State which model you offer.
- [ ] Automated backups with point-in-time restore, retention ≥ 7 days, and a restore procedure Apex can request (not perform).
- [ ] A migration hook: provisioning returns the connection secret *before* first deploy so Apex's verify step can run schema migrations, or provisioning accepts and runs a migration bundle. One of the two — tell us which.
- [ ] S3 bucket per app (file archetypes): versioning on, server-side encryption, public access blocked, lifecycle rule for preview buckets (auto-expire).
- [ ] (Optional, later) SQS queue per app for background jobs. Not needed for v1; flag if per-project queues already exist.

## 5. Identity and access

What exists on the Apex side: users sign in with **Entra ID**; Apex enforces RBAC and records every approval. Generated apps should not invent their own passwords.

- [ ] User auth for generated apps: one of (a) Cognito user pool federated to Entra, (b) ALB OIDC authentication against Entra, or (c) your existing pattern — state which. Apex needs, per app, the OIDC client configuration (issuer, client id, callback URLs) as provisioning outputs.
- [ ] Role mapping hook: the app receives the user's groups/claims so Blueprint roles (e.g. approver, viewer) can be enforced inside the app.
- [ ] A deploy identity per app (task role) with least privilege: its own database secret, its own bucket, its own log group. Nothing cross-app.
- [ ] A provisioning identity Apex may assume (role ARN + external id, or pipeline service connection) scoped to creating/updating/deleting *generated-app* resources only, tagged as in §7.

## 6. Secrets and configuration

- [ ] Secrets Manager (or SSM Parameter Store) namespace per app: `/apps/<projectId>/<appId>/<environment>/*`.
- [ ] Secrets injected into the running container by reference; Apex never receives plaintext secrets in outputs, logs, or the pipeline transcript.
- [ ] Rotation story for the database credential (managed rotation preferred).

## 7. Observability, cost, and guardrails

- [ ] CloudWatch log group per app with retention set (30 days preview, 90 days prod or your standard).
- [ ] Baseline alarms (5xx rate, task health, DB connections/storage) routed to your existing monitoring, with the app owner as a tag.
- [ ] **Mandatory tags on every resource**: `appId`, `projectId`, `owner`, `environment`, `managedBy=apex-app-platform`, `archetype`. Cost reports must be sliceable by `appId` — generated apps make resource counts grow by 10–100×, and untagged spend is the first thing that will get this programme shut down.
- [ ] Per-app cost visibility or at least a monthly per-`appId` cost export Apex can show owners.
- [ ] Guardrails inherited automatically: encryption at rest, no public S3, no public DB, TLS 1.2+. Generated code is AI-written; the platform guardrails are the safety net, and they must not depend on the generated code behaving.

## 8. Lifecycle operations

- [ ] Preview auto-expiry: preview stacks carry a TTL (default 48h) and delete themselves; Apex will also call deprovision, but the TTL is the backstop.
- [ ] Decommission: full teardown per app behind the same programmatic contract, retaining a final data snapshot per your retention standard.
- [ ] Drift/change visibility: if the standard changes (new base image, new WAF rule), a way to list which generated apps are on which revision.
- [ ] Quotas: confirm account/region headroom for the growth case — 50 projects × 10 apps × 2 environments = 1,000 services, databases, buckets, log groups. If the answer is "that breaks X", we need to know X now, in October, not in December.

## 9. What Apex does *not* need from you

- No per-app AWS accounts for v1 (shared account + per-app isolation above is acceptable; tell us if your standard says otherwise).
- No Kubernetes requirement; Fargate-class simplicity preferred.
- No CI pipeline for generated code — Apex builds and verifies; it needs a registry push identity and a deploy call, nothing more.
- No user-facing console or portal — Apex is the UI; provisioning is a backend contract.

## 10. Questions we need answered to finalise Phase C design

1. Which compute, database, and identity patterns does the existing per-project stand-up already create? (Link or list per resource.)
2. Is there any existing programmatic trigger + outputs contract, or is stand-up console/manual today?
3. Shared ALB + host routing, or per-app ALB? Any existing wildcard certificate and apps subdomain?
4. Database model on offer: shared cluster with per-app database/user, Aurora Serverless, or per-app RDS?
5. Which identity pattern (§5) is the house standard?
6. What are the real provisioning times for preview and prod today?
7. Which of §8's quota limits bites first at ~1,000 apps?

---

Apex-side plan that consumes this: Phase A exit (generate + verify + Gate 2) is independent of your answers; the Phase C runtime work (about 6–8 weeks, targeting December) is blocked on §1 and §10. Answers to §10, even partial, unblock the design.

---

## Appendix A — Reviewed: apex-dochub `pipeline/main.tf` + `backend.tf`

Reviewed 2026-10-20 from copies pasted by the requestor (the Azure DevOps repo itself is behind a sign-in Apex could not pass). This file is the **per-service pipeline stack**: it creates the Azure DevOps build definition, one ECR repository, per-environment ECS execution roles, and Entra OIDC authentication via `../../modules/idp-auth`. It does **not** create the running application (no ECS service/task definition, ALB listener, database, app bucket, or log group in this file) — §A.3 asks where those live.

### A.1 What already exists and Apex will reuse as-is

| Pattern in the file | Why it matters |
|---|---|
| ADO build definition per service, YAML pipeline (`azure-pipelines.yml`), CI trigger on `main` | Generated apps can get CI the same way, if each app gets a repo (see A.2.6). |
| ECR repository per service, `scan_on_push = true` | Registry + image scanning per app, solved. |
| Per-env (dev/prod) ECS execution roles with scoped policies: Secrets Manager under `idp/<env>/<service>/*`, SSM under `idp/config/<env>/<service>/*` | The secrets namespace convention is exactly right and scales per app by changing `<service>`. |
| Bedrock invoke policy | Only for apps that call AI; make it opt-in per app (A.2.4). |
| Entra security group per service (`IDP-Access-<service>`) + `idp-auth` module with host-header convention `<service>.<env>.amergis-internal.dev` (prod also `<service>.amergis.com`) | **User authentication for generated apps is effectively solved.** Group membership controls who can open the app; host naming gives every app a predictable internal URL. This removes the biggest Phase C risk. |
| S3 remote state, encrypted, key per service: `services/<service>/pipeline/terraform.tfstate` | State isolation per service already works and extends to per-app keys. |

### A.2 What must change for generated apps (the ask, in priority order)

> Status update, 2026-10-20: the requestor confirms the platform pipeline already accounts for items **1–3** below (parameterised service identity, outputs document, callable trigger). Those are **covered, not asks**. Items 4–10 remain open, plus the confirmations in A.3. With 1–3 covered, Phase C integration is "call the pipeline and store its outputs," and the December runtime date no longer depends on platform building a contract from scratch.

1. ~~**Parameterise the service identity.**~~ *(Covered, per requestor 2026-10-20.)* `apex-dochub` is hard-coded in at least eight places (build definition name, ECR name, role names, secrets paths, host headers, group name). Generated apps need this stack (or the module behind it) instantiated with `service_name = <appId>`, plus `project_id`/`repository_id` supplied per app. One hand-edited copy per app will not survive 50 apps, let alone 500.
2. ~~**Outputs document (see §1).**~~ *(Covered, per requestor 2026-10-20 — Apex will consume the pipeline's existing output shape; field mapping to be agreed with the `provision-app` adapter.)* Current outputs are only `pipeline_id` and `oidc_security_group_id`. Apex needs, per app per env: app URL, ECR repository URL, execution/task role ARNs, secrets namespace, and auth group id — returned as JSON it can store. ECR repository URL is not even output today.
3. ~~**A callable trigger.**~~ *(Covered, per requestor 2026-10-20. Remaining detail for integration week: confirm the exact trigger inputs and completion signal — poll vs callback — and that a retried trigger with the same idempotency key cannot create a second stack.)*
4. **Split the task role from the execution role, and make Bedrock opt-in.** `bedrock_access` (and secrets access) sit on the *execution* role, which ECS uses to pull images and write logs; the running application should hold its own least-privilege **task role**. Generated CRUD apps need secrets + database only; AI-calling apps add Bedrock. One combined role per app is how an app ends up able to invoke Bedrock with `Resource = "*"`.
5. **Dynamic Entra group ownership/membership.** Group owners are eight hard-coded UPNs. A generated app's owner is whoever described it — owners and initial members must come from provisioning inputs, or previews and app handovers wait on a code change to this file. Also decide: one group per app (current pattern — fine at hundreds of apps, worth confirming at thousands) vs one group per project.
6. **A preview environment.** `envs = ["dev", "prod"]` is fixed and both are permanent. Apex previews need short-lived stacks (TTL ~48h, auto-destroy) that reuse the dev auth group rather than minting Entra groups per preview.
7. **Per-app ADO shape, decided once.** Does each generated app get its own ADO repository + build definition (this file's model), or do generated apps share one repo/pipeline parameterised by `appId`? The first matches the current pattern and multiplies repos; the second multiplies pipeline runs. Apex can work with either — it needs the answer before Phase C, because the generate step must know where code lands.
8. **Tags on everything.** Only the `auth` module call carries tags (`project/service/environment/managed-by`). ECR repo, IAM roles, and (wherever they live) ECS/DB resources need `appId`, `projectId`, `owner`, `environment`, `managedBy=apex-app-platform` for per-app cost reporting (§7).
9. **State backend hygiene at scale.** `mwx-qa-terraform-state` currently holds **prod** state for this stack, and the backend sets no lock table. At per-app scale, concurrent applies are a when, not an if: add DynamoDB locking (or S3 lockfile) and consider a non-QA bucket for prod app stacks. Per-app keys (`services/<appId>/...`) are fine.
10. **ECR immutability for deployable apps.** `image_tag_mutability = "MUTABLE"` + `force_delete = true` suits a dev service. Generated apps need digest-pinned deploys for rollback (§2): recommend immutable tags per app repo, keep `scan_on_push`.

### A.3 Still unknown — please confirm

- Where do the **runtime resources** live (ECS cluster/service/task definition, ALB + listener rules, RDS, app S3 bucket, CloudWatch log groups, alarms)? Not in `pipeline/main.tf`. If they are in each service's own repo, Apex's generated app template must instantiate the same modules — name them. If platform owns them centrally, §2–§4 of the main document apply to that stack instead.
- How is this pipeline stack itself applied today (which pipeline, manual approval, variable group for `entra_client_secret`)?
- Does `modules/idp-auth` create the ALB listener rule and target group, or only the OIDC authenticate action against a shared ALB?

### A.4 Net effect on the Apex plan

With A.2 items 1–3 done, Phase C stops being "build provisioning" and becomes "call provisioning": Apex's `provision-app` Playbook step triggers the pipeline, waits, stores the outputs, and deploys by digest. Authentication (A.1) and secrets conventions are already house standard, so they come off the risk list. The remaining genuinely new work sits with Apex (generate, verify, patch, rollback), as planned.
