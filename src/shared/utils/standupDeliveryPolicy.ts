import {
  STANDUP_DELIVERY_MODELS,
  STANDUP_GOAL_SOURCES,
  STANDUP_ROSTER_MODES,
  STANDUP_WORK_DOMAINS,
  STANDUP_WORK_DOMAIN_LABELS,
  type ParticipantCarryoverStreak,
  type ParticipantDetectedException,
  type ParticipantMultiDayArc,
  type ParticipantPreparedBrief,
  type ParticipantStandupNarrative,
  type StandupActionProposal,
  type StandupApprovalAction,
  type StandupAreaBreakdownEntry,
  type StandupCheckInValues,
  type StandupDeliveryModel,
  type StandupDeliveryPolicy,
  type StandupDraftedItem,
  type StandupGoalSource,
  type StandupItemDecision,
  type StandupOverallHealth,
  type StandupRejectedItemRecord,
  type StandupRosterMode,
  type StandupSdlcCallout,
  type StandupStructuredUpdate,
  type StandupSuggestedActivity,
  type StandupTeamPulse,
  type StandupWorkDomain,
} from '../types/standup';

export const MAX_PERSONAL_STANDUP_ITEMS = 3;

export interface EvidenceWorkItem {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  assignedTo?: string;
  assignedToEmail?: string;
  isUnassigned?: boolean;
  changedDate?: string;
  createdDate?: string;
  targetDate?: string | null;
  dueDate?: string | null;
  qaCompleteDate?: string | null;
  iterationPath?: string | null;
  tags?: string;
  priority?: number;
}

export interface EvidenceBuildStageRecord {
  name: string;
  type: string;
  state?: string;
  result?: string;
}

export interface EvidenceBuildSummary {
  buildId: string | number;
  buildNumber: string;
  definitionName: string;
  branch?: string;
  status?: string;
  result?: string;
  finishedAt?: string;
  prId?: number;
  linkedWorkItemIds?: number[];
  stagesAndJobs?: EvidenceBuildStageRecord[];
}

