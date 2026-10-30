# MaxView Resource Catalog

Use this only as a **resource identity and routing aid** — it tells you *where* things live (which apps, resources, environments, and surfaces exist). It intentionally does **not** tell you *how* to query them: choose your own read-only queries, tables, schemas, fields, and query paths, and verify them live. Do not assume any schema or table named nearby is correct; discover and confirm it yourself.

Do not infer an outage, telemetry gap, or clean bill of health from this catalog alone. The catalog tells you where to look; the incident evidence tells you what happened.

## Discovery First

When a mapping is missing, stale, or ambiguous, discover the likely resource. Do not enumerate every resource unless the symptom is genuinely unclear:

- Enumerate App Insights: `az resource list --resource-type "microsoft.insights/components" --query "[].{name:name,resourceGroup:resourceGroup,location:location}" -o table`
- Enumerate Log Analytics: `az resource list --resource-type "microsoft.operationalinsights/workspaces" --query "[].{name:name,resourceGroup:resourceGroup,location:location}" -o table`
- Enumerate App Services: `az resource list --resource-type "Microsoft.Web/sites" --query "[].{name:name,resourceGroup:resourceGroup,kind:kind}" -o table`
- Enumerate Service Bus namespaces: `az resource list --resource-type "Microsoft.ServiceBus/namespaces" --query "[].{name:name,resourceGroup:resourceGroup,location:location}" -o table`
- Search repo source-of-truth paths before assuming ownership:
  - `infra/azure-cloud/iac/environments/**`
  - `build/deployment-workflow/**`
  - `integration/build/**`
  - `services/build/**`
  - `docs/docs/cloud-networking/**`
  - app host `appsettings*.json`, but never copy secrets into output

## Shared Observability and Network

| Purpose | Known resource |
|---------|----------------|
| Shared Log Analytics workspace for Front Door/WAF/firewall | `mv-ss-monitor-law` |
| Shared workspace ID | `0879fb7a-59a8-42f5-b2e4-ad2eb8703639` |
| Shared subscription | `MSS-VSTS` / `42852a8c-db05-4d79-8e44-88714242c4a7` |
| Azure Firewall | `mv-ss-east-afw` |
| Dev app integration subnet source prefix | `10.90.2.` |
| Test app integration subnet source prefix | `10.90.3.` |
| Dev Front Door host | `maxview-dev` |
| Test Front Door host | `maxview-test` |

Source files:

- `infra/azure-cloud/iac/environments/shared/main.tf`
- `infra/azure-cloud/iac/environments/shared/variables.tf`
- `docs/docs/cloud-networking/firewall-and-routing.md`
- `docs/docs/cloud-networking/architecture.md`
- `docs/docs/cloud-networking/ip-reference.md`

## Cloud MaxHub

| Env | App Service | Resource group | App Insights | Log Analytics | Role |
|-----|-------------|----------------|--------------|---------------|------|
| dev | `maxhub-dev-eus-webapp` | `maxview-dev-east-rg` | `cloud-maxhub-dev-east-appi` | `maxview-dev-east-log` | `Cloud-MaxHub-API` |
| test | `maxhub-test-eus-webapp` | `maxview-test-east-rg` | `cloud-maxhub-test-east-appi` | `maxview-test-east-log` | `Cloud-MaxHub-API` |
| prod | Resolve live; prod cloud MaxHub is not fully codified in current repo docs | Resolve live | Resolve live | Resolve live | Resolve live |

Notes:

- `cloud-maxhub-{env}-east-appi` holds **Cloud MaxHub API telemetry only** — it is not MaxView app login/UI telemetry. For MaxView user-facing or login incidents, use `maxview-{env}-east-appi` (see the Main TimeClock section). This component is newer and may contain only recent data; do not read that as a MaxView telemetry gap.
- App Insights uses public Azure Monitor ingestion through firewall egress.
- `WEBSITE_DNS_SERVER` should point to the DNS resolver (`10.90.0.196`) for cloud MaxHub.
- Do not link `privatelink.monitor.azure.com` unless a complete AMPLS design is intentionally deployed.

Source files:

