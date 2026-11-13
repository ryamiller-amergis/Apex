import {
  STANDUP_DELIVERY_MODELS,
  STANDUP_GOAL_SOURCES,
  type CalendarItemHealth,
  type ParticipantDetectedException,
  type ParticipantPreparedBrief,
  type StandupActionProposal,
  type StandupConfidence,
  type StandupDeliveryModel,
  type StandupDeliveryPolicy,
  type StandupGoalSource,
  type StandupOverallHealth,
  type StandupStructuredUpdate,
  type StandupTeamPulse,
} from '../types/standup';

export interface EvidenceWorkItem {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  assignedTo?: string;
  changedDate?: string;
  createdDate?: string;
  targetDate?: string | null;
  dueDate?: string | null;
  qaCompleteDate?: string | null;
  iterationPath?: string | null;
  tags?: string;
  priority?: number;
}

export interface EvidencePullRequest {
  prId: number;
  title: string;
  status: 'active' | 'completed' | 'abandoned';
  createdAt: string;
  closedAt?: string;
  linkedWorkItemIds: number[];
  hasApproval?: boolean;
  repositoryName?: string;
  url?: string;
}

export interface EvidencePipelineFailure {
  buildId: string | number;
  buildNumber: string;
  definitionName: string;
  branch?: string;
  failedAt: string;
  linkedWorkItemIds?: number[];
  prId?: number;
}

export interface EvaluateParticipantBriefInput {
  now?: Date | string;
  deliveryModel?: StandupDeliveryModel | string | null;
  teamGoal?: string | null;
  policy?: Partial<StandupDeliveryPolicy> | null;
  expectedIterationPath?: string | null;
  activeWorkItems: EvidenceWorkItem[];
  changedSinceLastWorkItems?: EvidenceWorkItem[];
  pullRequests?: EvidencePullRequest[];
  pipelineFailures?: EvidencePipelineFailure[];
  priorStructuredUpdate?: StandupStructuredUpdate | null;
  openFollowups?: Array<{ id: string; title: string; sessionDate: string }>;
}

export interface SynthesizeTeamPulseInput {
  now?: Date | string;
  deliveryModel?: StandupDeliveryModel | string | null;
  teamGoal?: string | null;
  participants: Array<{
    userId: string;
    displayName?: string | null;
    status: string;
    structuredUpdate?: StandupStructuredUpdate | null;
    preparedBrief?: ParticipantPreparedBrief | null;
  }>;
  proposals?: StandupActionProposal[];
  decisionsNeeded?: string[];
}

export interface EvaluateCalendarHealthOptions {
  now?: Date | string;
  deliveryModel?: StandupDeliveryModel | string | null;
  policy?: Partial<StandupDeliveryPolicy> | null;
  expectedIterationPath?: string | null;
  teamPulse?: StandupTeamPulse | null;
  proposals?: StandupActionProposal[];
}

const TERMINAL_STATES = new Set([
  'closed',
  'done',
  'removed',
  'completed',
  'resolved',
]);

const EARLY_EXECUTION_STATES = new Set([
  'new',
  'committed',
  'active',
  'in progress',
  'in-progress',
  'in pr',
  'in pull request',
]);

const INTERIM_ACTIVE_STATES = new Set([
  'active',
  'in progress',
  'in-progress',
  'in pr',
  'in pull request',
  'ready for test',
  'in test',
  'review',
]);

const WIP_ACTIVE_STATES = new Set([
  'active',
  'in progress',
  'in-progress',
  'in pr',
  'in pull request',
]);

const ADVANCED_PROGRESS_STATES = new Set([
  'merged to test',
  'ready for test',
  'in test',
  'uit',
  'uat',
  'ready for release',
  'done',
  'closed',
]);

export function normalizeDeliveryModel(
  model?: string | null,
): StandupDeliveryModel {
  if (model && (STANDUP_DELIVERY_MODELS as readonly string[]).includes(model)) {
    return model as StandupDeliveryModel;
  }
  return 'flow';
}

export function normalizeGoalSource(
  source?: string | null,
): StandupGoalSource {
  if (source && (STANDUP_GOAL_SOURCES as readonly string[]).includes(source)) {
    return source as StandupGoalSource;
  }
  return 'none';
}

