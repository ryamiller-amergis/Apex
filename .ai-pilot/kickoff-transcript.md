# ADR interview transcript — Cloud Agent launch and delivery contract

Date: 2026-10-12
Status: ready for ADR generation
Proposed slug: `cloud-agent-skill-launch`

## Problem and scope

Apex Cloud Agent runs start from My Work with one project development skill and a delivery contract that does not match the existing My Work session path. Users, including people who are not developers, also need a guided way to start from Agent Home.

This ADR decides how a run is chosen and confirmed, and how an implementation run names its branch, writes its pull request, links the work item, moves its state, and tags `ai-code`.

### In scope

- My Work confirmation before Start. Show the work item title, id, and type, the auto-selected skill, and the model. The skill is a dropdown of the project's skill-catalog skills. The user may change it. Do not show why the skill was selected.
- Built-in work-item-type skill selection. No new administrator mapping screen and no user-configurable naming workflow.
- Agent Home guided launcher with plain-language choices: Investigate a problem, Draft or review content, Analyze information, Implement a change, Run a project-specific workflow.
- One shared server helper for branch name, pull-request title, pull-request description, work-item link, state transition, and the `ai-code` tag. Cloud Agent calls that helper. The agent does not invent those values.
- The same status, activity, cancellation, and results experience for both entry points.
- Resume and retry keep the skill and model from the started run.

### Out of scope

- A settings screen for skill mappings, branch patterns, pull-request text, or tags.
- A user-visible explanation of why a skill was chosen.
- Asking the Cloud Agent to choose the branch name, pull-request title, or pull-request description.
- New skill names for Draft or Analyze.

## Repository evidence

Facts verified in this repo:

- `POST /api/dev-workbench/cloud-agent/start` in `src/server/routes/devWorkbench.ts` requires `workItemId` and `project`. It loads `System.WorkItemType` and passes it into `startCloudAgentRun` for eligibility. It does not use the type to choose a skill.
- `resolveDevelopmentSettings` in `src/shared/utils/developmentKickoff.ts` uses `developmentSkillPath`, or `.cursor/skills/dev-orchestrator/SKILL.md` when that is empty, and `developmentModel`, or `composer-2.5`.
- `buildCloudAgentPrompt` in `src/server/services/cloudAgentService.ts` already loads work-item context through `buildLocalDevContext`, then prefixes that single development skill.
- The queued run stores `skillPath`, `model`, and `skillName` on `agent_runs.execution_snapshot`. It does not store an override flag. A new start resolves the project development skill again.
- Local My Work branches come from `createFeatureBranch` in `src/server/services/repoCheckoutService.ts`: `feature/apex-<workItemId>-<title-slug>`.
- Cloud Agent branches come from `branchNameFor` in `src/server/services/cursorContainerCliService.ts`: `feature/apex-<workItemId>-<random hex>`.
- Local pull requests come from `createSessionPr` in `src/server/routes/devWorkbench.ts`. Title: `[APEX] <branch without the feature/ prefix>`. Description: `Automated implementation via APEX dev workbench.` plus the `AB#` work-item reference. It then transitions the work item and adds the pull-request hyperlink.
- Cloud pull requests come from `buildCloudAgentPullRequestText` in `src/server/services/cloudAgentPullRequest.ts`. Title: `AB#<id>: <title>`. Description starts with `Automated implementation via Apex cloud development.`
- Neither path calls `addTagToWorkItem` with `ai-code`. That tag is read for analytics in `src/server/services/aiCapabilityLadderService.ts` and `src/server/services/azureDevOps.ts`.
- Project skills are the catalog from the configured skill repo (`listSkills` in `src/server/services/skillCatalog.ts`). There is no second approval list.
- Agent Home has no Cloud Agent launcher. The existing flag is `my-work-cloud-agent`.

## Constraints