- `infra/azure-cloud/iac/environments/dev/app/variables.tf`
- `infra/azure-cloud/iac/environments/dev/app/main.tf`
- `infra/azure-cloud/iac/environments/test/app/variables.tf`
- `infra/azure-cloud/iac/environments/test/app/main.tf`
- `infra/azure-cloud/iac/environments/*/maxhub-monitor/variables.tf`
- `build/deployment-workflow/mv-application-dev.yml`
- `build/deployment-workflow/templates/stages/monitoring/maxhub-cloud-monitoring.yml`

## Main TimeClock / ClientApp / WebApp

| Surface | Repo roots | Runtime notes |
|---------|------------|---------------|
| Main TimeClock ASP.NET app | `src/Maxim.TimeClock.Web/`, `src/Maxim.TimeClock.Infrastructure/`, `src/Maxim.TimeClock.Core/` | Primary MVC/API host for TimeClock and ClientApp. Often deployed through VM/IIS workflow rather than the cloud MaxHub App Service path. |
| Legacy ClientApp SPA | `src/Maxim.TimeClock.Web/ClientApp/` | Frontend errors may appear in browser telemetry, server logs, API failures, or Playwright reports depending on instrumentation. |
| New WebApp | `src/Maxview.WebApp/` | Uses JS Application Insights packages; resolve concrete App Insights resource by environment before querying. |

### MaxView app telemetry resources (login / `Auth/Login` / UI live here)

This is where MaxView user-facing and login telemetry lives — **not** in any MaxHub App Insights. Verify live before relying on any entry.

| Env | MaxView app App Insights | Log Analytics workspace | Resource group | Host |
|-----|--------------------------|-------------------------|----------------|------|
| dev | `maxview-dev-east-appi` (verify live) | `maxview-dev-east-log` | `maxview-dev-east-rg` | `dev.mymaxview.com` |
| test | `maxview-test-east-appi` | `maxview-test-east-log` | `maxview-test-east-rg` | `test.mymaxview.com` |
| prod | `maxview-prod-east-appi` | `maxview-prod-east-log` (verify live) | `maxview-prod-east-rg` (verify live) | `mymaxview.com` |

Do not confuse the three App Insights components that exist per environment:

- `maxview-{env}-east-appi` — **MaxView main app** (TimeClock / ClientApp / WebApp). Use this for MaxView login and user-facing incidents.
- `maxhub-{env}-east-appi` — legacy MaxHub API.
- `cloud-maxhub-{env}-east-appi` — Cloud MaxHub API (newer; may only contain recent data). Its "recent-only" data is **not** evidence that MaxView telemetry is missing — you are simply looking at the wrong component.

The MaxView app App Insights is workspace-based, so its data is also reachable through the `maxview-{env}-east-log` Log Analytics workspace. If one access point looks empty for a busy app, treat that as a wrong-component/wrong-path signal and cross-check the other before concluding anything.

Discovery:

- Search deployment variable groups/pipeline logs for app pool, IIS path, host, and App Insights names.
- Enumerate App Insights and match candidate resources to the app/environment by role, request URLs, and exception signatures for `Maxim.TimeClock`, `TimeClock`, `MaxView`, or affected hostnames — using queries you construct and verify yourself.
- For server-side issues, inspect API controller/operation/service code paths after telemetry identifies route or stack trace.

Auth/login dependency notes:

- `src/Maxim.TimeClock.Web/Controllers/AuthController.cs` handles `GET/POST Auth/Login`.
- Legacy login calls `IUamService.AuthenticateUserAsync`; Clerk migration/login flows can also validate through UAM and MaxHub.
- `src/Maxim.TimeClock.Infrastructure/Services/UamService.cs` uses `AppSettings:UAM_BaseUrl` and calls UAM token/authenticate endpoints.
- If users see "internal server error" during login, investigate downstream dependency failures early. The MaxView request may return `200` or `302` while a downstream UAM dependency returns `500`.
- UAM dependency targets commonly include `sfuam.<env>.maximstaffing.com`; AccessControl targets commonly include `sfaccesscontrol.<env>.maximstaffing.com`.

Source files:

- `build/deployment-workflow/templates/common/deployment/mv-deploy-workflow-parallel.yml`
- `build/deployment-workflow/templates/stages/build/mv-build-workflow.yml`
- `src/Maxim.TimeClock.Web/Program.cs`
- `src/Maxim.TimeClock.Web/Controllers/AuthController.cs`
- `src/Maxim.TimeClock.Infrastructure/Services/UamService.cs`
- `src/Maxview.WebApp/package.json`
- `infra/azure-cloud/iac/environments/test/app/variables.tf` (distinguishes `maxview-test-east-appi`, `maxhub-test-east-appi`, `cloud-maxhub-test-east-appi`, and workspace `maxview-test-east-log`)
- `infra/azure-cloud/iac/environments/prod/monitor/variables.tf` (`maxview-prod-east-appi`)
- `docs/docs/cloud-networking/ip-reference.md` (per-environment resource-group and App Insights/workspace inventory)

## On-Prem / IIS MaxHub

| Surface | Repo roots | Runtime notes |
|---------|------------|---------------|
| MaxHub Web API | `src/MaxHub/` | Integration-facing API; exists both as newer cloud container flow and legacy/IIS deployment flow. |

App Insights (legacy / on-prem MaxHub API):

| Env | Legacy MaxHub API App Insights | Resource group | Log Analytics workspace |
|-----|--------------------------------|----------------|-------------------------|
| dev | `maxhub-dev-east-appi` | `maxview-dev-east-rg` | `maxview-dev-east-log` |
| test | `maxhub-test-east-appi` | `maxview-test-east-rg` | `maxview-test-east-log` |
| prod | `maxhub-prod-east-appi` (verify live) | `maxview-prod-east-rg` (verify live) | `maxview-prod-east-log` (verify live) |

This is a **different** component from the containerized Cloud MaxHub (`cloud-maxhub-{env}-east-appi`, see the Cloud MaxHub section). For on-prem/IIS MaxHub incidents use `maxhub-{env}-east-appi`; for the App Service container flow use the cloud component.

Discovery:

- For cloud symptoms, prefer the Cloud MaxHub mapping above.
- For IIS/on-prem symptoms, inspect MaxHub deployment pipeline variables and confirm the legacy component live.
- Deployment paths and app pools appear in MaxHub and main deployment pipeline templates.

Source files:

- `src/MaxHub/`
- `build/maxhub/**`
- `build/deployment-workflow/templates/common/deployment/maxhub-pipeline-env-deploy.yml`
- `build/deployment-workflow/templates/common/deployment/mv-deploy-workflow-parallel.yml`
- `infra/azure-cloud/iac/environments/test/app/variables.tf` (`maxhub-test-east-appi` as `application_insights_api_name`)
- `docs/docs/cloud-networking/ip-reference.md` (`maxhub-dev-east-appi` = Legacy MaxHub App Insights)

## TimeClock Integration

| Surface | Repo roots | Runtime notes |
|---------|------------|---------------|
| TimeClock Integration host | `integration/TimeClockIntegration/` | .NET worker/Windows service, MassTransit Azure Service Bus consumers, RecruitCare and blob/file workflows. |

Known dependencies:

- Service Bus namespaces follow `sbns-maxview-{env}-eastus-001` in checked-in config.
- Storage accounts follow `stmaxview{env}eastus001` in checked-in config.
- App Insights: this host writes to its **own dedicated Application Insights component**, set per environment via `ApplicationInsights:ConnectionString` in `appsettings.{env}.json`. Only an instrumentation-key connection string is committed (secret — do not print it); no friendly resource name is checked in. Resolve the live component per environment by matching that connection string / ApplicationId in Azure, or by the `TimeClockIntegration` cloud role name.

Discovery:

- Look in App Insights telemetry for role names/messages containing `TimeClockIntegration`, `TimeClock Integration`, MassTransit consumer names, queue/topic names, and RecruitCare dependency targets — using queries you construct and verify yourself.
- Inspect Service Bus queues/subscriptions read-only when queue backlog, dead-lettering, or consumer failures are suspected.

Source files:

- `integration/TimeClockIntegration/src/Maxim.TimeClockIntegration.Host/Program.cs`
- `integration/TimeClockIntegration/src/Maxim.TimeClockIntegration.Host/appsettings*.json`
- `integration/build/template/**`

## Credentialing Integration

| Surface | Repo roots | Runtime notes |
|---------|------------|---------------|
| Credentialing Integration workers | `services/CredentialingIntegration/` | .NET worker/Windows service for RC CDC polling, MaxView updates, and MassTransit publishing. |

Known dependencies:

- App Insights: this worker writes to its **own dedicated Application Insights component**, set per environment via `ApplicationInsights:ConnectionString` in `appsettings.{env}.json`. Only an instrumentation-key connection string is committed (secret — do not print it); no friendly resource name is checked in. Resolve the live component per environment by matching that connection string / ApplicationId in Azure, or by the `CredentialingIntegration` / `BackgroundServices` cloud role name.
- Service Bus namespaces follow `sbns-maxview-{env}-eastus-001` in checked-in config.
- Primary data dependencies include RecruitCare CDC and MaxView database operations.

Discovery:

- Query App Insights for role names/messages containing `CredentialingIntegration`, `BackgroundServices`, CDC capture instance names, handler names, MassTransit publish failures, and SQL dependency failures.
- For CDC incidents, correlate telemetry with `CdcProcessingState`, capture instance names, and deployment scripts.

Source files:

- `services/CredentialingIntegration/README.md`
- `services/CredentialingIntegration/BackgroundServices/`
- `services/CredentialingIntegration/BackgroundServices/appsettings*.json`
- `services/build/**`

## Other MaxView Umbrella Surfaces

| Surface | Repo roots | App Insights | Discovery focus |
|---------|------------|--------------|-----------------|
| UAM | `services/Uam/` | No dedicated App Insights found in repo. UAM failures are usually seen as **caller dependency telemetry** from MaxView to `sfuam.<env>.maximstaffing.com`. Resolve live if a dedicated component exists. | Auth/user account incidents, JWT/token issuance, legacy account management. |
| AccessControl | `services/AccessControl/` | No dedicated App Insights found in repo. Usually seen as **caller dependency telemetry** to `sfaccesscontrol.<env>.maximstaffing.com`. Resolve live if a dedicated component exists. | Login/session MVC portal and cookie-auth issues. |
| Jobs | `jobs/` | No dedicated App Insights found in repo (Windows service jobs; logging via job logs/DB). Resolve live if a component exists. | Scheduled Windows service failures, timecard PDF/email/GPS/auto-checkout jobs. |
| Health dashboard | `health/` | Frontend `mv-health-frontend-ai`, backend `mv-health-backend-ai`, in resource group `mv-health-monitor-rg` (apps `mv-health-prod-web` / `mv-health-prod-api`). | Health monitor app availability and probe failures. |
| Mobile app | `mobile-App/` | Uses Application Insights JS (`mobile-App/libs/analytics/providers/appInsights.ts`) via a connection string — resolve the live component (no friendly name committed). Also emits to Firebase, Pendo, and PostHog. | EAS updates, mobile crashes, Clerk auth, React Native telemetry. Use mobile-specific skills when the incident is mobile-first. |

Source files:

- `infra/azure-cloud/iac/environments/mv-health/monitor/variables.tf` (`mv-health-frontend-ai`, `mv-health-backend-ai`, `mv-health-monitor-rg`)
- `infra/azure-cloud/iac/environments/mv-health/app/variables.tf` (`mv-health-prod-web`, `mv-health-prod-api`)
- `mobile-App/libs/analytics/providers/appInsights.ts`
- `integration/TimeClockIntegration/src/Maxim.TimeClockIntegration.Host/appsettings.*.json` (integration App Insights connection string — contains secrets, do not print)
- `services/CredentialingIntegration/BackgroundServices/appsettings.*.json` (credentialing App Insights connection string — contains secrets, do not print)

## Reporting Unknowns

If a resource cannot be confidently mapped, say so and show:

- What was searched.
- Candidate resources found.
- Why the candidate was or was not selected.
- What credential, portal, pipeline variable group, or team knowledge is needed to finish mapping.