export function resolveStandupPolicy(
  deliveryModelInput?: StandupDeliveryModel | string | null,
  partialPolicy?: Partial<StandupDeliveryPolicy> | null,
): StandupDeliveryPolicy {
  const deliveryModel = normalizeDeliveryModel(deliveryModelInput);
  const raw = partialPolicy ?? {};

  const staleDaysThreshold =
    typeof raw.staleDaysThreshold === 'number' && raw.staleDaysThreshold > 0
      ? raw.staleDaysThreshold
      : 3;

  const prReviewWaitHours =
    typeof raw.prReviewWaitHours === 'number' && raw.prReviewWaitHours > 0
      ? raw.prReviewWaitHours
      : 24;

  const wipLimitPerPerson =
    raw.wipLimitPerPerson !== undefined
      ? raw.wipLimitPerPerson
      : deliveryModel === 'flow'
      ? 3
      : null;

  const slaHoursHighPriority =
    raw.slaHoursHighPriority !== undefined
      ? raw.slaHoursHighPriority
      : deliveryModel === 'support'
      ? 24
      : null;

  const enableTargetDateChecks =
    typeof raw.enableTargetDateChecks === 'boolean'
      ? raw.enableTargetDateChecks
      : deliveryModel === 'milestone';

  return {
    staleDaysThreshold,
    prReviewWaitHours,
    wipLimitPerPerson,
    slaHoursHighPriority,
    enablePrEvidence:
      typeof raw.enablePrEvidence === 'boolean' ? raw.enablePrEvidence : true,
    enablePipelineEvidence:
      typeof raw.enablePipelineEvidence === 'boolean'
        ? raw.enablePipelineEvidence
        : true,
    enableCommitmentMemory:
      typeof raw.enableCommitmentMemory === 'boolean'
        ? raw.enableCommitmentMemory
        : true,
    enableTargetDateChecks,
    ...(Array.isArray(raw.stateVocabulary) && raw.stateVocabulary.length > 0
      ? { stateVocabulary: raw.stateVocabulary }
      : {}),
  };
}

export function extractWorkItemIds(text?: string | null): number[] {
  if (!text) return [];
  const matches = text.match(/#(\d+)/g);
  if (!matches) return [];
  const seen = new Set<number>();
  for (const token of matches) {
    const num = Number.parseInt(token.slice(1), 10);
    if (Number.isFinite(num) && num > 0) {
      seen.add(num);
    }
  }
  return Array.from(seen);
}

function toDate(value?: Date | string | null): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatYmd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDaysYmd(base: Date, days: number): string {
  const next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + days);
  return formatYmd(next);
}

