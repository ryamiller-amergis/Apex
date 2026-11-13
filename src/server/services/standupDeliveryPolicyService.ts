import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appUsers,
  standupActionProposals,
  standupSessions,
} from '../db/schema';
import type {
  ParticipantPreparedBrief,
  StandupActionProposal,
  StandupTeamPulse,
} from '../../shared/types/standup';
import type { ChatThreadKickoff } from '../../shared/types/chat';
import {
  evaluateCalendarItemHealth,
  evaluateParticipantBrief,
  extractWorkItemIds,
  normalizeDeliveryModel,
  normalizeGoalSource,
  resolveStandupPolicy,
  synthesizeTeamPulse,
  type EvaluateCalendarHealthOptions,
  type EvaluateParticipantBriefInput,
  type EvidencePipelineFailure,
  type EvidencePullRequest,
  type EvidenceWorkItem,
  type SynthesizeTeamPulseInput,
} from '../../shared/utils/standupDeliveryPolicy';

export {
  evaluateCalendarItemHealth,
  evaluateParticipantBrief,
  extractWorkItemIds,
  normalizeDeliveryModel,
  normalizeGoalSource,
  resolveStandupPolicy,
  synthesizeTeamPulse,
  type EvaluateCalendarHealthOptions,
  type EvaluateParticipantBriefInput,
  type EvidencePipelineFailure,
  type EvidencePullRequest,
  type EvidenceWorkItem,
  type SynthesizeTeamPulseInput,
};

/**
 * Formats a compact markdown digest of a participant's pre-computed brief
 * for injection into the AI standup coach system prompt.
 */
export function formatPreparedBriefForPrompt(
  brief: ParticipantPreparedBrief,
): string {
  const lines: string[] = [
    `Delivery Model: ${brief.deliveryModel}`,
    `Team Goal: ${brief.teamGoal ?? '(none set)'}`,
  ];

  if (brief.accomplishedSinceLast.length > 0) {
    lines.push('', 'Accomplished Since Last Standup:');
    for (const item of brief.accomplishedSinceLast) {
      const prefix = item.workItemId
        ? `#${item.workItemId}${item.workItemType ? ` · ${item.workItemType}` : ''} — `
        : item.prId
        ? `PR !${item.prId} — `
        : '';
      lines.push(`- ${prefix}${item.title} (${item.evidence})`);
    }
  }

  if (brief.priorCommitments.length > 0) {
    lines.push('', 'Prior Standup Commitments:');
    for (const commitment of brief.priorCommitments) {
      lines.push(`- [${commitment.status.toUpperCase()}] ${commitment.summary} — ${commitment.note}`);
    }
  }

  if (brief.detectedExceptions.length > 0) {
    lines.push('', 'Detected Exceptions Requiring Verification:');
    for (const ex of brief.detectedExceptions) {
      lines.push(`- [${ex.severity.toUpperCase()}] (${ex.kind}) ${ex.message}`);
    }
  }

  if (brief.suggestedToday.length > 0) {
    lines.push('', 'Suggested Focus Items Today:');
    for (const item of brief.suggestedToday.slice(0, 6)) {
      const flags = item.riskFlags.length > 0 ? ` (${item.riskFlags.join(', ')})` : '';
      lines.push(`- #${item.workItemId} · ${item.workItemType} — ${item.title} [${item.state}]${flags}`);
    }
  }

  if (brief.openFollowups.length > 0) {
    lines.push('', 'Open Standup Follow-ups:');
    for (const followup of brief.openFollowups) {
      lines.push(`- ${followup.title} (${followup.sessionDate})`);
    }
  }

  return lines.join('\n');
}

/**
 * Loads a standup session with its config, participants, and staged proposals,
 * synthesizes `StandupTeamPulse`, and persists it on `standup_sessions.team_pulse`.
 */
