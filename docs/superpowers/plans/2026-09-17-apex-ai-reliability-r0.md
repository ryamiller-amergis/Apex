# Apex AI Reliability R0 — Verified Production Baseline

**Captured:** 2026-09-17  
**Repository:** `ryamiller-amergis/Apex`  
**Branch:** `tbi/infra-changes`  
**Commit:** `417bf8bc` (matches `origin/main`)  
**Azure subscription:** `MSS-Production`  
**Terraform workspace:** `prd`

## Verdict

**R0 inventory and production database state reconciliation completed.
Terraform apply remains a separate approval.**

The live production topology differs materially from both the tracked Terraform
state and the earlier architecture inventory. Most importantly:

1. Production, staging, and repo-read use the Central US database
   `psql-apex-cus`.
2. Terraform state now owns `psql-apex-cus` and no longer owns the stopped
   `psql-apex-eus2`.
3. The refreshed production Terraform plan reports no changes.
4. Production's 10-minute worker-heartbeat mitigation remains missing from staging
   and from the GitHub deployment contract.
5. Production currently spans Central US, East US, East US 2, and North Central
   US rather than one region.

`psql-apex-eus2` may proceed through its separately approved decommission gate
after its retained backup and observation checks are complete.

## Repository baseline

- Working tree: clean
- Active branch: `tbi/infra-changes`
- HEAD: same commit as `origin/main`
- Checkout type: normal Git checkout, not a linked worktree

## Verified live inventory

### App Service

- App: `app-apex-prd`
- Region: Central US
- State: Running
- Plan: `plan-apex-prd-v2`
- SKU: P1v3
- Declared plan capacity: 3
- Production health path: `/api/health`
- Staging health path returned by Azure: unset
- WebSockets: enabled
- Production and staging each have a distinct system-assigned identity

### Active PostgreSQL

- Server: `psql-apex-cus`
- Region: Central US
- Version: PostgreSQL 16
- SKU: `Standard_D2ds_v5` (General Purpose)
- Storage: 128 GiB, P10, 500 IOPS
- `max_connections`: 859
- HA: disabled
- Backup retention: 30 days
- Geo-redundant backup: disabled
- Public network access: enabled
- Built-in PgBouncer: disabled
- Production `DATABASE_URL`: points to this server
- Staging `DATABASE_URL`: points to this server
- Recent one-hour metrics:
  - Active connections: approximately 36 average, 73 maximum
  - CPU: approximately 6.9% average, 10.6% maximum

These facts replace the earlier assumptions of `Standard_D2ads_v5`,
`max_connections=300`, 32 GiB, and 120 IOPS.

### Stopped legacy PostgreSQL

- Server: `psql-apex-eus2`
- Region: East US 2
- State: Stopped
- SKU: `Standard_D2ads_v5`
- Storage: 32 GiB, P4, 120 IOPS
- HA: disabled
- Backup retention: 7 days
- Public network access: enabled
- Before the approved reconciliation, Terraform state owned:
  - The server
  - Database `hub`
  - Firewall rule `allow-azure-services`

Terraform state no longer contains an address under this server.

Before it was stopped, Azure metrics from September 10–16 showed approximately
6.4–6.6 average active connections, with peaks of 8–10. Those connections must
be explained before deletion.

### Runtime settings

Production:

- `DB_POOL_MAX=40`
- `AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS=600000`
- `AI_RUNS_BACKGROUND_QUEUE_TTL_MS=3600000`
- `AI_RUNS_BACKGROUND_INFLIGHT_LIMIT=10`
- `AGENT_RUN_HARD_LIMIT_MS=7200000`
- `AI_RUNS_INTERACTIVE_RESERVED=4`
- `AI_RUNS_INTERACTIVE_BURST_MAX=12`

Staging:

- `DB_POOL_MAX=40`
- `AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS` is absent
- Other values above match production

GitHub's production environment contains no variable named
`AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS`. The production mitigation is therefore
not yet deployment-owned and can be lost during a slot swap.

### Service Bus

- Namespace: `sbns-apex-ai-prd`
- Region: East US
- SKU: Standard
- Zone redundant: true
- Public network access: enabled
- TLS minimum: 1.2
- Queue: `ai-runs-background`
- Duplicate detection: enabled
- Duplicate window: 30 minutes
- Sessions: disabled
- Lock duration: 5 minutes
- Max delivery count: 5
- Dead-letter on expiration: enabled

### Container Apps

All current Container Apps environments are in Central US and report zone
redundancy disabled.

`cae-apex-ai-prd`:

- No VNet integration
- Log Analytics destination configured
- Hosts the AI Job and combined interactive app

`caj-apex-ai-runs-prd`:

- 2 vCPU / 4 GiB
- Maximum executions: 10
- Event-trigger polling: 30 seconds
- Replica timeout: 3,600 seconds

`ca-apex-ai-interactive-prd`:

- 2 vCPU / 4 GiB per replica
- Minimum replicas: 4
- Maximum replicas: 16
- Running

`cae-apex-repo-read-prd`:

- Workload-profile environment
- Consumption profile plus dedicated `repo-read` D4 profile
- D4 profile minimum nodes: 1
- D4 profile maximum nodes: 2

`ca-apex-repo-read-d4-prd`:

- 4 vCPU / 16 GiB
- Minimum replicas: 1
- Maximum replicas: 1
- Running
- Runtime `DATABASE_URL` points to `psql-apex-cus`
- The AI Job and interactive app themselves expose no `DATABASE_URL`

### Managed Redis

- Resource: `redis-apex-ai-prd-v2`
- Region: North Central US
- SKU: `Balanced_B1`
- High availability: enabled
- Redundancy mode: `LR` (local redundancy, not zone redundancy)
- Clustering: `EnterpriseCluster`
- Protocol: encrypted
- Port: 10000

### Shared Storage

- Account: `stapexprdasync`
- Region: East US
- SKU: Standard LRS
- Public network access: enabled
- Anonymous Blob access: disabled
- TLS minimum: 1.2

### Key Vault and ACR

Key Vault:

- `kv-apex-ai-prd`
- Region: East US
- RBAC enabled
- Public network access enabled

ACR:

- `acrapexltprd`
- Region: Central US
- SKU: Basic
- Public network access enabled
- Zone redundancy disabled

### Logging

- Existing Log Analytics workspace: `law-apex-ai-prd`
- Region: East US
- The AI Container Apps environment already sends logs to Log Analytics
- Application Insights: `appi-app-apex-prd` in East US

The target plan should extend and cost-control this existing workspace rather
than assume no workspace exists.

## Terraform ownership findings

Terraform versions:

- Terraform: 1.15.8
- AzureRM provider: 3.117.1
- AzAPI provider: 2.12.0
- AzureAD provider: 3.9.0

State is local under Terraform workspace `prd`. It now owns the active Central
US PostgreSQL server, database `hub`, and its Azure-services firewall rule.

### Refreshed baseline plan

Command:

```text
terraform plan -no-color -detailed-exitcode -var-file=terraform.prd.tfvars
```

Result:

- Plan refresh failed while reading database `hub` on the stopped
  `psql-apex-eus2` server.
- Before the failure, Terraform showed:
  - 0 creates
  - 1 in-place update to repo-read secrets
  - 0 destroys
- The result is incomplete and must not be treated as an approval artifact.

### No-refresh comparison

Command:

```text
terraform plan -refresh=false -no-color -lock=false -var-file=terraform.prd.tfvars
```

Result:

- No changes
- This proves only that configuration matches stale local state.
- It does not prove configuration matches live production.

### Post-reconciliation plan

The approved state-only reconciliation:

- Backed up state under the existing ignored production state directory.
- Removed the three East US 2 PostgreSQL addresses from state.
- Imported the Central US server, database `hub`, and Azure-services firewall
  rule.
- Did not run `terraform apply`.
- Did not start, stop, resize, or delete an Azure resource.

The refreshed plan now reports:

```text
No changes. Your infrastructure matches the configuration.
```

The four obsolete autoscale values were removed from the local production
tfvars, so the plan no longer emits undeclared-variable warnings.

## Deployment-setting ownership

`.github/workflows/deploy.yml`:

- Runs migrations using the GitHub production `DATABASE_URL` secret.
- Verifies that the GitHub database hostname matches the current production
  App Service hostname before deployment.
- Writes the GitHub database URL to staging.
- Preserves production's existing sticky database URL rather than overwriting
  it during deployment.
- Writes AI queue, capacity, Redis, and interactive settings.
- Does not write `AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS`.

`infra/main.tf`:

- Defines `DATABASE_URL` from the Terraform-managed PostgreSQL resource for
  initial resource creation.
- Ignores later App Service `app_settings` drift.
- Marks `DATABASE_URL`, `DB_POOL_MAX`, and background queue TTL sticky.
- Does not mark the worker-heartbeat timeout sticky.

## Baseline formula

The retiring watcher load remains:

```text
watcher QPS =
active documents × App Service instances × queries per tick ÷ tick interval
```

The target control plane must instead satisfy:

```text
queries per sweep =
fixed queries
+ ceil(due rows ÷ batch size) × queries per batch

sweep QPS =
leader count × queries per sweep ÷ sweep interval
```

No target term may scale with documents multiplied by App Service instances.

## R0 blockers

1. Complete the separately approved old-server backup and decommission gate.
2. Make the 10-minute worker-heartbeat mitigation deployment-owned and
   slot-safe.
3. Recalculate database capacity gates using 859 connections, D2ds_v5,
   128 GiB, and 500 IOPS.
4. Reconcile the multi-region topology before claiming a single-region target.
5. Replace the local Terraform state backend only after the reconciled plan is
   clean.

## R0 exit criteria

- Active database and all known consumers verified
- Legacy database removed from Terraform ownership before deletion
- Sanitized pre/post Terraform action evidence captured
- No unexplained creates, replacements, or destroys in the refreshed plan
- Cost baseline recalculated from verified SKUs
- Architecture capacity decisions updated from verified facts
- Human approval recorded before any Terraform apply
