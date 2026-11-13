import * as azdev from 'azure-devops-node-api';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appGroupMembers,
  appUsers,
  projectSkillSettings,
  standupFollowups,
  standupParticipants,
} from '../db/schema';
import type {
  ParticipantPreparedBrief,
  StandupRosterMember,
  StandupRosterMode,
} from '../../shared/types/standup';
import {
  evaluateParticipantBrief,
  normalizeDeliveryModel,
  normalizeRosterMode,
  resolveStandupPolicy,
  type EvidenceBuildStageRecord,
  type EvidenceBuildSummary,
  type EvidencePipelineFailure,
  type EvidencePullRequest,
  type EvidenceWorkItem,
  type PriorParticipantSessionRecord,
} from './standupDeliveryPolicyService';
import { AzureDevOpsService } from './azureDevOps';

function escapeWiqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function resolveAdoOrgUrl(): string {
  return (process.env.ADO_ORG ?? process.env.ADO_ORG_URL ?? '').trim();
}

export function hasAdoConfiguration(): boolean {
  if (process.env.E2E_MODE === 'true' || process.env.NODE_ENV === 'test') {
    return false;
  }
  return Boolean(resolveAdoOrgUrl() && process.env.ADO_PAT?.trim());
}

function buildAdoWebApi(): azdev.WebApi | null {
  const orgUrl = resolveAdoOrgUrl();
  const pat = process.env.ADO_PAT?.trim();
  if (!orgUrl || !pat) return null;
  return new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(pat), {
    socketTimeout: 30_000,
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker(),
  );
  await Promise.all(runners);
  return results;
}

function extractEmailFromIdentity(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'object') {
    const obj = raw as { uniqueName?: unknown; mailAddress?: unknown; email?: unknown };
    const candidate = obj.uniqueName ?? obj.mailAddress ?? obj.email;
    if (typeof candidate === 'string' && candidate.includes('@')) {
      return candidate.trim().toLowerCase();
    }
  }
  if (typeof raw === 'string') {
    const angleMatch = raw.match(/<([^<>@\s]+@[^<>@\s]+)>/);
    if (angleMatch?.[1]) return angleMatch[1].trim().toLowerCase();
    if (raw.includes('@') && !raw.includes(' ')) return raw.trim().toLowerCase();
  }
  return null;
}

// ── Hybrid ADO + Group Roster Discovery ──────────────────────────────────────

/**
 * Queries Azure DevOps WIQL for open work items (`AssignedTo`) and items updated in
 * the last 7 days (`ChangedBy`) under `project` (+ optional `areaPath`), extracts
 * unique contributor emails, and matches them case-insensitively to `app_users`.
 * Safely returns `[]` when ADO credentials are absent or in `E2E_MODE`/`test`.
 */
export async function discoverAdoProjectContributors(
  project: string,
  areaPath?: string | null,
): Promise<Array<{ userId: string; displayName: string | null; email: string | null }>> {
  if (!project || !hasAdoConfiguration()) {
    return [];
  }

  try {
    const ado = new AzureDevOpsService(project, areaPath ?? undefined, {
      socketTimeout: 30_000,
    });
    const areaClause = areaPath
      ? ` AND [System.AreaPath] UNDER '${escapeWiqlLiteral(areaPath)}'`
      : '';

    const activeAssigneesWiql = `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND [System.State] <> 'Closed'
        AND [System.State] <> 'Done'
        AND [System.State] <> 'Removed'
        ${areaClause}
      ORDER BY [System.ChangedDate] DESC
    `;

    const recentChangersWiql = `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND [System.ChangedDate] >= @Today - 7
        ${areaClause}
      ORDER BY [System.ChangedDate] DESC
    `;

    const fields = ['System.Id', 'System.AssignedTo', 'System.ChangedBy'];
    const [activeRes, recentRes] = await Promise.all([
      ado
        .queryWorkItemsByWiql({ wiql: activeAssigneesWiql, fields, maxResults: 150 })
        .catch(() => ({ items: [] })),
      ado
        .queryWorkItemsByWiql({ wiql: recentChangersWiql, fields, maxResults: 150 })
        .catch(() => ({ items: [] })),
    ]);

    const discoveredEmails = new Set<string>();
    for (const raw of [...(activeRes.items ?? []), ...(recentRes.items ?? [])] as Array<
      Record<string, unknown>
    >) {
      const f = (raw.fields as Record<string, unknown> | undefined) ?? raw;
      const assignedEmail = extractEmailFromIdentity(f['System.AssignedTo'] ?? raw.assignedTo);
      const changedEmail = extractEmailFromIdentity(f['System.ChangedBy'] ?? raw.changedBy);
      if (assignedEmail) discoveredEmails.add(assignedEmail);
      if (changedEmail) discoveredEmails.add(changedEmail);
    }

    if (discoveredEmails.size === 0) return [];

    const allUsers = await db
      .select({
        oid: appUsers.oid,
        displayName: appUsers.displayName,
        email: appUsers.email,
      })
      .from(appUsers);

    const matched: Array<{
      userId: string;
      displayName: string | null;
      email: string | null;
    }> = [];
    const seenOids = new Set<string>();

    for (const u of allUsers) {
      const lowerEmail = u.email?.trim().toLowerCase();
      if (lowerEmail && discoveredEmails.has(lowerEmail) && !seenOids.has(u.oid)) {
        seenOids.add(u.oid);
        matched.push({
          userId: u.oid,
          displayName: u.displayName,
          email: u.email,
        });
      }
    }

    return matched;
  } catch (err) {
    console.warn(
      '[standupEvidenceCollector] ADO contributor discovery fallback to []:',
      (err as Error).message,
    );
    return [];
  }
}