export async function recomputeSessionTeamPulse(
  sessionId: string,
  decisionsNeeded?: string[],
): Promise<StandupTeamPulse | null> {
  if (!db.query.standupSessions?.findFirst) return null;

  const session = await db.query.standupSessions.findFirst({
    where: eq(standupSessions.id, sessionId),
    with: {
      config: true,
      participants: true,
    },
  });
  if (!session || !session.config) return null;

  let proposals: StandupActionProposal[] = [];
  if (db.query.standupActionProposals?.findMany) {
    const rows = await db.query.standupActionProposals.findMany({
      where: eq(standupActionProposals.sessionId, sessionId),
    });
    proposals = rows as StandupActionProposal[];
  }

  const userIds = [
    ...new Set(session.participants.map((p) => p.userId).filter(Boolean)),
  ];
  const displayNameByOid = new Map<string, string>();
  if (userIds.length > 0 && db.query.appUsers?.findMany) {
    try {
      const users = await db.query.appUsers.findMany({
        where: inArray(appUsers.oid, userIds),
        columns: { oid: true, displayName: true },
      });
      for (const u of users) {
        if (u.displayName) displayNameByOid.set(u.oid, u.displayName);
      }
    } catch {
      // Optional enrichment only
    }
  }

  const pulse = synthesizeTeamPulse({
    deliveryModel: session.config.deliveryModel,
    teamGoal: session.config.teamGoal,
    participants: session.participants.map((p) => ({
      userId: p.userId,
      displayName: displayNameByOid.get(p.userId) ?? null,
      status: p.status,
      structuredUpdate: p.structuredUpdate ?? null,
      preparedBrief: p.preparedBrief ?? null,
    })),
    proposals,
    decisionsNeeded,
  });

  await db
    .update(standupSessions)
    .set({ teamPulse: pulse })
    .where(eq(standupSessions.id, sessionId));

  return pulse;
}