- Server-side rules. The user said not to add a new UI or a user-configurable workflow for naming, tags, or skill mapping.
- The confirmation screen and the Agent Home launcher are start screens, not settings.
- The user does not want a "why this skill" explanation. The dropdown is the override.
- Implementation runs must use the existing My Work branch and pull-request contract. Apex computes the values and passes them in.
- Non-development guided workflows must use plain language and must be able to start without a work item.
- Implementation launches, from My Work or from Implement a change, require a work item so the shared helper can run.
- Security and assignment checks already on Cloud Agent start stay in place (assigned-to caller, Azure DevOps project, feature flag).

## Decision drivers

- A person should get the project's skill without knowing skill paths or maintaining a mapping table.
- Developers should keep the work-item context, branch name, pull-request text, link, state change, and `ai-code` tag that My Work already uses.
- Non-development work should not require Azure DevOps knowledge.
- The two implementation paths must not keep two copies of the branch and pull-request rules.
- The user's dropdown choice must be what starts, and what resume and retry use.

## Considered options

### Pre-launch only, leave Cloud Agent branch and pull-request builders as they are

Rejected. The user said kickoff must follow the current process. Branch names, pull-request titles, and descriptions already differ, and `ai-code` is never written. Prompt instructions cannot fix values Apex already sets.

### Prompt-only delivery rules

Rejected for the same reason. `branchNameFor` and `buildCloudAgentPullRequestText` already own those strings.

### Copy the My Work strings into `cloudAgentService` and leave `createSessionPr` alone

Rejected. The user said to extract the existing functions and call them from both paths so the rules are not duplicated.

### Require a work item for every guided launch

The user selected this, then reversed it after the conflict with the request was called out. Rejected. Investigate, Draft, and Analyze must be able to start with no work item.

### Never require a work item

Rejected. Implement a change and My Work need a work item for the shared delivery helper.

### Invent guided skill names (`content-review`, `technical-analysis`) or reuse project-settings pipeline slots as a new map

Rejected. The user said to auto-find the skill and to stay with current skill configuration for the fallback. Do not add skill names that are not in the work-item map.

### Re-resolve the skill on every retry

Rejected. The acceptance criteria say resume and retry preserve the original configuration. The dropdown choice would be lost.

### New `agent_runs` columns for the skill choice

Not selected. The execution snapshot already freezes `skillPath` and `model` for the run. New columns would widen the schema for the same fact.

### Show a selection reason on the confirmation screen

Rejected by the user. The original request asked for it. This decision drops that visible reason.

## Selected option

### Skill selection

My Work auto-selects one skill from the work-item type Apex already loaded:

| Work item type | Skill name |
| --- | --- |
| Bug | `bug-fix` |
| Product Backlog Item (PBI) | `development` |
| Technical Backlog Item (TBI) | `technical-development` |
| Feature | `development-orchestrator` |

Resolve the name against the project skill catalog. If the type is unknown, or that skill is not in the catalog, use today's development skill: `developmentSkillPath`, or `.cursor/skills/dev-orchestrator/SKILL.md` when unset. The model is `developmentModel`, or `composer-2.5` when unset.

The confirmation screen shows the work item title, id, and type, the skill, and the model. The skill control is a dropdown of catalog skills. Changing it is optional. There is no reason text.

Guided launches that have no work item propose today's development skill and use the same dropdown. Implement a change requires an existing work item first; once that item is attached, selection uses the type map above. Run a project-specific workflow does not auto-select; the user picks from the catalog.

The server accepts only a skill from that catalog. One skill per run.

Save the chosen skill path, skill name, model, and an override flag on the existing `agent_runs.execution_snapshot`. Resume and retry copy that snapshot. They do not re-read project skill settings. Do not persist a user-facing reason.

Both entry points stay behind the existing `my-work-cloud-agent` flag.

### Delivery contract

Extract the My Work branch name and pull-request metadata from `createFeatureBranch` and `createSessionPr` into one shared helper. `cloudAgentService` calls it. Do not leave a second copy in `branchNameFor` or `buildCloudAgentPullRequestText`.

For a run with a work item, Apex computes and passes:

- Branch: `feature/apex-<workItemId>-<title-slug>`
- Pull-request title: `[APEX] <branch without the feature/ prefix>`
- Pull-request description: the current dev-workbench description, including the `AB#` reference
- Work-item link and state transition, as `createSessionPr` does today
- The `ai-code` tag, via the existing `addTagToWorkItem` API