async function fetchGroupMembers(
  groupIds: string[],
): Promise<Array<{ userId: string; displayName: string | null; email: string | null }>> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .select({
      userId: appGroupMembers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
    })
    .from(appGroupMembers)
    .innerJoin(appUsers, eq(appGroupMembers.userId, appUsers.oid))
    .where(inArray(appGroupMembers.groupId, groupIds));

  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.userId)) return false;
    seen.add(r.userId);
    return true;
  });
}

/**
 * Resolves standup participants according to `rosterMode`:
 * - `'groups_only'`: strictly members of `groupIds`
 * - `'ado_active'`: active ADO contributors (intersected with `groupIds` when `groupIds` is non-empty)
 * - `'ado_and_groups'` (default): union of `groupIds` members and active ADO contributors
 */
export async function resolveStandupRoster(params: {
  project: string;
  areaPath?: string | null;
  rosterMode?: StandupRosterMode | string | null;
  groupIds?: string[];
}): Promise<StandupRosterMember[]> {
  const mode = normalizeRosterMode(params.rosterMode);
  const groupIds = (params.groupIds ?? []).filter(Boolean);

  if (mode === 'groups_only') {
    const groupMembers = await fetchGroupMembers(groupIds);
    return groupMembers.map((m) => ({ ...m, source: 'group' as const }));
  }

  const [groupMembers, adoMembers] = await Promise.all([
    groupIds.length > 0 ? fetchGroupMembers(groupIds) : Promise.resolve([]),
    discoverAdoProjectContributors(params.project, params.areaPath),
  ]);

  const groupMap = new Map(groupMembers.map((m) => [m.userId, m]));
  const adoMap = new Map(adoMembers.map((m) => [m.userId, m]));

  if (mode === 'ado_active') {
    if (groupIds.length > 0) {
      return adoMembers
        .filter((m) => groupMap.has(m.userId))
        .map((m) => ({ ...m, source: 'both' as const }));
    }
    return adoMembers.map((m) => ({ ...m, source: 'ado' as const }));
  }

  // Default: 'ado_and_groups' (union)
  const merged = new Map<string, StandupRosterMember>();
  for (const m of groupMembers) {
    merged.set(m.userId, {
      ...m,
      source: adoMap.has(m.userId) ? 'both' : 'group',
    });
  }
  for (const m of adoMembers) {
    if (!merged.has(m.userId)) {
      merged.set(m.userId, { ...m, source: 'ado' });
    }
  }
  return Array.from(merged.values());
}

// ── ADO & GitHub PR + Pipeline Timeline Evidence Collection ──────────────────

const ADO_BUILD_STATUS_MAP: Record<number, string> = {
  1: 'inProgress',
  2: 'completed',
  4: 'cancelling',
  8: 'postponed',
  32: 'notStarted',
};

const ADO_BUILD_RESULT_MAP: Record<number, string> = {
  0: 'none',
  2: 'succeeded',
  4: 'partiallySucceeded',
  8: 'failed',
  32: 'canceled',
};