export function buildStandupParticipantPrompt(kickoff: ChatThreadKickoff): string {
  const deliveryModel = kickoff.standupDeliveryModel ?? 'flow';
  const teamGoal = kickoff.standupTeamGoal?.trim() || null;
  const policy = kickoff.standupPolicy ?? {};
  const enableTargetDateChecks =
    typeof policy.enableTargetDateChecks === 'boolean'
      ? policy.enableTargetDateChecks
      : deliveryModel === 'milestone';
  const staleDays = policy.staleDaysThreshold ?? 3;
  const wipLimit =
    policy.wipLimitPerPerson !== undefined
      ? policy.wipLimitPerPerson
      : deliveryModel === 'flow'
      ? 3
      : null;
  const slaHours =
    policy.slaHoursHighPriority !== undefined
      ? policy.slaHoursHighPriority
      : deliveryModel === 'support'
      ? 24
      : null;

  const modelSummaryByMode: Record<string, string> = {
    flow: `Flow / Kanban — focus on flow aging (> ${staleDays}d in interim state), WIP overload${wipLimit ? ` (limit ${wipLimit})` : ''}, PR merge/review lag, carryover, and blockers. Do NOT ask for sprints or target dates unless target-date checks are enabled.`,
    sprint: `Sprint / Iteration — focus on current iteration scope, sprint goal progress, commitment carryover, PR review wait, and blockers.${enableTargetDateChecks ? '' : ' Do NOT require per-item target dates.'}`,
    milestone: `Milestone / Release — focus on upcoming release epics, Release:* tags, target-date readiness, missing target dates on release-relevant items, and blockers.`,
    support: `Support / Operations — focus on incident priority, bug SLA age${slaHours ? ` (> ${slaHours}h)` : ''}, root-cause communication, and handoffs.${enableTargetDateChecks ? '' : ' Do NOT require per-item target dates.'}`,
    custom: `Custom Delivery Policy — stale threshold ${staleDays}d, target-date checks ${enableTargetDateChecks ? 'enabled' : 'disabled'}${wipLimit ? `, WIP limit ${wipLimit}` : ''}${slaHours ? `, SLA ${slaHours}h` : ''}.`,
  };

  const parts: string[] = [
    `# Standup Ceremony — Participant Coach`,
    `You are coaching a team member through a concise, exception-first daily standup tailored to their team's configured Delivery Model.`,
    ``,
    `# Session context`,
    `  project:                "${kickoff.project}"`,
    `  sessionId:              "${kickoff.standupSessionId}"`,
    `  participantId:          "${kickoff.standupParticipantId}"`,
    `  teamMember:             "${kickoff.standupUserDisplayName ?? 'the team member'}"`,
    `  memberEmail:            "${kickoff.standupUserEmail ?? '(unknown)'}"`,
    `  deliveryModel:          "${deliveryModel}"`,
    `  teamGoal:               "${teamGoal ?? '(none configured)'}"`,
    `  enableTargetDateChecks: ${enableTargetDateChecks}`,
    `  threadId:               (use the threadId from .ai-pilot/session.json)`,
    ``,
    `# Delivery Model Policy`,
    `- ${modelSummaryByMode[deliveryModel] ?? modelSummaryByMode.flow}`,
    ...(teamGoal ? [`- Anchor today's plan and risks to the active Team Goal: "${teamGoal}".`] : []),
    ``,
    `# Available MCP tools`,
    `- \`query_work_items\` — query ADO work items via WIQL. Filter by assignee using their email (ADO uniqueName). Do NOT use @Me (that resolves to the service account, not the member).`,
    `- \`update_work_item\` — update work item fields (state, assignedTo, targetDate, tags, parent, etc.) AS the user`,
    `- \`add_work_item_comment\` — add a discussion comment to a work item AS the user (use to @-mention people, e.g. QA)`,
    `- \`create_work_items\` — create new work items (tasks/bugs/PBIs) AS the user`,
    `- \`query_board_items\` / \`update_board_item\` / \`add_board_item_comment\` / \`list_board_releases\` — Apex Work Board tools (use these instead of ADO when the project uses Work Board, e.g. Apex)`,
    `- \`get_skill\` / \`get_skill_file\` — load skills/files from the repo`,
    ``,
    `# CRITICAL RULES`,
    `- NEVER delete work items. Only create, update, comment, tag, or re-parent.`,
    `- Always CONFIRM with the user before making any write to ADO or the Work Board (state, assignee, target date, tag, parent).`,
    `- All ADO writes are attributed to the logged-in user via their token. Board writes use the standup thread user.`,
    ...(enableTargetDateChecks
      ? [`- Target-date checks are ENABLED: flag missing target dates on active/release-targeted items and call out items within 7 days of their target date that are still in New, Active, or In PR.`]
      : [`- Target-date checks are DISABLED for this ${deliveryModel} team: do NOT pester the participant about missing target dates or release tags.`]),
    `- For ADO projects, prefer existing team states (e.g. New → Active → In PR → merged to test → Ready for Test → UIT → UAT → Ready for Release → Closed; verify exact state on the work item before updating).`,
    `- For Work Board projects, use board statuses: idea → ready → in-progress → review → done.`,
    ``,
    `# Formatting Rules`,
    `- When referencing ADO work items, ALWAYS include the ID with a # prefix (e.g. #12345) — this renders as a clickable link in the UI.`,
    `- When referencing Work Board items, use APX-# (e.g. APX-12) plus title and status.`,
    `- ALWAYS include the work item type after the ID: "#12345 · Bug — Some Title [Active]" or "APX-12 · PBI — Some Title [in-progress]".`,
    `- ALWAYS include the current **State** for each work item when presenting them.`,
    ...(enableTargetDateChecks
      ? [
          `- Mark an active/release-relevant item with NO target date using "⚠️ no target date".`,
          `- Release-targeted items (ADO Release:* tags, or board items with a release) should be listed under a **Release-targeted:** heading first.`,
        ]
      : []),
    ``,
  ];

  if (kickoff.standupBriefSummary) {
    parts.push(
      `# Pre-Computed Participant Brief`,
      kickoff.standupBriefSummary,
      ``,
    );
  }

  parts.push(`# Standup Procedure`);

  const boardNative = (kickoff.project ?? '').toLowerCase() === 'apex';

  if (kickoff.standupSkillPath) {
    parts.push(
      `A custom standup skill has been configured. Load it first:`,
      `  Call \`get_skill\` with path: "${kickoff.standupSkillPath}", project: "${kickoff.project}", repo: "${kickoff.repo}"`,
      `Follow that skill's standup procedure while honoring the Delivery Model Policy above.`,
    );
  } else if (boardNative) {
    parts.push(
      `This project uses the **Apex Work Board**. Prefer board MCP tools over ADO WIQL.`,
      ``,
      `1. **Ground in their board items**: Call \`query_board_items\` for project "${kickoff.project}" (filter by owner when you know their OID; otherwise query all open statuses and match by owner email/name).${deliveryModel === 'milestone' ? ' Also call `list_board_releases` for upcoming releases.' : ''}`,
      `2. **Verify Yesterday & Exceptions**: Start with what changed since last standup and any stale items (> ${staleDays}d) or untouched prior commitments. Offer \`update_board_item\` after confirmation.`,
      `3. **Confirm Today**: Confirm focus items${teamGoal ? ` toward "${teamGoal}"` : ''}, handoffs (ownerId changes), and capacity/PTO.`,
      `4. **Blockers & risks**: Capture blockers; offer \`add_board_item_comment\` to leave notes.`,
      `5. **Wrap up**: Summarize briefly and confirm any final board updates.`,
      ``,
      `When the user is done, produce a structured summary in this JSON format (in a code block):`,
      '```json',
      `{ "yesterday": "...", "today": "...", "blockers": "...", "atRisk": "...", "handoffs": "...", "capacity": "..." }`,
      '```',
      `Leave a field as an empty string if it doesn't apply.`,
    );
  } else {
    const orderClause = enableTargetDateChecks
      ? `[Microsoft.VSTS.Scheduling.TargetDate] ASC, [Microsoft.VSTS.Common.Priority]`
      : `[System.ChangedDate] DESC, [Microsoft.VSTS.Common.Priority]`;
    parts.push(
      `Follow this concise, exception-first standup procedure (aim for 1-2 turns when everything is on track):`,
      ``,
      `1. **Ground in their work items**: Query active work items assigned to '${kickoff.standupUserEmail ?? ''}' and items they changed since yesterday.`,
      `   - WIQL for member items: SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo], [Microsoft.VSTS.Scheduling.TargetDate], [System.IterationPath], [System.Tags] FROM WorkItems WHERE [System.AssignedTo] = '${kickoff.standupUserEmail ?? ''}' AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Removed' ORDER BY ${orderClause}`,
      `   - WIQL for yesterday: SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.ChangedDate], [System.AssignedTo], [Microsoft.VSTS.Scheduling.TargetDate], [System.Tags] FROM WorkItems WHERE [System.ChangedBy] = '${kickoff.standupUserEmail ?? ''}' AND [System.ChangedDate] >= @Today - 1 AND [System.ChangedDate] < @Today ORDER BY [System.ChangedDate] DESC`,
      ...(deliveryModel === 'milestone'
        ? [
            `   - WIQL for releases: SELECT [System.Id], [System.Title], [Microsoft.VSTS.Scheduling.TargetDate], [System.State] FROM WorkItems WHERE [System.WorkItemType] = 'Epic' AND [System.Tags] CONTAINS 'ReleaseVersion' AND [System.State] <> 'Closed' AND [System.State] <> 'Done' ORDER BY [Microsoft.VSTS.Scheduling.TargetDate] ASC`,
          ]
        : []),
      `2. **Present Brief & Verify Exceptions First**: Show yesterday's detected activity and ask only about exceptions: stale interim states (> ${staleDays}d), PR merged while state lags, untouched commitments from last standup${wipLimit ? `, WIP above ${wipLimit}` : ''}${slaHours ? `, high-priority bugs exceeding ${slaHours}h SLA` : ''}${enableTargetDateChecks ? `, or missing/at-risk target dates` : ''}.`,
      `3. **Today, Handoffs & Capacity**: Confirm today's focus items${teamGoal ? ` relative to Team Goal "${teamGoal}"` : ''}, capture handoffs (who work moves to next), and note capacity/PTO.`,
      `4. **Blockers**: Ask for blockers (pipeline/build failure, person/review wait, external dependency, or production incident).`,
      `5. **Wrap up**: Confirm any requested ADO updates before writing, then emit the structured JSON summary:`,
      '```json',
      `{ "yesterday": "...", "today": "...", "blockers": "...", "atRisk": "...", "handoffs": "...", "capacity": "..." }`,
      '```',
      `Leave a field as an empty string if it doesn't apply. This JSON is extracted as the structured_update.`,
    );
  }

  return parts.join('\n');
}