function parseYmdUtc(ymd?: string | null): Date | null {
  if (!ymd) return null;
  const clean = ymd.slice(0, 10);
  const parts = clean.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function usesTargetDateField(workItemType?: string): boolean {
  const normalized = (workItemType ?? '').trim().toLowerCase();
  return normalized === 'epic' || normalized === 'feature' || normalized === 'bug';
}

function effectiveItemDate(item: {
  workItemType?: string;
  targetDate?: string | null;
  dueDate?: string | null;
}): string | null {
  if (usesTargetDateField(item.workItemType)) {
    return item.targetDate ?? item.dueDate ?? null;
  }
  return item.dueDate ?? item.targetDate ?? null;
}

function suggestedPostMergeState(vocabulary?: string[]): string {
  if (vocabulary && vocabulary.length > 0) {
    const candidate = vocabulary.find((s) =>
      /merged to test|ready for test|in test|review/i.test(s),
    );
    if (candidate) return candidate;
  }
  return 'Ready for Test';
}

function parseCommitmentSegments(todayText: string): string[] {
  const segments = todayText
    .split(/\n|;/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((line) => line.length > 0);
  return segments.length > 0 ? segments : [todayText.trim()].filter(Boolean);
}

export function evaluateParticipantBrief(
  input: EvaluateParticipantBriefInput,
): ParticipantPreparedBrief {
  const now = toDate(input.now) ?? new Date();
  const deliveryModel = normalizeDeliveryModel(input.deliveryModel);
  const policy = resolveStandupPolicy(deliveryModel, input.policy);
  const changedItems = input.changedSinceLastWorkItems ?? [];
  const prs = policy.enablePrEvidence ? (input.pullRequests ?? []) : [];
  const pipelineFailures = policy.enablePipelineEvidence
    ? (input.pipelineFailures ?? [])
    : [];

  const activeById = new Map<number, EvidenceWorkItem>();
  for (const item of input.activeWorkItems) {
    activeById.set(item.id, item);
  }
  const changedById = new Map<number, EvidenceWorkItem>();
  for (const item of changedItems) {
    changedById.set(item.id, item);
  }

  const accomplishedSinceLast: ParticipantPreparedBrief['accomplishedSinceLast'] = [];
  for (const item of changedItems) {
    accomplishedSinceLast.push({
      workItemId: item.id,
      title: item.title,
      workItemType: item.workItemType,
      state: item.state,
      evidence: `ADO update — state [${item.state}]`,
    });
  }

  const mergedPrWorkItemIds = new Set<number>();
  const activePrWorkItemIds = new Set<number>();
  for (const pr of prs) {
    if (pr.status === 'completed') {
      for (const id of pr.linkedWorkItemIds) mergedPrWorkItemIds.add(id);
      accomplishedSinceLast.push({
        prId: pr.prId,
        workItemId: pr.linkedWorkItemIds[0],
        title: pr.title,
        evidence: `Merged PR !${pr.prId}`,
      });
    } else if (pr.status === 'active') {
      for (const id of pr.linkedWorkItemIds) activePrWorkItemIds.add(id);
    }
  }

  const detectedExceptions: ParticipantDetectedException[] = [];
  const priorCommitments: ParticipantPreparedBrief['priorCommitments'] = [];
  const carryoverWorkItemIds = new Set<number>();

  if (policy.enableCommitmentMemory && input.priorStructuredUpdate?.today?.trim()) {
    const segments = parseCommitmentSegments(input.priorStructuredUpdate.today);
    segments.forEach((segment, idx) => {
      const ids = extractWorkItemIds(segment);
      let status: 'completed' | 'progressed' | 'untouched' = 'untouched';
      let note = 'No ADO state change or PR activity recorded since last standup';

      if (ids.length > 0) {
        const anyCompleted = ids.some((id) => {
          const item = changedById.get(id) ?? activeById.get(id);
          const stateNorm = (item?.state ?? '').trim().toLowerCase();
          return ADVANCED_PROGRESS_STATES.has(stateNorm) || mergedPrWorkItemIds.has(id);
        });
        const anyProgressed = ids.some(
          (id) => changedById.has(id) || activePrWorkItemIds.has(id),
        );
        if (anyCompleted) {
          status = 'completed';
          note = 'Advanced in ADO or merged via PR';
        } else if (anyProgressed) {
          status = 'progressed';
          note = 'Updated since last standup';
        }
      } else if (changedItems.length > 0 || mergedPrWorkItemIds.size > 0) {
        status = 'progressed';
        note = 'General activity recorded since last standup';
      }

      priorCommitments.push({
        summary: segment,
        workItemIds: ids,
        status,
        note,
      });

      if (status === 'untouched') {
        for (const id of ids) carryoverWorkItemIds.add(id);
        detectedExceptions.push({
          id: `untouched-commitment-${idx}`,
          kind: 'untouched_commitment',
          severity: 'warning',
          message: `Prior commitment untouched: "${segment}" has no recorded ADO or PR activity.`,
          workItemId: ids[0],
        });
      }
    });
  }

  // PR evidence checks
  for (const pr of prs) {
    if (pr.status === 'completed') {
      for (const wiId of pr.linkedWorkItemIds) {
        const item = activeById.get(wiId);
        if (!item) continue;
        const stateNorm = item.state.trim().toLowerCase();
        if (EARLY_EXECUTION_STATES.has(stateNorm)) {
          const nextState = suggestedPostMergeState(policy.stateVocabulary);
          detectedExceptions.push({
            id: `pr-merged-lag-${pr.prId}-${wiId}`,
            kind: 'pr_merged_state_lag',
            severity: 'warning',
            message: `PR !${pr.prId} merged, but #${wiId} (${item.title}) is still [${item.state}].`,
            workItemId: wiId,
            workItemTitle: item.title,
            prId: pr.prId,
            proposedAction: {
              proposalType: 'state',
              fieldName: 'state',
              currentValue: item.state,
              proposedValue: nextState,
              label: `Advance #${wiId} state to ${nextState}`,
            },
          });
        }
      }
    } else if (pr.status === 'active' && !pr.hasApproval) {
      const created = toDate(pr.createdAt);
      if (created) {
        const waitHours = (now.getTime() - created.getTime()) / (1000 * 60 * 60);
        if (waitHours >= policy.prReviewWaitHours) {
          detectedExceptions.push({
            id: `pr-wait-${pr.prId}`,
            kind: 'pr_waiting_review',
            severity: 'warning',
            message: `PR !${pr.prId} (${pr.title}) has waited ${Math.round(waitHours)}h without approval.`,
            workItemId: pr.linkedWorkItemIds[0],
            prId: pr.prId,
          });
        }
      }
    }
  }

  // Pipeline failure checks
  for (const failure of pipelineFailures) {
    detectedExceptions.push({
      id: `pipeline-fail-${failure.buildId}`,
      kind: 'pipeline_failure',
      severity: 'critical',
      message: `Pipeline "${failure.definitionName}" build ${failure.buildNumber} failed${failure.branch ? ` on ${failure.branch}` : ''}.`,
      workItemId: failure.linkedWorkItemIds?.[0],
      prId: failure.prId,
    });
  }

  // WIP check (Flow or custom policy with wipLimitPerPerson)
  const nonTerminalActive = input.activeWorkItems.filter(
    (item) => !TERMINAL_STATES.has(item.state.trim().toLowerCase()),
  );
  const wipItems = nonTerminalActive.filter((item) =>
    WIP_ACTIVE_STATES.has(item.state.trim().toLowerCase()),
  );
  if (policy.wipLimitPerPerson != null && wipItems.length > policy.wipLimitPerPerson) {
    detectedExceptions.push({
      id: 'wip-overload',
      kind: 'wip_overload',
      severity: 'warning',
      message: `${wipItems.length} active items in progress exceeds WIP limit of ${policy.wipLimitPerPerson}.`,
      workItemId: wipItems[0]?.id,
      workItemTitle: wipItems[0]?.title,
    });
  }

  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const riskFlagsByItemId = new Map<number, string[]>();
  const addRiskFlag = (id: number, flag: string) => {
    const existing = riskFlagsByItemId.get(id) ?? [];
    if (!existing.includes(flag)) {
      existing.push(flag);
      riskFlagsByItemId.set(id, existing);
    }
  };

  for (const id of carryoverWorkItemIds) {
    addRiskFlag(id, 'Carryover');
  }

  // Per-item checks
  for (const item of nonTerminalActive) {
    const stateNorm = item.state.trim().toLowerCase();

    // Stale interim state check
    if (INTERIM_ACTIVE_STATES.has(stateNorm) && item.changedDate) {
      const changed = toDate(item.changedDate);
      if (changed) {
        const staleDays = (now.getTime() - changed.getTime()) / (1000 * 60 * 60 * 24);
        if (staleDays >= policy.staleDaysThreshold) {
          const roundedDays = Math.floor(staleDays);
          addRiskFlag(item.id, `Stale ${roundedDays}d`);
          detectedExceptions.push({
            id: `stale-${item.id}`,
            kind: 'stale_state',
            severity: roundedDays >= policy.staleDaysThreshold * 2 ? 'critical' : 'warning',
            message: `#${item.id} (${item.title}) has stayed in [${item.state}] for ${roundedDays} days.`,
            workItemId: item.id,
            workItemTitle: item.title,
            ...(stateNorm === 'in pr' || stateNorm === 'in pull request'
              ? {
                  proposedAction: {
                    proposalType: 'state',
                    fieldName: 'state',
                    currentValue: item.state,
                    proposedValue: suggestedPostMergeState(policy.stateVocabulary),
                    label: `Update #${item.id} state to ${suggestedPostMergeState(policy.stateVocabulary)}`,
                  },
                }
              : {}),
          });
        }
      }
    }

    // Sprint iteration check
    if (
      deliveryModel === 'sprint' &&
      input.expectedIterationPath &&
      item.iterationPath &&
      item.iterationPath !== input.expectedIterationPath
    ) {
      addRiskFlag(item.id, 'Outside sprint');
    }

    // Support SLA check
    if (policy.slaHoursHighPriority != null) {
      const isHighPriSupportItem =
        item.workItemType.trim().toLowerCase() === 'bug' ||
        (typeof item.priority === 'number' && item.priority <= 2);
      if (isHighPriSupportItem) {
        const anchorDate = toDate(item.createdDate) ?? toDate(item.changedDate);
        if (anchorDate) {
          const ageHours = (now.getTime() - anchorDate.getTime()) / (1000 * 60 * 60);
          if (ageHours > policy.slaHoursHighPriority) {
            addRiskFlag(item.id, `SLA > ${policy.slaHoursHighPriority}h`);
            detectedExceptions.push({
              id: `sla-${item.id}`,
              kind: 'sla_breach',
              severity: 'critical',
              message: `#${item.id} (${item.title}) has been open ${Math.round(ageHours)}h, exceeding the ${policy.slaHoursHighPriority}h SLA.`,
              workItemId: item.id,
              workItemTitle: item.title,
            });
          }
        }
      }
    }

    // Target-date checks ONLY when enabled (Milestone default, or explicitly toggled)
    if (policy.enableTargetDateChecks) {
      const itemDateStr = effectiveItemDate(item);
      const dateFieldName = usesTargetDateField(item.workItemType) ? 'targetDate' : 'dueDate';
      const isReleaseTagged = Boolean(item.tags && /release:/i.test(item.tags));

      if (!itemDateStr) {
        if (isReleaseTagged || WIP_ACTIVE_STATES.has(stateNorm) || usesTargetDateField(item.workItemType)) {
          const proposedDate = addDaysYmd(todayUtc, 7);
          addRiskFlag(item.id, 'Missing target date');
          detectedExceptions.push({
            id: `missing-date-${item.id}`,
            kind: 'missing_target_date',
            severity: 'warning',
            message: `#${item.id} (${item.title}) has no target date set under Milestone policy.`,
            workItemId: item.id,
            workItemTitle: item.title,
            proposedAction: {
              proposalType: 'target_date',
              fieldName: dateFieldName,
              currentValue: null,
              proposedValue: proposedDate,
              label: `Propose ${dateFieldName} ${proposedDate} for #${item.id}`,
            },
          });
        }
      } else if (EARLY_EXECUTION_STATES.has(stateNorm)) {
        const deadlineUtc = parseYmdUtc(itemDateStr);
        if (deadlineUtc) {
          const daysUntil = Math.floor(
            (deadlineUtc.getTime() - todayUtc.getTime()) / (1000 * 60 * 60 * 24),
          );
          if (daysUntil <= 7) {
            const baseForExtension = deadlineUtc > todayUtc ? deadlineUtc : todayUtc;
            const proposedDate = addDaysYmd(baseForExtension, 7);
            const labelText =
              daysUntil < 0
                ? `${Math.abs(daysUntil)}d overdue`
                : daysUntil === 0
                ? 'due today'
                : `due in ${daysUntil}d`;
            addRiskFlag(item.id, `Target date ${labelText}`);
            detectedExceptions.push({
              id: `at-risk-date-${item.id}`,
              kind: 'target_date_at_risk',
              severity: daysUntil < 0 ? 'critical' : 'warning',
              message: `#${item.id} (${item.title}) is ${labelText} (${itemDateStr.slice(0, 10)}) while still [${item.state}].`,
              workItemId: item.id,
              workItemTitle: item.title,
              proposedAction: {
                proposalType: 'target_date',
                fieldName: dateFieldName,
                currentValue: itemDateStr.slice(0, 10),
                proposedValue: proposedDate,
                label: `Move #${item.id} ${dateFieldName} to ${proposedDate}`,
              },
            });
          }
        }
      }
    }
  }

  const suggestedToday: ParticipantPreparedBrief['suggestedToday'] = [...nonTerminalActive]
    .sort((a, b) => {
      const aFlags = (riskFlagsByItemId.get(a.id) ?? []).length;
      const bFlags = (riskFlagsByItemId.get(b.id) ?? []).length;
      if (aFlags !== bFlags) return bFlags - aFlags;
      const aActive = WIP_ACTIVE_STATES.has(a.state.trim().toLowerCase()) ? 1 : 0;
      const bActive = WIP_ACTIVE_STATES.has(b.state.trim().toLowerCase()) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return a.id - b.id;
    })
    .slice(0, 10)
    .map((item) => ({
      workItemId: item.id,
      title: item.title,
      workItemType: item.workItemType,
      state: item.state,
      targetDate: effectiveItemDate(item),
      iterationPath: item.iterationPath ?? null,
      riskFlags: riskFlagsByItemId.get(item.id) ?? [],
    }));

  return {
    generatedAt: now.toISOString(),
    deliveryModel,
    teamGoal: input.teamGoal ?? null,
    accomplishedSinceLast,
    priorCommitments,
    suggestedToday,
    detectedExceptions,
    openFollowups: input.openFollowups ?? [],
  };
}

function classifyBlockerType(
  text: string,
): 'pipeline' | 'person' | 'external' | 'incident' | 'other' {
  const lower = text.toLowerCase();
  if (/prod(uction)?\b|incident|outage|sev[- ]?[12]|sla\b/.test(lower)) {
    return 'incident';
  }
  if (/pipeline|build|ci\b|deploy|test runner/.test(lower)) {
    return 'pipeline';
  }
  if (/figma|vendor|access|firewall|external|another team|environment/.test(lower)) {
    return 'external';
  }
  if (/review|waiting on|handoff|qa\b|approval|teammate/.test(lower)) {
    return 'person';
  }
  return 'other';
}

function isNoneLike(text?: string | null): boolean {
  if (!text) return true;
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed.length === 0 ||
    trimmed === 'none' ||
    trimmed === 'none.' ||
    trimmed === 'n/a' ||
    trimmed === 'no blockers' ||
    trimmed === 'no blockers.' ||
    trimmed === 'nothing'
  );
}

export function synthesizeTeamPulse(
  input: SynthesizeTeamPulseInput,
): StandupTeamPulse {
  const now = toDate(input.now) ?? new Date();
  const deliveryModel = normalizeDeliveryModel(input.deliveryModel);
  const teamGoal = input.teamGoal ?? null;

  const completedHighlights: StandupTeamPulse['completedHighlights'] = [];
  const blockers: StandupTeamPulse['blockers'] = [];
  const atRiskMap = new Map<number, StandupTeamPulse['atRiskItems'][number]>();
  const carryoverAlerts: StandupTeamPulse['carryoverAlerts'] = [];
  const handoffsAndReviews: StandupTeamPulse['handoffsAndReviews'] = [];
  const capacityNotes: StandupTeamPulse['capacityNotes'] = [];
  const decisionsSet = new Set<string>(input.decisionsNeeded ?? []);

  let submittedCount = 0;

  for (const participant of input.participants) {
    const label = participant.displayName?.trim() || participant.userId;
    if (participant.status === 'submitted') {
      submittedCount += 1;
    }

    const update = participant.structuredUpdate;
    const brief = participant.preparedBrief;

    if (update?.yesterday && !isNoneLike(update.yesterday)) {
      completedHighlights.push({
        userId: participant.userId,
        displayName: label,
        summary: update.yesterday.trim(),
        workItemIds: extractWorkItemIds(update.yesterday),
      });
    } else if (brief && brief.accomplishedSinceLast.length > 0) {
      const titles = brief.accomplishedSinceLast
        .slice(0, 3)
        .map((a) => (a.workItemId ? `#${a.workItemId} ${a.title}` : a.title))
        .join('; ');
      const ids = brief.accomplishedSinceLast
        .map((a) => a.workItemId)
        .filter((id): id is number => typeof id === 'number');
      completedHighlights.push({
        userId: participant.userId,
        displayName: label,
        summary: titles,
        workItemIds: ids,
      });
    }

    if (update?.blockers && !isNoneLike(update.blockers)) {
      const blockerText = update.blockers.trim();
      const blockerType = classifyBlockerType(blockerText);
      blockers.push({
        summary: blockerText,
        blockerType,
        ownerDisplayName: label,
        workItemIds: extractWorkItemIds(blockerText),
      });
      if (blockerType === 'incident' || blockerType === 'external') {
        decisionsSet.add(`Resolve ${blockerType} blocker reported by ${label}: ${blockerText}`);
      }
    }

    if (brief) {
      for (const ex of brief.detectedExceptions) {
        if (ex.kind === 'pipeline_failure') {
          const alreadyListed = blockers.some((b) => b.summary === ex.message);
          if (!alreadyListed) {
            blockers.push({
              summary: ex.message,
              blockerType: 'pipeline',
              ownerDisplayName: label,
              workItemIds: ex.workItemId ? [ex.workItemId] : [],
            });
          }
        } else if (ex.kind === 'untouched_commitment') {
          const existingCarry = carryoverAlerts.find((c) => c.userId === participant.userId);
          const ids = ex.workItemId ? [ex.workItemId] : [];
          if (existingCarry) {
            for (const id of ids) {
              if (!existingCarry.workItemIds.includes(id)) existingCarry.workItemIds.push(id);
            }
          } else {
            carryoverAlerts.push({
              userId: participant.userId,
              displayName: label,
              summary: ex.message,
              workItemIds: ids,
            });
          }
        } else if (
          ex.workItemId &&
          (ex.kind === 'stale_state' ||
            ex.kind === 'missing_target_date' ||
            ex.kind === 'target_date_at_risk' ||
            ex.kind === 'sla_breach' ||
            ex.kind === 'pr_merged_state_lag')
        ) {
          const existing = atRiskMap.get(ex.workItemId);
          const confidence: 'at_risk' | 'uncertain' =
            ex.severity === 'critical' || ex.kind === 'target_date_at_risk' || ex.kind === 'sla_breach'
              ? 'at_risk'
              : 'uncertain';
          if (existing) {
            if (!existing.reasons.includes(ex.message)) {
              existing.reasons.push(ex.message);
            }
            if (confidence === 'at_risk') existing.confidence = 'at_risk';
          } else {
            atRiskMap.set(ex.workItemId, {
              workItemId: ex.workItemId,
              title: ex.workItemTitle ?? `Work Item #${ex.workItemId}`,
              assignee: label,
              confidence,
              reasons: [ex.message],
              currentTargetDate:
                ex.proposedAction?.proposalType === 'target_date'
                  ? ex.proposedAction.currentValue ?? null
                  : undefined,
              suggestedTargetDate:
                ex.proposedAction?.proposalType === 'target_date'
                  ? ex.proposedAction.proposedValue
                  : undefined,
            });
          }
        } else if (ex.kind === 'pr_waiting_review') {
          handoffsAndReviews.push({
            summary: ex.message,
            fromUser: label,
            workItemIds: ex.workItemId ? [ex.workItemId] : [],
            prIds: ex.prId ? [ex.prId] : [],
          });
        }
      }
    }

    if (update?.atRisk && !isNoneLike(update.atRisk)) {
      const ids = extractWorkItemIds(update.atRisk);
      if (ids.length > 0) {
        for (const id of ids) {
          const existing = atRiskMap.get(id);
          if (existing) {
            if (!existing.reasons.includes(update.atRisk.trim())) {
              existing.reasons.push(update.atRisk.trim());
            }
            existing.confidence = 'at_risk';
          } else {
            atRiskMap.set(id, {
              workItemId: id,
              title: `Work Item #${id}`,
              assignee: label,
              confidence: 'at_risk',
              reasons: [update.atRisk.trim()],
            });
          }
        }
      } else {
        decisionsSet.add(`Review risk noted by ${label}: ${update.atRisk.trim()}`);
      }
    }

    if (update?.handoffs && !isNoneLike(update.handoffs)) {
      handoffsAndReviews.push({
        summary: update.handoffs.trim(),
        fromUser: label,
        workItemIds: extractWorkItemIds(update.handoffs),
      });
    }

    if (update?.capacity && !isNoneLike(update.capacity)) {
      capacityNotes.push({
        userId: participant.userId,
        displayName: label,
        note: update.capacity.trim(),
      });
    }
  }

  const pendingProposals = (input.proposals ?? []).filter((p) => p.status === 'pending');
  if (pendingProposals.length > 0) {
    decisionsSet.add(
      `Confirm or dismiss ${pendingProposals.length} staged ADO update proposal${pendingProposals.length === 1 ? '' : 's'}.`,
    );
  }

  const atRiskItems = Array.from(atRiskMap.values());
  const hasCriticalBlocker = blockers.some(
    (b) => b.blockerType === 'incident' || b.blockerType === 'pipeline',
  );
  const highRiskCount = atRiskItems.filter((item) => item.confidence === 'at_risk').length;

  let overallHealth: StandupOverallHealth = 'on_track';
  if (hasCriticalBlocker || blockers.length >= 2 || highRiskCount >= 2) {
    overallHealth = 'at_risk';
  } else if (
    blockers.length > 0 ||
    atRiskItems.length > 0 ||
    carryoverAlerts.length > 0
  ) {
    overallHealth = 'watch';
  }

  const totalParticipants = input.participants.length;
  const goalPrefix = teamGoal ? `Goal "${teamGoal}": ` : '';
  const goalProgressSummary =
    `${goalPrefix}${submittedCount}/${totalParticipants} updates submitted · ` +
    `${blockers.length} blocker${blockers.length === 1 ? '' : 's'} · ` +
    `${atRiskItems.length} at-risk/watch item${atRiskItems.length === 1 ? '' : 's'} · ` +
    `${carryoverAlerts.length} carryover alert${carryoverAlerts.length === 1 ? '' : 's'}.`;

  return {
    generatedAt: now.toISOString(),
    deliveryModel,
    teamGoal,
    goalProgressSummary,
    overallHealth,
    completedHighlights,
    blockers,
    atRiskItems,
    carryoverAlerts,
    handoffsAndReviews,
    capacityNotes,
    decisionsNeeded: Array.from(decisionsSet),
  };
}

export function evaluateCalendarItemHealth(
  workItems: EvidenceWorkItem[],
  options: EvaluateCalendarHealthOptions = {},
): {
  itemHealthById: Record<number, CalendarItemHealth>;
  counts: {
    onTrack: number;
    uncertain: number;
    atRisk: number;
    blockedOrStale: number;
    missingTargetDate: number;
    pendingProposals: number;
  };
  overallHealth: StandupOverallHealth;
} {
  const now = toDate(options.now) ?? new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const deliveryModel = normalizeDeliveryModel(options.deliveryModel);
  const policy = resolveStandupPolicy(deliveryModel, options.policy);
  const pendingProposals = (options.proposals ?? []).filter((p) => p.status === 'pending');

  // Index pulse signals by work item ID
  const blockerReasonsByItem = new Map<number, string[]>();
  const pulseAtRiskByItem = new Map<
    number,
    { confidence: 'at_risk' | 'uncertain'; reasons: string[] }
  >();
  const carryoverItemIds = new Set<number>();

  if (options.teamPulse) {
    for (const blocker of options.teamPulse.blockers) {
      for (const id of blocker.workItemIds) {
        const list = blockerReasonsByItem.get(id) ?? [];
        list.push(`Standup blocker: ${blocker.summary}`);
        blockerReasonsByItem.set(id, list);
      }
    }
    for (const risk of options.teamPulse.atRiskItems) {
      pulseAtRiskByItem.set(risk.workItemId, {
        confidence: risk.confidence,
        reasons: [...risk.reasons],
      });
    }
    for (const carry of options.teamPulse.carryoverAlerts) {
      for (const id of carry.workItemIds) {
        carryoverItemIds.add(id);
      }
    }
  }

  const proposalsByItem = new Map<number, StandupActionProposal[]>();
  for (const proposal of pendingProposals) {
    const list = proposalsByItem.get(proposal.workItemId) ?? [];
    list.push(proposal);
    proposalsByItem.set(proposal.workItemId, list);
  }

  // Count active WIP per assignee when wipLimitPerPerson is configured
  const wipCountByAssignee = new Map<string, number>();
  if (policy.wipLimitPerPerson != null) {
    for (const item of workItems) {
      const stateNorm = (item.state ?? '').trim().toLowerCase();
      if (item.assignedTo && WIP_ACTIVE_STATES.has(stateNorm)) {
        wipCountByAssignee.set(
          item.assignedTo,
          (wipCountByAssignee.get(item.assignedTo) ?? 0) + 1,
        );
      }
    }
  }

  const itemHealthById: Record<number, CalendarItemHealth> = {};
  let onTrack = 0;
  let uncertain = 0;
  let atRisk = 0;
  let blockedOrStale = 0;
  let missingTargetDate = 0;

  const promoteConfidence = (
    current: StandupConfidence,
    next: StandupConfidence,
  ): StandupConfidence => {
    const rank: Record<StandupConfidence, number> = {
      on_track: 0,
      uncertain: 1,
      at_risk: 2,
    };
    return rank[next] > rank[current] ? next : current;
  };

  for (const item of workItems) {
    const stateNorm = (item.state ?? '').trim().toLowerCase();
    if (TERMINAL_STATES.has(stateNorm)) {
      itemHealthById[item.id] = {
        workItemId: item.id,
        confidence: 'on_track',
        reasons: [],
        isBlockedOrStale: false,
        carryover: false,
      };
      onTrack += 1;
      continue;
    }

    let confidence: StandupConfidence = 'on_track';
    const reasons: string[] = [];
    let isBlockedOrStale = false;
    const carryover = carryoverItemIds.has(item.id);

    const addReason = (reason: string) => {
      if (!reasons.includes(reason)) reasons.push(reason);
    };

    if (stateNorm === 'blocked') {
      confidence = promoteConfidence(confidence, 'at_risk');
      isBlockedOrStale = true;
      addReason('Work item state is Blocked');
    }

    const blockerReasons = blockerReasonsByItem.get(item.id);
    if (blockerReasons && blockerReasons.length > 0) {
      confidence = promoteConfidence(confidence, 'at_risk');
      isBlockedOrStale = true;
      blockerReasons.forEach(addReason);
    }

    if (carryover) {
      confidence = promoteConfidence(confidence, 'uncertain');
      addReason('Untouched commitment carried over from prior standup');
    }

    const pulseRisk = pulseAtRiskByItem.get(item.id);
    if (pulseRisk) {
      confidence = promoteConfidence(confidence, pulseRisk.confidence);
      pulseRisk.reasons.forEach(addReason);
    }

    // Stale state evaluation
    if (INTERIM_ACTIVE_STATES.has(stateNorm) && item.changedDate) {
      const changed = toDate(item.changedDate);
      if (changed) {
        const staleDays = (now.getTime() - changed.getTime()) / (1000 * 60 * 60 * 24);
        if (staleDays >= policy.staleDaysThreshold) {
          const roundedDays = Math.floor(staleDays);
          isBlockedOrStale = true;
          confidence = promoteConfidence(
            confidence,
            roundedDays >= policy.staleDaysThreshold * 2 ? 'at_risk' : 'uncertain',
          );
          addReason(
            `Unchanged in ${item.state} for ${roundedDays}d (threshold: ${policy.staleDaysThreshold}d)`,
          );
        }
      }
    }

    // WIP overload in Flow / custom policy
    if (policy.wipLimitPerPerson != null && item.assignedTo && WIP_ACTIVE_STATES.has(stateNorm)) {
      const assigneeWip = wipCountByAssignee.get(item.assignedTo) ?? 0;
      if (assigneeWip > policy.wipLimitPerPerson) {
        confidence = promoteConfidence(confidence, 'uncertain');
        addReason(
          `${item.assignedTo} has ${assigneeWip} items in progress (WIP limit: ${policy.wipLimitPerPerson})`,
        );
      }
    }

    // Sprint iteration mismatch
    if (
      deliveryModel === 'sprint' &&
      options.expectedIterationPath &&
      item.iterationPath &&
      item.iterationPath !== options.expectedIterationPath
    ) {
      confidence = promoteConfidence(confidence, 'uncertain');
      addReason(
        `Iteration "${item.iterationPath}" is outside active sprint "${options.expectedIterationPath}"`,
      );
    }

    // Support SLA breach
    if (policy.slaHoursHighPriority != null) {
      const isSupportBug =
        item.workItemType.trim().toLowerCase() === 'bug' ||
        (typeof item.priority === 'number' && item.priority <= 2);
      if (isSupportBug) {
        const anchor = toDate(item.createdDate) ?? toDate(item.changedDate);
        if (anchor) {
          const ageHours = (now.getTime() - anchor.getTime()) / (1000 * 60 * 60);
          if (ageHours > policy.slaHoursHighPriority) {
            confidence = promoteConfidence(confidence, 'at_risk');
            isBlockedOrStale = true;
            addReason(
              `Open ${Math.round(ageHours)}h, exceeding ${policy.slaHoursHighPriority}h support SLA`,
            );
          }
        }
      }
    }

    // Target-date checks ONLY when enabled (Milestone default, or explicitly toggled)
    if (policy.enableTargetDateChecks) {
      const itemDateStr = effectiveItemDate(item);
      const isReleaseTagged = Boolean(item.tags && /release:/i.test(item.tags));
      if (!itemDateStr) {
        missingTargetDate += 1;
        confidence = promoteConfidence(
          confidence,
          isReleaseTagged || usesTargetDateField(item.workItemType) ? 'at_risk' : 'uncertain',
        );
        addReason('Missing target/due date under Milestone policy');
      } else {
        const deadlineUtc = parseYmdUtc(itemDateStr);
        if (deadlineUtc) {
          const daysUntil = Math.floor(
            (deadlineUtc.getTime() - todayUtc.getTime()) / (1000 * 60 * 60 * 24),
          );
          if (daysUntil < 0) {
            confidence = promoteConfidence(confidence, 'at_risk');
            addReason(
              `${Math.abs(daysUntil)}d past target date (${itemDateStr.slice(0, 10)}) while in ${item.state}`,
            );
          } else if (daysUntil <= 7 && EARLY_EXECUTION_STATES.has(stateNorm)) {
            confidence = promoteConfidence(confidence, 'at_risk');
            addReason(
              `Due in ${daysUntil}d (${itemDateStr.slice(0, 10)}) while still in ${item.state}`,
            );
          }
        }
      }
    }

    // Pending proposals on this work item
    const itemProposals = proposalsByItem.get(item.id);
    if (itemProposals && itemProposals.length > 0) {
      for (const prop of itemProposals) {
        confidence = promoteConfidence(
          confidence,
          prop.confidence === 'at_risk' ? 'at_risk' : 'uncertain',
        );
        addReason(
          `Pending proposal: set ${prop.fieldName} to "${prop.proposedValue}" (${prop.reason})`,
        );
      }
    }

    itemHealthById[item.id] = {
      workItemId: item.id,
      confidence,
      reasons,
      isBlockedOrStale,
      carryover,
    };

    if (confidence === 'at_risk') {
      atRisk += 1;
    } else if (confidence === 'uncertain') {
      uncertain += 1;
    } else {
      onTrack += 1;
    }
    if (isBlockedOrStale) {
      blockedOrStale += 1;
    }
  }

  let overallHealth: StandupOverallHealth = options.teamPulse?.overallHealth ?? 'on_track';
  if (atRisk >= 2 || (blockedOrStale >= 2 && atRisk >= 1)) {
    overallHealth = 'at_risk';
  } else if (overallHealth === 'on_track' && (atRisk > 0 || uncertain > 0 || blockedOrStale > 0)) {
    overallHealth = 'watch';
  }

  return {
    itemHealthById,
    counts: {
      onTrack,
      uncertain,
      atRisk,
      blockedOrStale,
      missingTargetDate,
      pendingProposals: pendingProposals.length,
    },
    overallHealth,
  };
}