export interface EvidencePullRequest {
  prId: number;
  title: string;
  status: 'active' | 'completed' | 'abandoned';
  createdAt: string;
  closedAt?: string;
  authorEmail?: string;
  linkedWorkItemIds: number[];
  hasApproval?: boolean;
  repositoryName?: string;
  sourceBranch?: string;
  targetBranch?: string;
  changedFiles?: string[];
  builds?: EvidenceBuildSummary[];
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

export interface PriorParticipantSessionRecord {
  sessionDate: string;
  structuredUpdate: StandupStructuredUpdate | null;
}

export interface EvaluateParticipantBriefInput {
  now?: Date | string;
  deliveryModel?: StandupDeliveryModel | string | null;
  teamGoal?: string | null;
  policy?: Partial<StandupDeliveryPolicy> | null;
  expectedIterationPath?: string | null;
  ownerDisplayName?: string | null;
  ownerEmail?: string | null;
  activeWorkItems: EvidenceWorkItem[];
  changedSinceLastWorkItems?: EvidenceWorkItem[];
  pullRequests?: EvidencePullRequest[];
  builds?: EvidenceBuildSummary[];
  pipelineFailures?: EvidencePipelineFailure[];
  priorStructuredUpdate?: StandupStructuredUpdate | null;
  priorHistory?: PriorParticipantSessionRecord[];
  openFollowups?: Array<{ id: string; title: string; sessionDate: string }>;
}

export interface EvaluateSdlcCalloutsInput {
  ownerDisplayName?: string | null;
  activeWorkItems: EvidenceWorkItem[];
  changedSinceLastWorkItems?: EvidenceWorkItem[];
  pullRequests?: EvidencePullRequest[];
  builds?: EvidenceBuildSummary[];
  pipelineFailures?: EvidencePipelineFailure[];
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

export interface ReconcileDraftedUpdateInput {
  draftedItems: StandupDraftedItem[];
  itemDecisions: Record<string, StandupItemDecision>;
  rejectionReasons?: Record<string, string>;
  userCorrections?: string;
  manualYesterday?: string;
  manualToday?: string;
  manualBlockers?: string;
  atRisk?: string;
  handoffs?: string;
  capacity?: string;
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

const QA_OR_RELEASE_STATES = new Set([
  'merged to test',
  'ready for test',
  'in test',
  'uit',
  'uat',
  'ready for release',
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

export function normalizeRosterMode(
  mode?: string | null,
): StandupRosterMode {
  if (mode && (STANDUP_ROSTER_MODES as readonly string[]).includes(mode)) {
    return mode as StandupRosterMode;
  }
  return 'ado_and_groups';
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
  const next = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()),
  );
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

// ── Engineering Domain Categorization ─────────────────────────────────────────

function classifyPathDomains(filePath: string): StandupWorkDomain[] {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const lower = normalized.toLowerCase();
  const matched = new Set<StandupWorkDomain>();

  if (
    /(^|\/)migrations\//.test(lower) ||
    lower.endsWith('.sql') ||
    /(^|\/)[^/]*schema[^/]*\.(ts|js|sql)$/.test(lower) ||
    lower.includes('/drizzle')
  ) {
    matched.add('database');
  }

  if (
    /\.(tf|tfvars|bicep)$/.test(lower) ||
    /(^|\/)infra\//.test(lower) ||
    /(^|\/)\.github\/workflows\//.test(lower) ||
    /azure-pipelines/i.test(lower) ||
    /(^|\/)dockerfile/i.test(lower)
  ) {
    matched.add('iac');
  }

  if (
    /(^|\/)(tests|__tests__|e2e)\//.test(lower) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(lower) ||
    lower.includes('playwright')
  ) {
    matched.add('qa');
  }

  if (
    /(^|\/)(auth|rbac|security|oauth|sso)/.test(lower) ||
    /(auth|rbac|permission|security)\.(ts|tsx|js)$/.test(lower)
  ) {
    matched.add('security');
  }

  if (
    !matched.has('qa') &&
    (/(^|\/)src\/client\//.test(lower) || /\.(tsx|css|scss)$/.test(lower))
  ) {
    matched.add('frontend');
  }

  if (
    !matched.has('qa') &&
    !matched.has('database') &&
    (/(^|\/)src\/server\//.test(lower) || /(^|\/)(routes|services|controllers)\//.test(lower))
  ) {
    matched.add('backend');
  }

  return Array.from(matched);
}

function classifyWorkItemDomain(item: EvidenceWorkItem): StandupWorkDomain {
  const text = `${item.title} ${item.tags ?? ''} ${item.workItemType}`.toLowerCase();
  if (
    /\b(prod[- ]?support|incident|sev[- ]?[12]|outage|hotfix)\b/.test(text) ||
    (item.workItemType.trim().toLowerCase() === 'bug' && item.priority === 1)
  ) {
    return 'prod_support';
  }
  if (/\b(sql|migration|postgres|database|schema|ddl)\b/.test(text)) {
    return 'database';
  }
  if (/\b(terraform|bicep|iac|infra|infrastructure|dockerfile|github actions|pipeline)\b/.test(text)) {
    return 'iac';
  }
  if (
    item.workItemType.trim().toLowerCase() === 'test case' ||
    /\b(qa|e2e|playwright|regression|test suite)\b/.test(text)
  ) {
    return 'qa';
  }
  if (/\b(rbac|sso|oauth|auth|security|cve|permission)\b/.test(text)) {
    return 'security';
  }
  if (/\b(ui|ux|css|modal|component|react|frontend|view|drawer)\b/.test(text)) {
    return 'frontend';
  }
  if (/\b(api|endpoint|service|worker|webhook|backend|queue|mcp)\b/.test(text)) {
    return 'backend';
  }
  return 'general';
}

export function classifyDomainsFromEvidence(
  workItems: EvidenceWorkItem[],
  pullRequests: EvidencePullRequest[] = [],
): StandupWorkDomain[] {
  const domains = new Set<StandupWorkDomain>();

  for (const pr of pullRequests) {
    for (const file of pr.changedFiles ?? []) {
      for (const d of classifyPathDomains(file)) {
        domains.add(d);
      }
    }
    if ((pr.changedFiles ?? []).length === 0 && pr.title) {
      const inferred = classifyWorkItemDomain({
        id: pr.prId,
        title: pr.title,
        workItemType: 'PullRequest',
        state: pr.status,
      });
      if (inferred !== 'general') domains.add(inferred);
    }
  }

  for (const item of workItems) {
    const d = classifyWorkItemDomain(item);
    if (d !== 'general') {
      domains.add(d);
    }
  }

  if (domains.size === 0 && (workItems.length > 0 || pullRequests.length > 0)) {
    domains.add('general');
  }

  return STANDUP_WORK_DOMAINS.filter((d) => domains.has(d));
}

// ── SDLC Process & Release Risk Evaluators ───────────────────────────────────

const SQL_PATH_RE = /(^|\/)migrations\/|\.sql$/i;
const IAC_PATH_RE = /\.(tf|tfvars|bicep)$|(^|\/)infra\//i;
const TEST_PATH_RE = /(^|\/)(__tests__|tests|e2e)\/|\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/i;
const APP_SOURCE_PATH_RE = /(^|\/)src\/(server|client|shared)\/.*\.(ts|tsx|js|jsx)$/i;
const IAC_STAGE_NAME_RE = /terraform|iac|bicep|infra|tf[-_ ]?(plan|validate|check|lint)|\bplan\b|\bvalidate\b/i;

function normalizeBranch(branch?: string | null): string {
  if (!branch) return '';
  return branch.replace(/^refs\/heads\//i, '').trim().toLowerCase();
}

export function evaluateSdlcCallouts(
  input: EvaluateSdlcCalloutsInput,
): StandupSdlcCallout[] {
  const callouts: StandupSdlcCallout[] = [];
  const allItems = [
    ...input.activeWorkItems,
    ...(input.changedSinceLastWorkItems ?? []),
  ];
  const itemById = new Map<number, EvidenceWorkItem>();
  for (const item of allItems) {
    if (!itemById.has(item.id)) itemById.set(item.id, item);
  }

  const prs = (input.pullRequests ?? []).filter((pr) => pr.status !== 'abandoned');
  const allBuilds: EvidenceBuildSummary[] = [...(input.builds ?? [])];
  for (const pr of prs) {
    for (const b of pr.builds ?? []) {
      if (!allBuilds.some((existing) => String(existing.buildId) === String(b.buildId))) {
        allBuilds.push({ ...b, prId: b.prId ?? pr.prId });
      }
    }
  }

  for (const pr of prs) {
    const files = (pr.changedFiles ?? []).map((f) => f.replace(/\\/g, '/').replace(/^\/+/, ''));
    const wiIds = pr.linkedWorkItemIds ?? [];
    const wiLabel = wiIds.length > 0 ? ` (${wiIds.map((id) => `#${id}`).join(', ')})` : '';
    const linkedItems = wiIds.map((id) => itemById.get(id)).filter((i): i is EvidenceWorkItem => Boolean(i));

    // 1. SQL / Migration check
    const sqlFiles = files.filter((f) => SQL_PATH_RE.test(f));
    if (sqlFiles.length > 0) {
      const hasReleaseContext = linkedItems.some(
        (item) =>
          Boolean(item.tags && /release:/i.test(item.tags)) ||
          QA_OR_RELEASE_STATES.has(item.state.trim().toLowerCase()),
      );
      callouts.push({
        id: `sdlc-sql-pr-${pr.prId}`,
        category: 'sql_migration',
        severity: hasReleaseContext ? 'critical' : 'warning',
        domain: 'database',
        title: `SQL / Schema Change Detected (PR !${pr.prId})`,
        detail: `SQL / Schema Change Detected: PR !${pr.prId}${wiLabel} modifies ${sqlFiles.join(', ')} — verify migration rollback, execution order, and release DB step are accounted for.`,
        recommendation:
          'Confirm -- Down Migration reversibility, migration sequence order, and target environment DB execution before release sign-off.',
        ownerDisplayName: input.ownerDisplayName ?? undefined,
        workItemIds: wiIds,
        prIds: [pr.prId],
        filePaths: sqlFiles,
      });
    }

    // 2. Terraform / IaC pipeline stage accuracy check
    const iacFiles = files.filter((f) => IAC_PATH_RE.test(f));
    if (iacFiles.length > 0) {
      const prBranch = normalizeBranch(pr.sourceBranch);
      const matchingBuilds = allBuilds.filter(
        (b) =>
          b.prId === pr.prId ||
          (prBranch && normalizeBranch(b.branch) === prBranch),
      );

      let failureReason: string | null = null;
      let buildLabel = 'CI';

      if (matchingBuilds.length === 0) {
        failureReason = 'no pipeline build ran for the latest PR iteration';
      } else {
        const latestBuild = matchingBuilds[0];
        buildLabel = `${latestBuild.definitionName} #${latestBuild.buildNumber}`;
        const buildRes = (latestBuild.result ?? '').toLowerCase();

        if (buildRes === 'failed' || buildRes === 'canceled') {
          failureReason = `build ended with result "${latestBuild.result}"`;
        } else {
          const stages = latestBuild.stagesAndJobs ?? [];
          const iacStages = stages.filter((s) => IAC_STAGE_NAME_RE.test(s.name));
          if (iacStages.length === 0) {
            failureReason = 'no Terraform/IaC validate or plan stage ran in pipeline timeline';
          } else {
            const failedStage = iacStages.find((s) =>
              ['failed', 'canceled'].includes((s.result ?? '').toLowerCase()),
            );
            const succeededStage = iacStages.find(
              (s) => (s.result ?? '').toLowerCase() === 'succeeded',
            );
            if (failedStage) {
              failureReason = `stage "${failedStage.name}" ${failedStage.result}`;
            } else if (!succeededStage) {
              const firstStage = iacStages[0];
              failureReason = `stage "${firstStage.name}" was ${firstStage.result ?? firstStage.state ?? 'skipped'}`;
            }
          }
        }
      }

      if (failureReason) {
        callouts.push({
          id: `sdlc-iac-pr-${pr.prId}`,
          category: 'iac_pipeline',
          severity: 'critical',
          domain: 'iac',
          title: `IaC Pipeline Verification Alert (PR !${pr.prId})`,
          detail: `IaC Pipeline Verification Alert: PR !${pr.prId}${wiLabel} modifies ${iacFiles.join(', ')}, but pipeline ${buildLabel} did not complete a passing Terraform/IaC validation stage (${failureReason}).`,
          recommendation:
            'Re-run or fix the Terraform/IaC validate & plan pipeline stage and confirm plan output before merging or promoting.',
          ownerDisplayName: input.ownerDisplayName ?? undefined,
          workItemIds: wiIds,
          prIds: [pr.prId],
          filePaths: iacFiles,
        });
      }
    }

    // 3. Source modifications without test file updates
    const appSourceFiles = files.filter(
      (f) => APP_SOURCE_PATH_RE.test(f) && !TEST_PATH_RE.test(f) && !f.endsWith('.d.ts'),
    );
    const testFiles = files.filter((f) => TEST_PATH_RE.test(f));
    if (appSourceFiles.length > 0 && testFiles.length === 0) {
      const domain =
        classifyPathDomains(appSourceFiles[0]).find((d) => d !== 'qa') ?? 'backend';
      callouts.push({
        id: `sdlc-missing-tests-pr-${pr.prId}`,
        category: 'missing_tests',
        severity: 'warning',
        domain,
        title: `Source Changes Without Test Updates (PR !${pr.prId})`,
        detail: `PR !${pr.prId}${wiLabel} modifies ${appSourceFiles.length} source file(s) (${appSourceFiles.slice(0, 2).join(', ')}) with zero unit or E2E test file changes.`,
        recommendation:
          'Verify automated unit or E2E test coverage for modified paths before moving linked items to QA.',
        ownerDisplayName: input.ownerDisplayName ?? undefined,
        workItemIds: wiIds,
        prIds: [pr.prId],
        filePaths: appSourceFiles.slice(0, 5),
      });
    }

    // 4. PR merged while work item state lags
    if (pr.status === 'completed') {
      for (const item of linkedItems) {
        if (EARLY_EXECUTION_STATES.has(item.state.trim().toLowerCase())) {
          callouts.push({
            id: `sdlc-pr-drift-${pr.prId}-${item.id}`,
            category: 'pr_state_drift',
            severity: 'warning',
            domain: classifyWorkItemDomain(item),
            title: `Merged PR With Lagging Work Item State (#${item.id})`,
            detail: `PR !${pr.prId} merged, while #${item.id} (${item.title}) is still [${item.state}].`,
            recommendation: `Confirm pipeline deployment and advance #${item.id} to Ready for Test.`,
            ownerDisplayName: input.ownerDisplayName ?? undefined,
            workItemIds: [item.id],
            prIds: [pr.prId],
          });
        }
      }
    }
  }

  // 5. Work item in QA / Release state while build is failing or PR is still unmerged
  const failedItemIds = new Map<number, string>();
  for (const pf of input.pipelineFailures ?? []) {
    for (const id of pf.linkedWorkItemIds ?? []) {
      failedItemIds.set(
        id,
        `pipeline "${pf.definitionName}" build ${pf.buildNumber} failed`,
      );
    }
  }
  for (const b of allBuilds) {
    if ((b.result ?? '').toLowerCase() === 'failed') {
      const linked = new Set<number>(b.linkedWorkItemIds ?? []);
      if (b.prId) {
        const matchingPr = prs.find((p) => p.prId === b.prId);
        for (const id of matchingPr?.linkedWorkItemIds ?? []) linked.add(id);
      }
      for (const id of linked) {
        failedItemIds.set(
          id,
          `pipeline "${b.definitionName}" build ${b.buildNumber} failed`,
        );
      }
    }
  }

  for (const item of input.activeWorkItems) {
    const stateNorm = item.state.trim().toLowerCase();
    if (!QA_OR_RELEASE_STATES.has(stateNorm)) continue;

    const openPr = prs.find(
      (p) => p.status === 'active' && p.linkedWorkItemIds.includes(item.id),
    );
    const failedBuildDesc = failedItemIds.get(item.id);

    if (failedBuildDesc || openPr) {
      const problem = failedBuildDesc
        ? failedBuildDesc
        : `PR !${openPr!.prId} is still open/unmerged`;
      callouts.push({
        id: `sdlc-red-qa-${item.id}`,
        category: 'red_build_in_qa',
        severity: 'critical',
        domain: 'qa',
        title: `QA / Release Item With Unhealthy Build or Open PR (#${item.id})`,
        detail: `#${item.id} (${item.title}) is in [${item.state}], but ${problem}.`,
        recommendation: `Verify build health or regress #${item.id} to Active/In PR before QA testing proceeds.`,
        ownerDisplayName: input.ownerDisplayName ?? undefined,
        workItemIds: [item.id],
        prIds: openPr ? [openPr.prId] : undefined,
      });
    }
  }

  return callouts;
}

// ── Multi-Day History & Carryover Streak Evaluation ──────────────────────────

function computeMultiDayArc(params: {
  history: PriorParticipantSessionRecord[];
  activeById: Map<number, EvidenceWorkItem>;
  changedById: Map<number, EvidenceWorkItem>;
  mergedPrWorkItemIds: Set<number>;
}): ParticipantMultiDayArc {
  const { history, activeById, changedById, mergedPrWorkItemIds } = params;
  const sessionsAnalyzed = history.length;

  if (sessionsAnalyzed === 0) {
    return {
      sessionsAnalyzed: 0,
      summary: 'First tracked standup in recent window — drafted from current ADO, PR, and pipeline activity.',
      carryoverStreaks: [],
    };
  }

  // Count how many prior standup sessions planned each work item ID in `today`
  const plannedDaysByItem = new Map<number, number>();
  let completedMentions = 0;

  for (const record of history) {
    const update = record.structuredUpdate;
    if (!update) continue;
    const todayIds = extractWorkItemIds(update.today);
    for (const id of todayIds) {
      plannedDaysByItem.set(id, (plannedDaysByItem.get(id) ?? 0) + 1);
    }
    if (update.yesterday?.trim()) {
      const yIds = extractWorkItemIds(update.yesterday);
      completedMentions += Math.max(yIds.length, 1);
    }
  }

  const carryoverStreaks: ParticipantCarryoverStreak[] = [];
  for (const [id, daysPlanned] of plannedDaysByItem.entries()) {
    const item = activeById.get(id) ?? changedById.get(id);
    const stateNorm = (item?.state ?? '').trim().toLowerCase();
    const isCompleted =
      ADVANCED_PROGRESS_STATES.has(stateNorm) ||
      TERMINAL_STATES.has(stateNorm) ||
      mergedPrWorkItemIds.has(id);

    // If still in an early execution state (or untouched across >= 2 sessions, or untouched from immediately prior session)
    if (!isCompleted && (daysPlanned >= 2 || !changedById.has(id))) {
      carryoverStreaks.push({
        workItemId: id,
        title: item?.title ?? `Work Item #${id}`,
        daysCarried: daysPlanned,
      });
    }
  }

  carryoverStreaks.sort((a, b) => b.daysCarried - a.daysCarried || a.workItemId - b.workItemId);

  const recentCorrection = history[0]?.structuredUpdate?.userCorrections?.trim();
  const streakNote =
    carryoverStreaks.length > 0
      ? `carrying ${carryoverStreaks
          .slice(0, 2)
          .map((s) => `#${s.workItemId} (${s.daysCarried}d)`)
          .join(', ')}`
      : 'zero multi-day carryovers';

  const summary =
    `Across ${sessionsAnalyzed} prior standup${sessionsAnalyzed === 1 ? '' : 's'}: ` +
    `${completedMentions} progress update${completedMentions === 1 ? '' : 's'} logged, ${streakNote}` +
    (recentCorrection ? ` · Last note: "${recentCorrection}"` : '.');

  return {
    sessionsAnalyzed,
    summary,
    carryoverStreaks,
  };
}

// ── Ownership Attribution & Check-In Validation ──────────────────────────────

function truncateBriefText(text: string, maxLen = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`;
}

export function classifyWorkItemOwnership(
  item: EvidenceWorkItem,
  ownerEmail?: string | null,
  ownerDisplayName?: string | null,
): 'owned' | 'other_owner' | 'unassigned' | 'unspecified' {
  if (item.isUnassigned) return 'unassigned';

  const itemEmail = item.assignedToEmail?.trim().toLowerCase() ?? '';
  const itemAssignee = item.assignedTo?.trim().toLowerCase() ?? '';
  if (!itemEmail && !itemAssignee) {
    return 'unspecified';
  }

  const ownerEmailNorm = ownerEmail?.trim().toLowerCase() ?? '';
  const ownerNameNorm = ownerDisplayName?.trim().toLowerCase() ?? '';
  if (!ownerEmailNorm && !ownerNameNorm) {
    return 'unspecified';
  }

  if (
    ownerEmailNorm &&
    (itemEmail === ownerEmailNorm ||
      itemAssignee === ownerEmailNorm ||
      itemAssignee.includes(`<${ownerEmailNorm}>`))
  ) {
    return 'owned';
  }
  if (ownerNameNorm && itemAssignee === ownerNameNorm) {
    return 'owned';
  }

  return 'other_owner';
}

export function validateStandupCheckIn(
  values: Partial<StandupCheckInValues> | null | undefined,
): { ok: true; value: StandupCheckInValues } | { ok: false; error: string } {
  if (!values || typeof values !== 'object') {
    return { ok: false, error: "Please enter today's focus before submitting." };
  }
  const today = typeof values.today === 'string' ? values.today.trim() : '';
  const yesterday =
    typeof values.yesterday === 'string' ? values.yesterday.trim() : '';
  const blockers =
    typeof values.blockers === 'string' ? values.blockers.trim() : '';
  const handoffs =
    typeof values.handoffs === 'string' ? values.handoffs.trim() : '';
  const capacity =
    typeof values.capacity === 'string' ? values.capacity.trim() : '';
  const userCorrections =
    typeof values.userCorrections === 'string'
      ? values.userCorrections.trim()
      : '';

  if (!today && !yesterday && !blockers) {
    return {
      ok: false,
      error: "Please share at least today's focus (or progress / blocker) before submitting.",
    };
  }
  if (today.length > 2000 || yesterday.length > 2000) {
    return { ok: false, error: 'Standup update text exceeds the 2,000-character limit.' };
  }

  return {
    ok: true,
    value: {
      yesterday,
      today: today || 'Continuing current priorities',
      ...(blockers ? { blockers } : {}),
      ...(handoffs ? { handoffs } : {}),
      ...(capacity ? { capacity } : {}),
      ...(userCorrections ? { userCorrections } : {}),
    },
  };
}

// ── Participant Prepared Brief Evaluation ────────────────────────────────────

export function evaluateParticipantBrief(
  input: EvaluateParticipantBriefInput,
): ParticipantPreparedBrief {
  const now = toDate(input.now) ?? new Date();
  const deliveryModel = normalizeDeliveryModel(input.deliveryModel);
  const policy = resolveStandupPolicy(deliveryModel, input.policy);
  const rawChangedItems = input.changedSinceLastWorkItems ?? [];
  const rawPrs = policy.enablePrEvidence ? (input.pullRequests ?? []) : [];
  const builds = policy.enablePipelineEvidence ? (input.builds ?? []) : [];
  const pipelineFailures = policy.enablePipelineEvidence
    ? (input.pipelineFailures ?? [])
    : [];

  // Normalize prior history (prefer multi-day `priorHistory`, fallback to single `priorStructuredUpdate`)
  const history: PriorParticipantSessionRecord[] =
    input.priorHistory && input.priorHistory.length > 0
      ? input.priorHistory
      : input.priorStructuredUpdate
      ? [{ sessionDate: 'prior', structuredUpdate: input.priorStructuredUpdate }]
      : [];
  const latestPriorUpdate = history[0]?.structuredUpdate ?? input.priorStructuredUpdate ?? null;

  const priorMentionedIds = new Set<number>();
  for (const rec of history) {
    const u = rec.structuredUpdate;
    if (!u) continue;
    for (const id of extractWorkItemIds(`${u.yesterday ?? ''} ${u.today ?? ''}`)) {
      priorMentionedIds.add(id);
    }
  }

  const suggestedActivity: StandupSuggestedActivity[] = [];
  const seenSuggestedIds = new Set<string>();
  const pushSuggested = (entry: StandupSuggestedActivity) => {
    if (seenSuggestedIds.has(entry.id)) return;
    seenSuggestedIds.add(entry.id);
    suggestedActivity.push(entry);
  };

  // Enforce strict owner attribution on active items
  const ownedActiveInputItems: EvidenceWorkItem[] = [];
  for (const item of input.activeWorkItems) {
    const ownership = classifyWorkItemOwnership(
      item,
      input.ownerEmail,
      input.ownerDisplayName,
    );
    if (ownership === 'other_owner') {
      pushSuggested({
        id: `suggested-wi-${item.id}`,
        bucket: 'today',
        summary: `#${item.id} ${item.title} [${item.state}]`,
        source: 'ado',
        actor: input.ownerDisplayName ?? input.ownerEmail ?? undefined,
        owner: item.assignedTo ?? item.assignedToEmail,
        workItemId: item.id,
        attribution: 'suggested',
        reason: `Assigned to ${item.assignedTo ?? item.assignedToEmail ?? 'another teammate'}`,
      });
      continue;
    }
    ownedActiveInputItems.push(item);
  }

  const activeById = new Map<number, EvidenceWorkItem>();
  for (const item of ownedActiveInputItems) {
    activeById.set(item.id, item);
  }

  // Enforce strict actor-vs-owner attribution on ChangedBy items
  const changedItems: EvidenceWorkItem[] = [];
  for (const item of rawChangedItems) {
    const ownership = classifyWorkItemOwnership(
      item,
      input.ownerEmail,
      input.ownerDisplayName,
    );
    if (ownership === 'other_owner') {
      pushSuggested({
        id: `suggested-wi-${item.id}`,
        bucket: 'yesterday',
        summary: `#${item.id} ${item.title} [${item.state}]`,
        source: 'ado',
        actor: input.ownerDisplayName ?? input.ownerEmail ?? undefined,
        owner: item.assignedTo ?? item.assignedToEmail,
        workItemId: item.id,
        attribution: 'suggested',
        reason: `Assigned to ${item.assignedTo ?? item.assignedToEmail ?? 'another teammate'} — you updated it`,
      });
      continue;
    }
    if (
      ownership === 'unassigned' &&
      !activeById.has(item.id) &&
      !priorMentionedIds.has(item.id) &&
      !TERMINAL_STATES.has(item.state.trim().toLowerCase())
    ) {
      pushSuggested({
        id: `suggested-wi-${item.id}`,
        bucket: 'yesterday',
        summary: `#${item.id} ${item.title} [${item.state}]`,
        source: 'ado',
        actor: input.ownerDisplayName ?? input.ownerEmail ?? undefined,
        workItemId: item.id,
        attribution: 'suggested',
        reason: 'Unassigned item you updated',
      });
      continue;
    }
    changedItems.push(item);
  }

  const changedById = new Map<number, EvidenceWorkItem>();
  for (const item of changedItems) {
    changedById.set(item.id, item);
  }

  // Filter PRs to those authored by this participant (never claim a teammate's PR)
  const ownerEmailLower = input.ownerEmail?.trim().toLowerCase() ?? '';
  const prs: EvidencePullRequest[] = [];
  for (const pr of rawPrs) {
    const prAuthorLower = pr.authorEmail?.trim().toLowerCase() ?? '';
    if (ownerEmailLower && prAuthorLower && prAuthorLower !== ownerEmailLower) {
      pushSuggested({
        id: `suggested-pr-${pr.prId}`,
        bucket: 'yesterday',
        summary: `PR !${pr.prId}: ${pr.title}`,
        source: 'ado',
        actor: input.ownerDisplayName ?? input.ownerEmail ?? undefined,
        owner: pr.authorEmail,
        prId: pr.prId,
        workItemId: pr.linkedWorkItemIds[0],
        attribution: 'suggested',
        reason: `Authored by ${pr.authorEmail}`,
      });
      continue;
    }
    prs.push(pr);
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

  if (policy.enableCommitmentMemory && latestPriorUpdate?.today?.trim()) {
    const segments = parseCommitmentSegments(latestPriorUpdate.today);
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

      if (status === 'untouched' && ids.length > 0) {
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

  const multiDayArc = computeMultiDayArc({
    history: policy.enableCommitmentMemory ? history : [],
    activeById,
    changedById,
    mergedPrWorkItemIds,
  });

  for (const streak of multiDayArc.carryoverStreaks) {
    carryoverWorkItemIds.add(streak.workItemId);
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

  // Pipeline failure checks (both explicit pipelineFailures and failed builds)
  const seenBuildFailures = new Set<string>();
  for (const failure of pipelineFailures) {
    const key = String(failure.buildId);
    seenBuildFailures.add(key);
    detectedExceptions.push({
      id: `pipeline-fail-${failure.buildId}`,
      kind: 'pipeline_failure',
      severity: 'critical',
      message: `Pipeline "${failure.definitionName}" build ${failure.buildNumber} failed${failure.branch ? ` on ${failure.branch}` : ''}.`,
      workItemId: failure.linkedWorkItemIds?.[0],
      prId: failure.prId,
    });
  }
  for (const b of builds) {
    const key = String(b.buildId);
    if (!seenBuildFailures.has(key) && (b.result ?? '').toLowerCase() === 'failed') {
      seenBuildFailures.add(key);
      detectedExceptions.push({
        id: `pipeline-fail-${b.buildId}`,
        kind: 'pipeline_failure',
        severity: 'critical',
        message: `Pipeline "${b.definitionName}" build ${b.buildNumber} failed${b.branch ? ` on ${b.branch}` : ''}.`,
        workItemId: b.linkedWorkItemIds?.[0],
        prId: b.prId,
      });
    }
  }

  // WIP check
  const nonTerminalActive = ownedActiveInputItems.filter(
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

  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const riskFlagsByItemId = new Map<number, string[]>();
  const addRiskFlag = (id: number, flag: string) => {
    const existing = riskFlagsByItemId.get(id) ?? [];
    if (!existing.includes(flag)) {
      existing.push(flag);
      riskFlagsByItemId.set(id, existing);
    }
  };

  for (const id of carryoverWorkItemIds) {
    const streak = multiDayArc.carryoverStreaks.find((s) => s.workItemId === id);
    addRiskFlag(
      id,
      streak && streak.daysCarried >= 2 ? `Carryover ${streak.daysCarried}d` : 'Carryover',
    );
  }

  // Per-item checks
  for (const item of nonTerminalActive) {
    const stateNorm = item.state.trim().toLowerCase();

    if (INTERIM_ACTIVE_STATES.has(stateNorm) && item.changedDate) {
      const changed = toDate(item.changedDate);
      if (changed) {
        const staleDays =
          (now.getTime() - changed.getTime()) / (1000 * 60 * 60 * 24);
        if (staleDays >= policy.staleDaysThreshold) {
          const roundedDays = Math.floor(staleDays);
          addRiskFlag(item.id, `Stale ${roundedDays}d`);
          detectedExceptions.push({
            id: `stale-${item.id}`,
            kind: 'stale_state',
            severity:
              roundedDays >= policy.staleDaysThreshold * 2 ? 'critical' : 'warning',
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

    if (
      deliveryModel === 'sprint' &&
      input.expectedIterationPath &&
      item.iterationPath &&
      item.iterationPath !== input.expectedIterationPath
    ) {
      addRiskFlag(item.id, 'Outside sprint');
    }

    if (policy.slaHoursHighPriority != null) {
      const isHighPriSupportItem =
        item.workItemType.trim().toLowerCase() === 'bug' ||
        (typeof item.priority === 'number' && item.priority <= 2);
      if (isHighPriSupportItem) {
        const anchorDate = toDate(item.createdDate) ?? toDate(item.changedDate);
        if (anchorDate) {
          const ageHours =
            (now.getTime() - anchorDate.getTime()) / (1000 * 60 * 60);
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

    if (policy.enableTargetDateChecks) {
      const itemDateStr = effectiveItemDate(item);
      const dateFieldName = usesTargetDateField(item.workItemType)
        ? 'targetDate'
        : 'dueDate';
      const isReleaseTagged = Boolean(item.tags && /release:/i.test(item.tags));

      if (!itemDateStr) {
        if (
          isReleaseTagged ||
          WIP_ACTIVE_STATES.has(stateNorm) ||
          usesTargetDateField(item.workItemType)
        ) {
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

  const suggestedToday: ParticipantPreparedBrief['suggestedToday'] = [
    ...nonTerminalActive,
  ]
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

  const workDomains = classifyDomainsFromEvidence(
    [...nonTerminalActive, ...changedItems],
    prs,
  );

  const sdlcCallouts = evaluateSdlcCallouts({
    ownerDisplayName: input.ownerDisplayName ?? null,
    activeWorkItems: nonTerminalActive,
    changedSinceLastWorkItems: changedItems,
    pullRequests: prs,
    builds,
    pipelineFailures,
  });

  const hasExternalEvidence =
    nonTerminalActive.length > 0 || changedItems.length > 0 || prs.length > 0;

  // Pre-drafted items (strictly capped at MAX_PERSONAL_STANDUP_ITEMS per personal bucket)
  const draftedItems: StandupDraftedItem[] = [];
  accomplishedSinceLast.forEach((acc, idx) => {
    const wi = acc.workItemId
      ? changedById.get(acc.workItemId) ?? activeById.get(acc.workItemId)
      : undefined;
    const pr = acc.prId ? prs.find((p) => p.prId === acc.prId) : undefined;
    const domain =
      pr && (pr.changedFiles ?? []).length > 0
        ? classifyDomainsFromEvidence([], [pr])[0]
        : wi
        ? classifyWorkItemDomain(wi)
        : 'general';
    const summaryText = acc.prId
      ? `Merged PR !${acc.prId}: ${acc.title}${acc.workItemId ? ` (#${acc.workItemId})` : ''}`
      : `#${acc.workItemId} ${acc.title}${acc.state ? ` [${acc.state}]` : ''}`;

    if (idx < MAX_PERSONAL_STANDUP_ITEMS) {
      draftedItems.push({
        id: acc.prId
          ? `draft-yesterday-pr-${acc.prId}`
          : acc.workItemId
          ? `draft-yesterday-wi-${acc.workItemId}`
          : `draft-yesterday-${idx}`,
        bucket: 'yesterday',
        summary: summaryText,
        workItemId: acc.workItemId,
        prId: acc.prId,
        domain,
        evidence: acc.evidence,
        attribution: 'confirmed',
      });
    } else {
      pushSuggested({
        id: acc.prId
          ? `suggested-overflow-pr-${acc.prId}`
          : `suggested-overflow-wi-${acc.workItemId ?? idx}`,
        bucket: 'yesterday',
        summary: summaryText,
        source: acc.prId ? 'github' : 'ado',
        workItemId: acc.workItemId,
        prId: acc.prId,
        attribution: 'suggested',
        reason: 'Additional recent update',
      });
    }
  });

  suggestedToday.forEach((item, idx) => {
    const fullItem = activeById.get(item.workItemId);
    const domain = fullItem ? classifyWorkItemDomain(fullItem) : 'general';
    const flagSuffix =
      item.riskFlags.length > 0 ? ` (${item.riskFlags.join(', ')})` : '';
    const summaryText = `#${item.workItemId} ${item.title} [${item.state}]${flagSuffix}`;

    if (idx < MAX_PERSONAL_STANDUP_ITEMS) {
      draftedItems.push({
        id: `draft-today-wi-${item.workItemId}`,
        bucket: 'today',
        summary: summaryText,
        workItemId: item.workItemId,
        domain,
        evidence: item.iterationPath
          ? `Assigned in ${item.iterationPath}`
          : 'Assigned to you',
        attribution: 'confirmed',
      });
    } else if (idx < 8) {
      pushSuggested({
        id: `suggested-today-wi-${item.workItemId}`,
        bucket: 'today',
        summary: summaryText,
        source: 'ado',
        workItemId: item.workItemId,
        attribution: 'suggested',
        reason: 'Additional assigned item',
      });
    }
  });

  let blockerDraftCount = 0;
  for (const callout of sdlcCallouts) {
    if (blockerDraftCount >= 2) break;
    if (callout.severity === 'critical' || callout.category === 'sql_migration') {
      draftedItems.push({
        id: `draft-blocker-${callout.id}`,
        bucket: 'blocker',
        summary: callout.detail,
        workItemId: callout.workItemIds[0],
        prId: callout.prIds?.[0],
        domain: callout.domain,
        evidence: `SDLC ${callout.category}`,
        attribution: 'confirmed',
      });
      blockerDraftCount += 1;
    }
  }

  for (const ex of detectedExceptions) {
    if (blockerDraftCount >= 2) break;
    if (
      ex.kind === 'pipeline_failure' ||
      ex.kind === 'sla_breach' ||
      ex.kind === 'pr_waiting_review'
    ) {
      draftedItems.push({
        id: `draft-blocker-${ex.id}`,
        bucket: 'blocker',
        summary: ex.message,
        workItemId: ex.workItemId,
        prId: ex.prId,
        domain: ex.kind === 'pipeline_failure' ? 'iac' : 'general',
        evidence: ex.kind,
        attribution: 'confirmed',
      });
      blockerDraftCount += 1;
    }
  }

  // Generic / non-ADO history continuity suggestion
  if (!hasExternalEvidence && latestPriorUpdate?.today?.trim()) {
    pushSuggested({
      id: 'suggested-history-prior-today',
      bucket: 'yesterday',
      summary: latestPriorUpdate.today.trim(),
      source: 'history',
      attribution: 'suggested',
      reason: 'Planned in your previous check-in',
    });
  }

  // Recommended focus synthesis
  const criticalSdlc = sdlcCallouts.find((c) => c.severity === 'critical');
  const criticalEx = detectedExceptions.find((e) => e.severity === 'critical');
  const topStreak = multiDayArc.carryoverStreaks.find((s) => s.daysCarried >= 2);
  const topToday = suggestedToday[0];

  let recommendedFocus: string;
  if (criticalSdlc) {
    recommendedFocus = `${criticalSdlc.title} — ${criticalSdlc.recommendation}`;
  } else if (criticalEx) {
    recommendedFocus = `Resolve critical impediment first: ${criticalEx.message}`;
  } else if (topStreak) {
    recommendedFocus = `Close out multi-day carryover #${topStreak.workItemId} (${topStreak.title}, carried ${topStreak.daysCarried} standups) before starting net-new work.`;
  } else if (topToday) {
    recommendedFocus = input.teamGoal
      ? `Advance #${topToday.workItemId} (${topToday.title}) toward Team Goal: "${input.teamGoal}".`
      : `Progress #${topToday.workItemId} (${topToday.title}) [${topToday.state}] and keep active WIP moving cleanly.`;
  } else {
    recommendedFocus = input.teamGoal
      ? `Share the main priority moving "${input.teamGoal}" forward today.`
      : 'Share your main focus for today and flag anything blocking progress.';
  }

  // AI-proposed contextual check-in questions (generic first, works with or without ADO)
  const proposedQuestions: string[] = [];
  const openFollowups = input.openFollowups ?? [];
  if (latestPriorUpdate?.blockers && !isNoneLike(latestPriorUpdate.blockers)) {
    proposedQuestions.push(
      `Last check-in you flagged a blocker (“${truncateBriefText(latestPriorUpdate.blockers, 80)}”) — is it cleared or do you still need help?`,
    );
  } else if (openFollowups.length > 0) {
    proposedQuestions.push(
      `Open standup follow-up: “${truncateBriefText(openFollowups[0].title, 80)}” — any update for the team?`,
    );
  }

  if (proposedQuestions.length < 2) {
    if (topStreak) {
      proposedQuestions.push(
        `#${topStreak.workItemId} (${truncateBriefText(topStreak.title, 60)}) has carried across ${topStreak.daysCarried} check-ins — can it wrap today, or is something blocking it?`,
      );
    } else if (!hasExternalEvidence && latestPriorUpdate?.today?.trim()) {
      proposedQuestions.push(
        `Last check-in you planned: “${truncateBriefText(latestPriorUpdate.today, 85)}”. Did that finish, or does part of it carry into today?`,
      );
    } else if (criticalSdlc) {
      proposedQuestions.push(`${criticalSdlc.title}: ${criticalSdlc.recommendation}`);
    } else if (criticalEx) {
      proposedQuestions.push(`Needs attention: ${criticalEx.message}`);
    }
  }

  if (proposedQuestions.length === 0) {
    proposedQuestions.push(
      input.teamGoal?.trim()
        ? `What moved forward since last check-in, and how does today's focus advance “${truncateBriefText(input.teamGoal, 75)}”?`
        : 'What moved forward since last check-in, what is your #1 focus today, and do you need help from anyone?',
    );
  }

  return {
    generatedAt: now.toISOString(),
    deliveryModel,
    teamGoal: input.teamGoal ?? null,
    accomplishedSinceLast,
    priorCommitments,
    suggestedToday,
    detectedExceptions,
    openFollowups,
    draftedItems,
    suggestedActivity,
    proposedQuestions: proposedQuestions.slice(0, 2),
    hasExternalEvidence,
    recommendedFocus,
    multiDayArc,
    workDomains,
    sdlcCallouts,
  };
}

// ── Reconcile Pre-Drafted Standup Decisions & User Corrections ───────────────

export function reconcileDraftedUpdate(
  input: ReconcileDraftedUpdateInput,
): StandupStructuredUpdate {
  const { draftedItems, itemDecisions, rejectionReasons } = input;
  const approvedByBucket: Record<'yesterday' | 'today' | 'blocker', string[]> = {
    yesterday: [],
    today: [],
    blocker: [],
  };
  const rejectedItems: StandupRejectedItemRecord[] = [];
  const normalizedDecisions: Record<string, StandupItemDecision> = {};

  for (const item of draftedItems) {
    const decision: StandupItemDecision =
      itemDecisions[item.id] === 'rejected' ? 'rejected' : 'approved';
    normalizedDecisions[item.id] = decision;
    if (decision === 'approved') {
      approvedByBucket[item.bucket].push(item.summary);
    } else {
      const reason = rejectionReasons?.[item.id]?.trim();
      rejectedItems.push({
        id: item.id,
        summary: item.summary,
        ...(reason ? { reason } : {}),
      });
    }
  }

  const trimmedCorrections = input.userCorrections?.trim() || '';
  const manualYesterday = input.manualYesterday?.trim() ?? '';
  const manualToday = input.manualToday?.trim() ?? '';
  const manualBlockers = input.manualBlockers?.trim() ?? '';

  const yesterdayBase =
    manualYesterday || approvedByBucket.yesterday.join('; ');
  let todayBase = manualToday || approvedByBucket.today.join('; ');
  if (trimmedCorrections && !todayBase.includes(trimmedCorrections)) {
    todayBase = todayBase
      ? `${todayBase} (Correction/Note: ${trimmedCorrections})`
      : trimmedCorrections;
  }
  const blockersBase =
    manualBlockers || approvedByBucket.blocker.join('; ');

  let approvalAction: StandupApprovalAction = 'approved';
  if (
    draftedItems.length > 0 &&
    rejectedItems.length === draftedItems.length
  ) {
    approvalAction = 'rejected_rewritten';
  } else if (rejectedItems.length > 0 || Boolean(trimmedCorrections)) {
    approvalAction = 'approved_with_edits';
  }

  return {
    yesterday: yesterdayBase,
    today: todayBase,
    blockers: blockersBase,
    atRisk: input.atRisk?.trim() ?? '',
    handoffs: input.handoffs?.trim() ?? '',
    capacity: input.capacity?.trim() ?? '',
    itemDecisions: normalizedDecisions,
    ...(rejectedItems.length > 0 ? { rejectedItems } : {}),
    ...(trimmedCorrections ? { userCorrections: trimmedCorrections } : {}),
    approvalAction,
  };
}

// ── Team Pulse Synthesis (SDLC Callouts, Area Breakdown & Narratives) ────────

function classifyBlockerType(
  text: string,
): 'pipeline' | 'person' | 'external' | 'incident' | 'other' {
  const lower = text.toLowerCase();
  if (/prod(uction)?\b|incident|outage|sev[- ]?[12]|sla\b/.test(lower)) {
    return 'incident';
  }
  if (/pipeline|build|ci\b|deploy|terraform|iac|test runner/.test(lower)) {
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

function inferDomainsFromUpdateText(update?: StandupStructuredUpdate | null): StandupWorkDomain[] {
  if (!update) return ['general'];
  const combined = `${update.yesterday ?? ''} ${update.today ?? ''} ${update.blockers ?? ''} ${update.userCorrections ?? ''}`;
  if (!combined.trim()) return ['general'];
  const domain = classifyWorkItemDomain({
    id: 0,
    title: combined,
    workItemType: 'Task',
    state: 'Active',
  });
  return [domain];
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
  const sdlcCalloutMap = new Map<string, StandupSdlcCallout>();
  const individualNarratives: ParticipantStandupNarrative[] = [];

  const areaAccumulator = new Map<
    StandupWorkDomain,
    {
      activeItemIds: Set<number>;
      fallbackCount: number;
      contributors: Set<string>;
      focusCandidates: string[];
      riskCount: number;
    }
  >();

  const ensureArea = (domain: StandupWorkDomain) => {
    let entry = areaAccumulator.get(domain);
    if (!entry) {
      entry = {
        activeItemIds: new Set<number>(),
        fallbackCount: 0,
        contributors: new Set<string>(),
        focusCandidates: [],
        riskCount: 0,
      };
      areaAccumulator.set(domain, entry);
    }
    return entry;
  };

  let submittedCount = 0;

  for (const participant of input.participants) {
    const label = participant.displayName?.trim() || participant.userId;
    const isSubmitted = participant.status === 'submitted';
    if (isSubmitted) {
      submittedCount += 1;
    }

    const update = participant.structuredUpdate;
    const brief = participant.preparedBrief;
    const participantDomains =
      brief?.workDomains && brief.workDomains.length > 0
        ? brief.workDomains
        : inferDomainsFromUpdateText(update);

    // Individual standup narrative (for BOTH confirmed and unsubmitted AI-drafted participants)
    const carryoverStreakCount = brief?.multiDayArc?.carryoverStreaks?.length ?? 0;
    const untouchedCount =
      brief?.priorCommitments?.filter(
        (c) => c.status === 'untouched' && c.workItemIds.length > 0,
      ).length ?? 0;
    const carryoverCount = Math.max(carryoverStreakCount, untouchedCount);

    const hasDraftEvidence =
      Boolean(brief?.hasExternalEvidence) ||
      (brief?.draftedItems?.length ?? 0) > 0 ||
      (brief?.accomplishedSinceLast?.length ?? 0) > 0 ||
      (brief?.suggestedToday?.length ?? 0) > 0;

    const draftedYesterday =
      brief?.draftedItems
        ?.filter((i) => i.bucket === 'yesterday')
        .map((i) => i.summary)
        .join('; ') ||
      brief?.accomplishedSinceLast
        ?.slice(0, 3)
        .map((a) => (a.workItemId ? `#${a.workItemId} ${a.title}` : a.title))
        .join('; ') ||
      'No update submitted yet.';

    const draftedToday = hasDraftEvidence
      ? brief?.recommendedFocus ||
        brief?.draftedItems
          ?.filter((i) => i.bucket === 'today')
          .slice(0, 3)
          .map((i) => i.summary)
          .join('; ') ||
        'Waiting for check-in.'
      : 'Waiting for check-in.';

    const draftedBlockers =
      brief?.draftedItems
        ?.filter((i) => i.bucket === 'blocker')
        .map((i) => i.summary)
        .join('; ') || 'None';

    if (isSubmitted && update) {
      individualNarratives.push({
        userId: participant.userId,
        displayName: label,
        status: 'confirmed',
        domains: participantDomains,
        arcSummary:
          brief?.multiDayArc?.summary ??
          'Submitted for today.',
        yesterdaySummary:
          update.yesterday?.trim() || 'No updates reported since last check-in.',
        todayFocus:
          update.today?.trim() || draftedToday,
        blockersSummary: !isNoneLike(update.blockers)
          ? update.blockers!.trim()
          : 'None',
        ...(update.handoffs && !isNoneLike(update.handoffs)
          ? { handoffsSummary: update.handoffs.trim() }
          : {}),
        ...(update.capacity && !isNoneLike(update.capacity)
          ? { capacitySummary: update.capacity.trim() }
          : {}),
        ...(update.userCorrections?.trim()
          ? { userCorrections: update.userCorrections.trim() }
          : {}),
        carryoverCount,
      });
    } else {
      individualNarratives.push({
        userId: participant.userId,
        displayName: label,
        status: 'ai_drafted',
        domains: participantDomains,
        arcSummary:
          brief?.multiDayArc?.summary ??
          (hasDraftEvidence
            ? 'Awaiting member confirmation.'
            : 'Waiting for check-in.'),
        yesterdaySummary: draftedYesterday,
        todayFocus: draftedToday,
        blockersSummary: draftedBlockers,
        carryoverCount,
      });
    }

    // Populate area breakdown from participant domains & items
    for (const domain of participantDomains) {
      const area = ensureArea(domain);
      area.contributors.add(label);
    }
    for (const item of brief?.suggestedToday ?? []) {
      const itemDomain = classifyWorkItemDomain({
        id: item.workItemId,
        title: item.title,
        workItemType: item.workItemType,
        state: item.state,
      });
      const area = ensureArea(
        itemDomain === 'general' && participantDomains[0]
          ? participantDomains[0]
          : itemDomain,
      );
      area.contributors.add(label);
      area.activeItemIds.add(item.workItemId);
      if (area.focusCandidates.length < 2) {
        area.focusCandidates.push(`#${item.workItemId} ${item.title}`);
      }
      if (item.riskFlags.length > 0) {
        area.riskCount += 1;
      }
    }
    if ((brief?.suggestedToday?.length ?? 0) === 0 && update?.today?.trim()) {
      const primaryDomain = participantDomains[0] ?? 'general';
      const area = ensureArea(primaryDomain);
      const ids = extractWorkItemIds(update.today);
      if (ids.length > 0) {
        ids.forEach((id) => area.activeItemIds.add(id));
      } else {
        area.fallbackCount += 1;
      }
      if (area.focusCandidates.length < 2) {
        area.focusCandidates.push(update.today.trim());
      }
    }

    // Roll up SDLC callouts from participant brief
    for (const callout of brief?.sdlcCallouts ?? []) {
      const enrichedCallout: StandupSdlcCallout = {
        ...callout,
        ownerDisplayName: callout.ownerDisplayName ?? label,
      };
      sdlcCalloutMap.set(callout.id, enrichedCallout);
      const area = ensureArea(callout.domain);
      area.contributors.add(label);
      callout.workItemIds.forEach((id) => area.activeItemIds.add(id));
      area.riskCount += 1;
      area.focusCandidates.unshift(callout.title);
      if (callout.severity === 'critical') {
        decisionsSet.add(`${callout.title}: ${callout.recommendation}`);
      }
    }

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
        decisionsSet.add(
          `Resolve ${blockerType} blocker reported by ${label}: ${blockerText}`,
        );
      }
    }

    if (brief) {
      for (const streak of brief.multiDayArc?.carryoverStreaks ?? []) {
        if (streak.daysCarried >= 2) {
          const existingCarry = carryoverAlerts.find(
            (c) => c.userId === participant.userId,
          );
          const msg = `#${streak.workItemId} (${streak.title}) carried across ${streak.daysCarried} standups without completion.`;
          if (existingCarry) {
            if (!existingCarry.workItemIds.includes(streak.workItemId)) {
              existingCarry.workItemIds.push(streak.workItemId);
            }
            if (!existingCarry.summary.includes(`#${streak.workItemId}`)) {
              existingCarry.summary = `${existingCarry.summary}; ${msg}`;
            }
          } else {
            carryoverAlerts.push({
              userId: participant.userId,
              displayName: label,
              summary: msg,
              workItemIds: [streak.workItemId],
            });
          }
        }
      }

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
          const existingCarry = carryoverAlerts.find(
            (c) => c.userId === participant.userId,
          );
          const ids = ex.workItemId ? [ex.workItemId] : [];
          if (existingCarry) {
            for (const id of ids) {
              if (!existingCarry.workItemIds.includes(id)) {
                existingCarry.workItemIds.push(id);
              }
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
            ex.severity === 'critical' ||
            ex.kind === 'target_date_at_risk' ||
            ex.kind === 'sla_breach'
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

  const pendingProposals = (input.proposals ?? []).filter(
    (p) => p.status === 'pending',
  );
  if (pendingProposals.length > 0) {
    decisionsSet.add(
      `Confirm or dismiss ${pendingProposals.length} staged ADO update proposal${pendingProposals.length === 1 ? '' : 's'}.`,
    );
  }

  const sdlcCallouts = Array.from(sdlcCalloutMap.values()).sort((a, b) => {
    const rank = { critical: 0, warning: 1, info: 2 };
    return rank[a.severity] - rank[b.severity];
  });

  const areaBreakdown: StandupAreaBreakdownEntry[] = STANDUP_WORK_DOMAINS.filter(
    (domain) => areaAccumulator.has(domain),
  ).map((domain) => {
    const entry = areaAccumulator.get(domain)!;
    const count = entry.activeItemIds.size + entry.fallbackCount;
    return {
      domain,
      label: STANDUP_WORK_DOMAIN_LABELS[domain],
      activeItemCount: Math.max(count, entry.contributors.size > 0 ? 1 : 0),
      contributors: Array.from(entry.contributors),
      keyFocus:
        entry.focusCandidates[0] ??
        `Active ${STANDUP_WORK_DOMAIN_LABELS[domain]} work in flight`,
      riskCount: entry.riskCount,
    };
  });

  const atRiskItems = Array.from(atRiskMap.values());
  const hasCriticalBlocker = blockers.some(
    (b) => b.blockerType === 'incident' || b.blockerType === 'pipeline',
  );
  const hasCriticalSdlc = sdlcCallouts.some((c) => c.severity === 'critical');
  const highRiskCount = atRiskItems.filter(
    (item) => item.confidence === 'at_risk',
  ).length;

  let overallHealth: StandupOverallHealth = 'on_track';
  if (
    hasCriticalBlocker ||
    hasCriticalSdlc ||
    blockers.length >= 2 ||
    highRiskCount >= 2
  ) {
    overallHealth = 'at_risk';
  } else if (
    blockers.length > 0 ||
    sdlcCallouts.length > 0 ||
    atRiskItems.length > 0 ||
    carryoverAlerts.length > 0
  ) {
    overallHealth = 'watch';
  }

  // Order readout cards so confirmed submissions appear first for reading out loud
  individualNarratives.sort((a, b) => {
    if (a.status === b.status) return 0;
    return a.status === 'confirmed' ? -1 : 1;
  });

  const totalParticipants = input.participants.length;
  const summaryParts = [
    `${submittedCount} of ${totalParticipants} checked in`,
    blockers.length > 0
      ? `${blockers.length} blocker${blockers.length === 1 ? '' : 's'}`
      : 'no blockers',
  ];
  if (carryoverAlerts.length > 0) {
    summaryParts.push(
      `${carryoverAlerts.length} carryover${carryoverAlerts.length === 1 ? '' : 's'}`,
    );
  }
  if (sdlcCallouts.length > 0) {
    summaryParts.push(
      `${sdlcCallouts.length} SDLC check${sdlcCallouts.length === 1 ? '' : 's'}`,
    );
  }
  const goalPrefix = teamGoal ? `Goal "${teamGoal}" — ` : '';
  const goalProgressSummary = `${goalPrefix}${summaryParts.join(' · ')}.`;

  // AI-proposed Scrum Master huddle questions (up to 3)
  const facilitatorPrompts: string[] = [];
  for (const b of blockers.slice(0, 2)) {
    const who = b.ownerDisplayName ? `${b.ownerDisplayName}` : 'the team';
    facilitatorPrompts.push(
      `Who can help unblock ${who} on “${truncateBriefText(b.summary, 80)}” right after standup?`,
    );
  }
  if (facilitatorPrompts.length < 3 && carryoverAlerts.length > 0) {
    const c = carryoverAlerts[0];
    const who = c.displayName ?? c.userId;
    facilitatorPrompts.push(
      `Check with ${who}: “${truncateBriefText(c.summary, 80)}” — should we split scope or pair today?`,
    );
  }
  if (facilitatorPrompts.length < 3 && handoffsAndReviews.length > 0) {
    const h = handoffsAndReviews[0];
    facilitatorPrompts.push(
      `Confirm handoff${h.fromUser ? ` from ${h.fromUser}` : ''}: “${truncateBriefText(h.summary, 80)}”.`,
    );
  }
  const waitingNames = individualNarratives
    .filter((n) => n.status !== 'confirmed')
    .map((n) => n.displayName);
  if (facilitatorPrompts.length < 3 && waitingNames.length > 0) {
    facilitatorPrompts.push(
      `Still waiting on ${waitingNames.slice(0, 3).join(', ')}${waitingNames.length > 3 ? ` (+${waitingNames.length - 3} more)` : ''} — grab a quick verbal check or follow up async.`,
    );
  }
  if (facilitatorPrompts.length === 0 && totalParticipants > 0) {
    facilitatorPrompts.push(
      teamGoal
        ? `All updates are in with zero blockers — confirm everyone is aligned on “${truncateBriefText(teamGoal, 75)}” and wrap early.`
        : "All updates are in with zero blockers — read out highlights and wrap early.",
    );
  }

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
    facilitatorPrompts: facilitatorPrompts.slice(0, 3),
    sdlcCallouts,
    areaBreakdown,
    individualNarratives,
  };
}