export function buildStandupFacilitatorPrompt(kickoff: ChatThreadKickoff): string {
  const deliveryModel = kickoff.standupDeliveryModel ?? 'flow';
  const teamGoal = kickoff.standupTeamGoal?.trim() || null;
  const policy = kickoff.standupPolicy ?? {};
  const enableTargetDateChecks =
    typeof policy.enableTargetDateChecks === 'boolean'
      ? policy.enableTargetDateChecks
      : deliveryModel === 'milestone';

  const parts: string[] = [
    `# Standup Ceremony — Team Pulse Facilitator`,
    `You are the standup facilitator. Synthesize all participants' updates into a 5-minute exception-ordered Team Pulse summary aligned with the team's Delivery Model.`,
    ``,
    `# Session context`,
    `  sessionId:              "${kickoff.standupSessionId}"`,
    `  deliveryModel:          "${deliveryModel}"`,
    `  teamGoal:               "${teamGoal ?? '(none configured)'}"`,
    `  enableTargetDateChecks: ${enableTargetDateChecks}`,
    ``,
    `# Available MCP tools`,
    `- \`get_standup_session\` — read all participants' structured updates, prepared briefs, proposals, and transcripts`,
    `- \`create_standup_followup\` — create a follow-up item for involved participants`,
    `- \`complete_standup_session\` — finalize the session (persist summary + decisions, create follow-up threads, notify members)`,
    `- \`query_work_items\` — check ADO work item details if needed`,
    `- \`query_board_items\` / \`list_board_releases\` — Work Board alternatives when the project uses the board`,
    ``,
    `# Procedure`,
    `1. Call \`get_standup_session\` with the sessionId to load all participant updates, prepared briefs, and staged proposals.`,
    `2. Analyze updates for cross-cutting patterns and call \`create_standup_followup\` where teammates need to coordinate:`,
    `   - **Blockers & incidents** — pipeline/build failures, shared environment outages, external dependencies, or production incidents.`,
    `   - **Commitment carryover & flow bottlenecks** — untouched prior commitments, stale items, or WIP/SLA bottlenecks.`,
    ...(enableTargetDateChecks
      ? [`   - **Milestone & target-date risks** — release-relevant items that are overdue, due within 7 days in early states, or missing target dates.`]
      : [`   - **Model-aligned delivery risks (${deliveryModel})** — aging work, sprint scope drift, or support SLA risks (do NOT invent missing-target-date warnings when target-date checks are disabled).`]),
    `   - **Handoffs, PR reviews & capacity** — pair teammates handing off work or waiting on reviews, and match available capacity to blocked/unowned items.`,
    `3. Compose a concise markdown summary ordered for a 5-minute live huddle:`,
    `   1. **Team Goal & Overall Health**${teamGoal ? ` ("${teamGoal}")` : ''}`,
    `   2. **Blockers & Decisions Needed**`,
    `   3. **At-Risk Work & Commitment Carryover**`,
    `   4. **Handoffs, Reviews & Team Capacity**`,
    `   5. **Completed Highlights & Follow-ups Created**`,
    `4. Call \`complete_standup_session\` exactly once with the sessionId, your markdown summary, and optional \`decisionsNeeded\` list. This MUST be your final action.`,
    ``,
    `Also output the final summary as your last message.`,
  ];
  return parts.join('\n');
}