const ADO_TASK_RESULT_MAP: Record<number, string> = {
  0: 'succeeded',
  1: 'succeededWithIssues',
  2: 'failed',
  3: 'canceled',
  4: 'skipped',
  5: 'abandoned',
};

const ADO_TIMELINE_STATE_MAP: Record<number, string> = {
  0: 'pending',
  1: 'inProgress',
  2: 'completed',
};

function mapEnumOrString(
  raw: unknown,
  numericMap: Record<number, string>,
): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number' && numericMap[raw] !== undefined) {
    return numericMap[raw];
  }
  return undefined;
}

async function fetchAdoPrsAndBuildsForMember(params: {
  project: string;
  memberEmail: string;
  enablePrEvidence: boolean;
  enablePipelineEvidence: boolean;
}): Promise<{
  pullRequests: EvidencePullRequest[];
  builds: EvidenceBuildSummary[];
  pipelineFailures: EvidencePipelineFailure[];
}> {
  const empty = {
    pullRequests: [] as EvidencePullRequest[],
    builds: [] as EvidenceBuildSummary[],
    pipelineFailures: [] as EvidencePipelineFailure[],
  };

  if (!params.enablePrEvidence && !params.enablePipelineEvidence) {
    return empty;
  }

  const connection = buildAdoWebApi();
  if (!connection) return empty;

  const lowerEmail = params.memberEmail.trim().toLowerCase();
  const minTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  let pullRequests: EvidencePullRequest[] = [];
  if (params.enablePrEvidence) {
    try {
      const gitApi = await connection.getGitApi();
      const repos = (await gitApi.getRepositories(params.project).catch(() => [])) ?? [];
      const candidateRepos = repos.filter((r) => Boolean(r.id)).slice(0, 8);

      const perRepoPrs = await mapWithConcurrency(
        candidateRepos,
        4,
        async (repo) => {
          const [activePrs, completedPrs] = await Promise.all([
            gitApi
              .getPullRequests(
                repo.id!,
                { status: 1 as never } as never,
                params.project,
                undefined,
                undefined,
                50,
              )
              .catch(() => []),
            gitApi
              .getPullRequests(
                repo.id!,
                { status: 3 as never, minTime } as never,
                params.project,
                undefined,
                undefined,
                50,
              )
              .catch(() => []),
          ]);

          return [...(activePrs ?? []), ...(completedPrs ?? [])].map((pr) => ({
            repoId: repo.id!,
            repoName: repo.name ?? '',
            pr,
          }));
        },
      );

      const matchedPrEntries = perRepoPrs
        .flat()
        .filter(({ pr }) => {
          const creatorEmail = extractEmailFromIdentity(pr.createdBy);
          if (creatorEmail === lowerEmail) return true;
          const reviewers = Array.isArray(pr.reviewers) ? pr.reviewers : [];
          return reviewers.some((rev) => extractEmailFromIdentity(rev) === lowerEmail);
        })
        .slice(0, 10);

      pullRequests = await mapWithConcurrency(
        matchedPrEntries,
        4,
        async ({ repoId, repoName, pr }) => {
          const prId = Number(pr.pullRequestId ?? 0);
          const [wiRefs, iterations] = await Promise.all([
            gitApi
              .getPullRequestWorkItemRefs(repoId, prId, params.project)
              .catch(() => []),
            gitApi
              .getPullRequestIterations(repoId, prId, params.project)
              .catch(() => []),
          ]);

          const linkedWorkItemIds = (wiRefs ?? [])
            .map((ref) => Number.parseInt(String(ref.id ?? ''), 10))
            .filter((n) => Number.isFinite(n) && n > 0);

          let changedFiles: string[] = [];
          const latestIter =
            Array.isArray(iterations) && iterations.length > 0
              ? iterations[iterations.length - 1]
              : null;
          if (latestIter?.id != null) {
            const iterChanges = await gitApi
              .getPullRequestIterationChanges(
                repoId,
                prId,
                latestIter.id,
                params.project,
              )
              .catch(() => null);
            const entries = (
              iterChanges as { changeEntries?: Array<{ item?: { path?: string } }> } | null
            )?.changeEntries;
            if (Array.isArray(entries)) {
              changedFiles = [
                ...new Set(
                  entries
                    .map((e) => e.item?.path)
                    .filter((p): p is string => typeof p === 'string' && p.length > 0)
                    .map((p) => p.replace(/^\/+/, '')),
                ),
              ];
            }
          }

          const reviewers = Array.isArray(pr.reviewers) ? pr.reviewers : [];
          const hasApproval = reviewers.some(
            (r) => typeof r.vote === 'number' && r.vote >= 5,
          );
          const statusNum = pr.status as unknown as number | string;
          const status: 'active' | 'completed' | 'abandoned' =
            statusNum === 3 || statusNum === 'completed'
              ? 'completed'
              : statusNum === 2 || statusNum === 'abandoned'
              ? 'abandoned'
              : 'active';

          return {
            prId,
            title: pr.title ?? `PR !${prId}`,
            status,
            createdAt: pr.creationDate
              ? new Date(pr.creationDate).toISOString()
              : new Date().toISOString(),
            closedAt: pr.closedDate
              ? new Date(pr.closedDate).toISOString()
              : undefined,
            linkedWorkItemIds,
            hasApproval,
            repositoryName: repoName,
            sourceBranch: pr.sourceRefName,
            targetBranch: pr.targetRefName,
            changedFiles,
          };
        },
      );
    } catch (err) {
      console.warn(
        '[standupEvidenceCollector] ADO Git PR collection skipped:',
        (err as Error).message,
      );
    }
  }

  const builds: EvidenceBuildSummary[] = [];
  const pipelineFailures: EvidencePipelineFailure[] = [];

  if (params.enablePipelineEvidence) {
    try {
      const buildApi = await connection.getBuildApi();
      const rawBuilds =
        (await buildApi
          .getBuilds(
            params.project,
            undefined,
            undefined,
            undefined,
            minTime,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            20,
          )
          .catch(() => [])) ?? [];

      const prById = new Map<number, EvidencePullRequest>();
      const prByBranch = new Map<string, EvidencePullRequest>();
      for (const pr of pullRequests) {
        prById.set(pr.prId, pr);
        if (pr.sourceBranch) {
          prByBranch.set(
            pr.sourceBranch.replace(/^refs\/heads\//i, '').toLowerCase(),
            pr,
          );
        }
      }

      const relevantRawBuilds = rawBuilds
        .filter((b) => {
          if (typeof b.id !== 'number') return false;
          const requestedForEmail = extractEmailFromIdentity(b.requestedFor);
          if (requestedForEmail === lowerEmail) return true;
          const branch = String(b.sourceBranch ?? '');
          const prRefMatch = branch.match(/refs\/pull\/(\d+)\//i);
          if (prRefMatch && prById.has(Number(prRefMatch[1]))) return true;
          const cleanBranch = branch.replace(/^refs\/heads\//i, '').toLowerCase();
          return prByBranch.has(cleanBranch);
        })
        .slice(0, 8);

      const hydratedBuilds = await mapWithConcurrency(
        relevantRawBuilds,
        4,
        async (b) => {
          const buildId = b.id!;
          const timeline = await buildApi
            .getBuildTimeline(params.project, buildId)
            .catch(() => null);
          const stagesAndJobs: EvidenceBuildStageRecord[] = Array.isArray(
            timeline?.records,
          )
            ? timeline!.records
                .filter(
                  (rec) =>
                    rec.name &&
                    ['Stage', 'Phase', 'Job', 'Task'].includes(String(rec.type ?? '')),
                )
                .map((rec) => ({
                  name: String(rec.name),
                  type: String(rec.type ?? 'Task'),
                  state: mapEnumOrString(rec.state, ADO_TIMELINE_STATE_MAP),
                  result: mapEnumOrString(rec.result, ADO_TASK_RESULT_MAP),
                }))
            : [];

          const branch = String(b.sourceBranch ?? '');
          const prRefMatch = branch.match(/refs\/pull\/(\d+)\//i);
          const triggerPrId = b.triggerInfo?.['pr.number']
            ? Number(b.triggerInfo['pr.number'])
            : undefined;
          const matchedPr =
            (prRefMatch ? prById.get(Number(prRefMatch[1])) : undefined) ??
            (triggerPrId ? prById.get(triggerPrId) : undefined) ??
            prByBranch.get(branch.replace(/^refs\/heads\//i, '').toLowerCase());

          const resultStr = mapEnumOrString(b.result, ADO_BUILD_RESULT_MAP);
          const statusStr = mapEnumOrString(b.status, ADO_BUILD_STATUS_MAP);

          const summary: EvidenceBuildSummary = {
            buildId,
            buildNumber: String(b.buildNumber ?? buildId),
            definitionName: b.definition?.name ?? 'Pipeline',
            branch: branch || undefined,
            status: statusStr,
            result: resultStr,
            finishedAt: b.finishTime
              ? new Date(b.finishTime).toISOString()
              : undefined,
            prId: matchedPr?.prId,
            linkedWorkItemIds: matchedPr?.linkedWorkItemIds,
            stagesAndJobs,
          };
          return summary;
        },
      );

      builds.push(...hydratedBuilds);
      for (const summary of hydratedBuilds) {
        if (summary.prId) {
          const pr = pullRequests.find((p) => p.prId === summary.prId);
          if (pr) {
            pr.builds = [...(pr.builds ?? []), summary];
          }
        }
        if ((summary.result ?? '').toLowerCase() === 'failed') {
          pipelineFailures.push({
            buildId: summary.buildId,
            buildNumber: summary.buildNumber,
            definitionName: summary.definitionName,
            branch: summary.branch,
            failedAt: summary.finishedAt ?? new Date().toISOString(),
            linkedWorkItemIds: summary.linkedWorkItemIds,
            prId: summary.prId,
          });
        }
      }
    } catch (err) {
      console.warn(
        '[standupEvidenceCollector] ADO Build timeline collection skipped:',
        (err as Error).message,
      );
    }
  }

  return { pullRequests, builds, pipelineFailures };
}

async function fetchGitHubEvidenceIfConfigured(params: {
  skillSettingsId?: string | null;
  enablePrEvidence: boolean;
  enablePipelineEvidence: boolean;
}): Promise<{
  pullRequests: EvidencePullRequest[];
  builds: EvidenceBuildSummary[];
}> {
  const empty = {
    pullRequests: [] as EvidencePullRequest[],
    builds: [] as EvidenceBuildSummary[],
  };
  if (
    process.env.E2E_MODE === 'true' ||
    process.env.NODE_ENV === 'test' ||
    !params.skillSettingsId ||
    !process.env.GITHUB_TOKEN?.trim()
  ) {
    return empty;
  }

  try {
    const settings = await db.query.projectSkillSettings?.findFirst({
      where: eq(projectSkillSettings.id, params.skillSettingsId),
      columns: { skillProvider: true, skillRepo: true },
    });
    if (!settings || settings.skillProvider !== 'github' || !settings.skillRepo) {
      return empty;
    }

    const repoSlug = settings.skillRepo
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .trim();
    if (!/^[^/]+\/[^/]+$/.test(repoSlug)) return empty;

    const headers = {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN.trim()}`,
      Accept: 'application/vnd.github+json',
    };

    const pullsRes = await fetch(
      `https://api.github.com/repos/${repoSlug}/pulls?state=all&sort=updated&direction=desc&per_page=6`,
      { headers },
    ).catch(() => null);
    if (!pullsRes?.ok) return empty;

    const rawPulls = (await pullsRes.json()) as Array<{
      number: number;
      title: string;
      state: string;
      merged_at: string | null;
      created_at: string;
      closed_at: string | null;
      body?: string | null;
      head?: { ref?: string; sha?: string };
      base?: { ref?: string };
    }>;

    const pullRequests: EvidencePullRequest[] = [];
    const builds: EvidenceBuildSummary[] = [];

    for (const pr of rawPulls.slice(0, 6)) {
      const filesRes = params.enablePrEvidence
        ? await fetch(
            `https://api.github.com/repos/${repoSlug}/pulls/${pr.number}/files?per_page=50`,
            { headers },
          ).catch(() => null)
        : null;
      const filesJson = filesRes?.ok
        ? ((await filesRes.json()) as Array<{ filename?: string }>)
        : [];
      const changedFiles = filesJson
        .map((f) => f.filename)
        .filter((f): f is string => typeof f === 'string');

      const wiMatches = `${pr.title} ${pr.body ?? ''}`.match(/(?:AB#|#)(\d+)/gi) ?? [];
      const linkedWorkItemIds = wiMatches
        .map((m) => Number.parseInt(m.replace(/\D+/g, ''), 10))
        .filter((n) => Number.isFinite(n) && n > 0);

      let prBuilds: EvidenceBuildSummary[] = [];
      if (params.enablePipelineEvidence && pr.head?.sha) {
        const checksRes = await fetch(
          `https://api.github.com/repos/${repoSlug}/commits/${pr.head.sha}/check-runs?per_page=30`,
          { headers },
        ).catch(() => null);
        if (checksRes?.ok) {
          const checksData = (await checksRes.json()) as {
            check_runs?: Array<{
              id: number;
              name: string;
              status?: string;
              conclusion?: string | null;
            }>;
          };
          const runs = checksData.check_runs ?? [];
          if (runs.length > 0) {
            const stagesAndJobs: EvidenceBuildStageRecord[] = runs.map((r) => ({
              name: r.name,
              type: 'CheckRun',
              state: r.status === 'completed' ? 'completed' : 'inProgress',
              result:
                r.conclusion === 'success'
                  ? 'succeeded'
                  : r.conclusion === 'failure' || r.conclusion === 'timed_out'
                  ? 'failed'
                  : r.conclusion === 'skipped' || r.conclusion === 'neutral'
                  ? 'skipped'
                  : r.conclusion ?? undefined,
            }));
            const anyFailed = stagesAndJobs.some((s) => s.result === 'failed');
            const summary: EvidenceBuildSummary = {
              buildId: `gh-${pr.head.sha.slice(0, 8)}`,
              buildNumber: pr.head.sha.slice(0, 7),
              definitionName: 'GitHub Actions',
              branch: pr.head.ref,
              status: 'completed',
              result: anyFailed ? 'failed' : 'succeeded',
              prId: pr.number,
              linkedWorkItemIds,
              stagesAndJobs,
            };
            prBuilds = [summary];
            builds.push(summary);
          }
        }
      }

      pullRequests.push({
        prId: pr.number,
        title: pr.title,
        status: pr.merged_at
          ? 'completed'
          : pr.state === 'open'
          ? 'active'
          : 'abandoned',
        createdAt: pr.created_at,
        closedAt: pr.closed_at ?? undefined,
        linkedWorkItemIds,
        changedFiles,
        sourceBranch: pr.head?.ref,
        targetBranch: pr.base?.ref,
        builds: prBuilds,
      });
    }

    return { pullRequests, builds };
  } catch {
    return empty;
  }
}

async function fetchAdoEvidenceForMember(params: {
  project: string;
  areaPath?: string | null;
  skillSettingsId?: string | null;
  memberEmail?: string | null;
  memberDisplayName?: string | null;
  enablePrEvidence: boolean;
  enablePipelineEvidence: boolean;
}): Promise<{
  activeWorkItems: EvidenceWorkItem[];
  changedSinceLastWorkItems: EvidenceWorkItem[];
  pullRequests: EvidencePullRequest[];
  builds: EvidenceBuildSummary[];
  pipelineFailures: EvidencePipelineFailure[];
}> {
  const empty = {
    activeWorkItems: [] as EvidenceWorkItem[],
    changedSinceLastWorkItems: [] as EvidenceWorkItem[],
    pullRequests: [] as EvidencePullRequest[],
    builds: [] as EvidenceBuildSummary[],
    pipelineFailures: [] as EvidencePipelineFailure[],
  };

  if (!hasAdoConfiguration() || !params.memberEmail) {
    return empty;
  }

  try {
    const ado = new AzureDevOpsService(
      params.project,
      params.areaPath ?? undefined,
    );
    const safeEmail = escapeWiqlLiteral(params.memberEmail);
    const areaClause = params.areaPath
      ? ` AND [System.AreaPath] UNDER '${escapeWiqlLiteral(params.areaPath)}'`
      : '';

    const activeQuery = `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND [System.AssignedTo] = '${safeEmail}'
        AND [System.State] <> 'Closed'
        AND [System.State] <> 'Done'
        AND [System.State] <> 'Removed'
        ${areaClause}
      ORDER BY [System.ChangedDate] DESC
    `;

    const changedQuery = `
      SELECT [System.Id]
      FROM WorkItems
      WHERE [System.TeamProject] = @project
        AND [System.ChangedBy] = '${safeEmail}'
        AND [System.ChangedDate] >= @Today - 1
        ${areaClause}
      ORDER BY [System.ChangedDate] DESC
    `;

    const [activeRes, changedRes, adoPrBuilds, ghPrBuilds] = await Promise.all([
      ado
        .queryWorkItemsByWiql({ wiql: activeQuery, maxResults: 40 })
        .catch(() => ({ items: [] })),
      ado
        .queryWorkItemsByWiql({ wiql: changedQuery, maxResults: 30 })
        .catch(() => ({ items: [] })),
      fetchAdoPrsAndBuildsForMember({
        project: params.project,
        memberEmail: params.memberEmail,
        enablePrEvidence: params.enablePrEvidence,
        enablePipelineEvidence: params.enablePipelineEvidence,
      }),
      fetchGitHubEvidenceIfConfigured({
        skillSettingsId: params.skillSettingsId,
        enablePrEvidence: params.enablePrEvidence,
        enablePipelineEvidence: params.enablePipelineEvidence,
      }),
    ]);

    const mapRawItem = (raw: Record<string, unknown>): EvidenceWorkItem => {
      const fields = (raw.fields as Record<string, unknown> | undefined) ?? raw;
      const assignedRaw = fields['System.AssignedTo'] ?? raw.assignedTo;
      const assignedTo =
        typeof assignedRaw === 'string'
          ? assignedRaw
          : (assignedRaw as { displayName?: string; uniqueName?: string } | undefined)
              ?.displayName ??
            (assignedRaw as { uniqueName?: string } | undefined)?.uniqueName;
      return {
        id: Number(raw.id ?? fields['System.Id'] ?? 0),
        title: String(fields['System.Title'] ?? raw.title ?? ''),
        workItemType: String(
          fields['System.WorkItemType'] ?? raw.workItemType ?? 'Task',
        ),
        state: String(fields['System.State'] ?? raw.state ?? 'New'),
        assignedTo,
        changedDate: fields['System.ChangedDate']
          ? String(fields['System.ChangedDate'])
          : typeof raw.changedDate === 'string'
          ? raw.changedDate
          : undefined,
        createdDate: fields['System.CreatedDate']
          ? String(fields['System.CreatedDate'])
          : typeof raw.createdDate === 'string'
          ? raw.createdDate
          : undefined,
        targetDate: fields['Microsoft.VSTS.Scheduling.TargetDate']
          ? String(fields['Microsoft.VSTS.Scheduling.TargetDate']).slice(0, 10)
          : typeof raw.targetDate === 'string'
          ? raw.targetDate.slice(0, 10)
          : null,
        dueDate: fields['Microsoft.VSTS.Scheduling.DueDate']
          ? String(fields['Microsoft.VSTS.Scheduling.DueDate']).slice(0, 10)
          : typeof raw.dueDate === 'string'
          ? raw.dueDate.slice(0, 10)
          : null,
        iterationPath: fields['System.IterationPath']
          ? String(fields['System.IterationPath'])
          : typeof raw.iterationPath === 'string'
          ? raw.iterationPath
          : null,
        tags: fields['System.Tags']
          ? String(fields['System.Tags'])
          : typeof raw.tags === 'string'
          ? raw.tags
          : undefined,
        priority:
          typeof fields['Microsoft.VSTS.Common.Priority'] === 'number'
            ? (fields['Microsoft.VSTS.Common.Priority'] as number)
            : undefined,
      };
    };

    const activeWorkItems = (
      (activeRes.items ?? []) as unknown as Array<Record<string, unknown>>
    )
      .map(mapRawItem)
      .filter((item) => item.id > 0);
    const changedSinceLastWorkItems = (
      (changedRes.items ?? []) as unknown as Array<Record<string, unknown>>
    )
      .map(mapRawItem)
      .filter((item) => item.id > 0);

    return {
      activeWorkItems,
      changedSinceLastWorkItems,
      pullRequests: [...adoPrBuilds.pullRequests, ...ghPrBuilds.pullRequests],
      builds: [...adoPrBuilds.builds, ...ghPrBuilds.builds],
      pipelineFailures: adoPrBuilds.pipelineFailures,
    };
  } catch (err) {
    console.warn(
      '[standupEvidenceCollector] Falling back to empty ADO evidence:',
      (err as Error).message,
    );
    return empty;
  }
}

/**
 * Loads up to the last `limit` (default 7) prior submitted standup updates
 * for a participant, ordered newest-to-oldest, to compute multi-day carryover
 * streaks and longitudinal progress arcs.
 */
export async function findRecentParticipantHistory(
  userId: string,
  currentSessionId: string,
  limit = 7,
): Promise<PriorParticipantSessionRecord[]> {
  if (!db.query.standupParticipants?.findMany) return [];
  try {
    const rows = await db.query.standupParticipants.findMany({
      where: and(
        eq(standupParticipants.userId, userId),
        eq(standupParticipants.status, 'submitted'),
        ne(standupParticipants.sessionId, currentSessionId),
      ),
      with: { session: true },
      orderBy: desc(standupParticipants.submittedAt),
      limit,
    });
    return rows
      .filter((r) => r.structuredUpdate != null)
      .map((r) => ({
        sessionDate: r.session?.sessionDate ?? '',
        structuredUpdate: r.structuredUpdate ?? null,
      }));
  } catch {
    return [];
  }
}

async function findOpenFollowupsForUser(
  userId: string,
): Promise<Array<{ id: string; title: string; sessionDate: string }>> {
  if (!db.query.standupFollowups?.findMany) return [];
  try {
    const rows = await db.query.standupFollowups.findMany({
      where: ne(standupFollowups.status, 'resolved'),
      with: { session: true },
      orderBy: desc(standupFollowups.createdAt),
      limit: 25,
    });
    return rows
      .filter(
        (f) =>
          Array.isArray(f.participantUserIds) &&
          (f.participantUserIds as string[]).includes(userId),
      )
      .slice(0, 5)
      .map((f) => ({
        id: f.id,
        title: f.title,
        sessionDate: f.session?.sessionDate ?? '',
      }));
  } catch {
    return [];
  }
}

/**
 * Computes and persists `preparedBrief` (including multi-day arc, SDLC callouts,
 * domain tags, and pre-drafted items) for a standup participant row.
 */
export async function collectAndSaveParticipantBrief(
  participantId: string,
): Promise<ParticipantPreparedBrief | null> {
  if (!db.query.standupParticipants?.findFirst) return null;

  const participant = await db.query.standupParticipants.findFirst({
    where: eq(standupParticipants.id, participantId),
    with: {
      session: {
        with: {
          config: true,
        },
      },
    },
  });

  if (!participant || !participant.session?.config) return null;

  const config = participant.session.config;
  const deliveryModel = normalizeDeliveryModel(config.deliveryModel);
  const resolvedPolicy = resolveStandupPolicy(deliveryModel, config.policy);

  let memberEmail: string | null = null;
  let memberDisplayName: string | null = null;
  if (db.query.appUsers?.findFirst) {
    try {
      const user = await db.query.appUsers.findFirst({
        where: eq(appUsers.oid, participant.userId),
        columns: { email: true, displayName: true },
      });
      memberEmail = user?.email ?? null;
      memberDisplayName = user?.displayName ?? null;
    } catch {
      // Optional user lookup
    }
  }

  const [adoEvidence, priorHistory, openFollowups] = await Promise.all([
    fetchAdoEvidenceForMember({
      project: config.project,
      areaPath: config.areaPath,
      skillSettingsId: config.skillSettingsId,
      memberEmail,
      memberDisplayName,
      enablePrEvidence: resolvedPolicy.enablePrEvidence,
      enablePipelineEvidence: resolvedPolicy.enablePipelineEvidence,
    }),
    resolvedPolicy.enableCommitmentMemory
      ? findRecentParticipantHistory(participant.userId, participant.sessionId, 7)
      : Promise.resolve([]),
    findOpenFollowupsForUser(participant.userId),
  ]);

  const brief = evaluateParticipantBrief({
    deliveryModel,
    teamGoal: config.teamGoal ?? null,
    policy: resolvedPolicy,
    expectedIterationPath: config.iterationPath ?? null,
    ownerDisplayName: memberDisplayName,
    activeWorkItems: adoEvidence.activeWorkItems,
    changedSinceLastWorkItems: adoEvidence.changedSinceLastWorkItems,
    pullRequests: adoEvidence.pullRequests,
    builds: adoEvidence.builds,
    pipelineFailures: adoEvidence.pipelineFailures,
    priorHistory,
    openFollowups,
  });

  await db
    .update(standupParticipants)
    .set({ preparedBrief: brief })
    .where(eq(standupParticipants.id, participantId));

  return brief;
}
