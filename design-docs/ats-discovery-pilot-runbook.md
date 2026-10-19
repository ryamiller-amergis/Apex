# ATS Discovery Pilot Runbook

Enables the ATS discovery interview for one pilot project. It does not enable it anywhere else. The existing interview skill stays listed first and remains the fallback.

The pilot project name is chosen by the Project Admin and the Product-Owner before these steps. This runbook calls that project `PILOT_PROJECT`. Substitute the real name. Do not apply these settings on any other project.

## Before you start

1. Merge `.cursor/skills/ats-discovery-interview/SKILL.md` to the branch named on the pilot project's skill settings row.
2. In Project Settings for `PILOT_PROJECT`, run Clone or Refresh. Wait until `repositoryCheckoutStatus` is `ready` and `repositoryCheckoutSha` is the merge commit.
3. Confirm a web-search MCP pill already used by another project. The repository does not store that pill. If none exists, stop. Research scenarios cannot pass without `interviewWebMcp`. The ATS skill asks vision (Decision 1) and baseline staffing model/system boundary (Decision 2), then runs a **market benchmark** for the next lifecycle area only (at most two searches). The market findings grow as later areas are asked. Without web research, C6 on the completion rubric fails unless every market row is marked unavailable.
4. One Manager owns each interview thread and types for the leaders in the room. Other people may attend. They cannot send messages on a thread they do not own.

## Settings on the default row

Edit the existing Project Settings screen. Do not add a screen or a second settings row.

| Setting | Value |
|---------|-------|
| `interviewSkillOptions[0]` | The existing interview option, unchanged. It stays the default. |
| `interviewSkillOptions[1]` | `key`: `ats-discovery`. `friendlyName`: `ATS Discovery Interview`. `path`: `.cursor/skills/ats-discovery-interview/SKILL.md` (same path form as the existing option, without a leading slash). `wantsDesignPrototype`: `false`. `wantsTestCases`: `false`. Add `model` only if the pilot needs a stronger model than `interviewModel`. |
| `interviewWebResearchEnabled` | `true` |
| `interviewWebMcp` | The web-search MCP pill from step 3. Secrets stay in `${VAR_NAME}` references in the server environment. Do not paste secrets into the skill or into this runbook. |

`interviewWebMcp` is saved only while research is on. Turning research off and saving erases the pill. Research then applies to every interview option on this row, including the fallback skill.

## Order of checks

1. Merge the skill, then refresh the checkout, then save the settings above.
2. As a Manager in `PILOT_PROJECT`, start an interview. The skill dropdown lists the existing option first and ATS Discovery Interview second (`interview-skill-select`).
3. Start once with each option. The existing option still runs. The ATS option asks for leadership's vision and shows no Discovery / Delivery / Technical phase bar.
4. Open a second project. Neither change appears there. The ATS option is absent, and that project's research switch is unchanged.
5. Ask for a vendor comparison on one open scope decision (VT-39). The agent should search and answer. If it refuses with the general public-data refusal, stop and log a runtime gap. Do not change the skill to bypass scope policy.

## Stale path

If the saved ATS path points at a file the checkout does not hold, the server tells the agent it could not load that path and to inform the user that the skill file is missing (`chatAgentService` skill pre-fetch). The Manager sees that error in the chat and can start again with the existing interview option. Record the exact error text in the pilot results. A live click-through of this error was not run while authoring the skill.

## Removal

Delete the ATS entry from `interviewSkillOptions` and save. Leave the skill file in the repository so open threads can still load it.

Interviews already in progress stay readable and still accept a message from the thread owner. They lose web research, and model and effort fall back to the interview defaults, because the thread path is no longer listed. New interviews in `PILOT_PROJECT` no longer offer the ATS option. Other projects were never changed.

## Permissions

| Action | Who |
|--------|-----|
| Change these settings | Project Admin (`admin:roles`). Anyone else receives 403 and the row stays as it was. |
| Start or continue | BA, Manager, or Product-Owner group, with `interviews:manage`. The thread owner sends messages. |
| View only | `interviews:view` can open the interview. A message from someone who does not own the thread is refused with 404 "Thread not found". The message count does not change. |
| Mark complete | The interview author, and only after a reply that shows `Completion rubric: PASS`. |

## What this runbook does not change

No new permission, API, table, or screen. Wider use waits until the Product-Owner records a pass in `design-docs/ats-discovery-pilot-results.md`.