The Cloud Agent does not invent those values. This tag write is new. No current server path adds `ai-code`.

Investigate a problem, Draft or review content, and Analyze information do not call the helper. They do not open a pull request, link a work item, change state, or add `ai-code`. They still use the Cloud Agent run status, activity, cancellation, and results experience.

## Positive consequences

- My Work starts on a skill that matches the work-item type, and the user can change it without an admin screen.
- Implementation runs from My Work and from Implement a change produce the same branch, pull request, link, state, and `ai-code` tag.
- Non-development workflows can start from Agent Home in plain language, without a work item.
- Retry cannot silently switch skills if project settings change later.

## Negative consequences

- The visible "why this skill" line from the original request is dropped.
- `ai-code` becomes a new write on every implementation pull request, including local My Work once it uses the shared helper. Analytics that count that tag will include these runs.
- Cloud Agent branch names change shape. A rerun of the same work item continues `feature/apex-<id>-<slug>` instead of a new random suffix. That matches local My Work and can collide with an existing branch on purpose, because local checkout already continues an existing remote branch.
- Guided non-implementation runs have no pull request. Their result lives in the run activity and results view.
- Projects whose catalogs do not contain `bug-fix`, `development`, `technical-development`, or `development-orchestrator` will fall back to the development skill until those skills exist.
- Implement a change cannot start until the user attaches a work item. The picker itself is not specified beyond "an existing work item."

## Unresolved risks

- The work-item picker on Agent Home for Implement a change is unspecified. It must not become a new admin screen.
- Guided non-implementation runs still need a prompt and a place to put the user's goal and optional context. They do not get the implementation delivery helper.
- Adding `ai-code` on the local My Work path changes analytics input. Confirm that local sessions should be tagged too, because the shared helper serves both callers.
- Skill-name matching is by catalog skill name. A project that stores the same procedure under a different folder name will fall back.

## User statements (material)

- Cloud Agent kickoff should follow the current process: reach ADO for the work item, and make branch names, pull-request titles, and descriptions match the current flow. It should add the `ai-code` tag.
- Do not add a new UI or a user-configurable workflow for this. Keep it server-side. Reuse the existing My Work naming and pull-request functions. Call them from `cloudAgentService`. Apex computes the values. The agent does not invent them. Do not duplicate the rules.
- Keep the My Work confirmation screen and the Agent Home guided launcher. No admin or naming settings UI.
- Investigate, Draft, and Analyze can start with no work item and do not open a pull request or tag anything. Implement a change, and every My Work launch, require a work item and use the shared helper.
- My Work auto-finds the skill. The user may override it from a dropdown. Do not show why the skill was selected.

## Assumptions

- "Approved project skill" means a skill returned by the project skill catalog, not a new allow-list and not a project-settings pipeline slot.
- Guided launches without a work item propose the current development skill.
- The model stays on the confirmation screen because the original request includes it. The user did not reject it. They rejected the reason text.
- One skill is selected per run.
- Storage is the existing execution snapshot because that object already freezes the skill and model. The user did not choose between snapshot fields and new columns. They required that the dropdown choice be the one that runs.

## References

- `src/server/routes/devWorkbench.ts` — Cloud Agent start, `createSessionPr`, `createFeatureBranch` call
- `src/server/services/cloudAgentService.ts` — `buildCloudAgentPrompt`, `persistQueuedRun`
- `src/server/services/cloudAgentPullRequest.ts` — current Cloud Agent pull-request text
- `src/server/services/cursorContainerCliService.ts` — `branchNameFor`
- `src/server/services/repoCheckoutService.ts` — `createFeatureBranch`
- `src/shared/utils/developmentKickoff.ts` — `resolveDevelopmentSettings`
- `src/server/services/localDevContextService.ts` — work-item context pack
- `src/server/services/skillCatalog.ts` — `listSkills`
- `src/server/services/azureDevOps.ts` — `addTagToWorkItem`
- `src/server/db/schema.ts` — `agent_runs.execution_snapshot`
- Feature flag `my-work-cloud-agent`
