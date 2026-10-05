import { and, eq, isNull, or } from 'drizzle-orm';
import {
  type HomeDashboardScope,
} from '../../shared/types/homeDashboard';
import {
  isAppNativeRequirementsProject,
  type ActiveDevSession,
} from '../../shared/types/devWorkbench';
import { computeFeatureWorkStatus } from '../../shared/utils/myWorkStatus';
import { db } from '../db/drizzle';
import { appUsers, designDocs, devSessions, interviews, prds } from '../db/schema';
import { AzureDevOpsService } from './azureDevOps';
import { computeMedianDays, type DurationSample } from './medianDuration';

export interface NativeSummaryFeature {
  featureId: string;
  prdId: string;
  dependsOn: string[];
  readyAt?: string | null;
}

export interface SummaryDevSession extends Omit<ActiveDevSession, 'updatedAt'> {
  updatedAt: string;
}

export interface AdoSummaryWorkItem {
  id: number;
  state: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface MyWorkSummaryDependencies {
  listNativeFeatures(input: {
    userId: string;
    project: string;
    scope: HomeDashboardScope;
  }): Promise<NativeSummaryFeature[]>;
  listDevSessions(input: {
    userId: string;
    project: string;
    scope: HomeDashboardScope;
  }): Promise<SummaryDevSession[]>;
  listAdoWork(input: {
    userId: string;
    project: string;
    since: string;
    scope: HomeDashboardScope;
  }): Promise<AdoSummaryWorkItem[]>;
}

export interface MyWorkSummary {
  readyCount: number;
  inProgressCount: number;
  medianCompletionDays: number | null;
  sampleSize: number;
}

const READY_ADO_STATES = new Set(['new', 'approved', 'committed']);
const IN_PROGRESS_ADO_STATES = new Set(['in progress', 'active']);
const DONE_ADO_STATES = new Set(['done', 'closed']);
const DAYS_90_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Stable read-model boundary for the My Work summary. Callers must provide the
 * current user and project; dependencies receive both values on every read.
 */
export class MyWorkSummaryService {
  constructor(public readonly dependencies: MyWorkSummaryDependencies) {}

  async getSummary(input: {
    userId: string;
    project: string;
    now?: Date;
    scope?: HomeDashboardScope;
  }): Promise<MyWorkSummary> {
    if (!input.userId || !input.project) throw new Error('userId and project are required');

    const now = input.now ?? new Date();
    const sinceMs = now.getTime() - DAYS_90_MS;
    const since = new Date(sinceMs).toISOString();
    const scope = input.scope ?? 'team';

    if (!isAppNativeRequirementsProject(input.project)) {
      const items = await this.dependencies.listAdoWork({
        userId: input.userId,
        project: input.project,
        since,
        scope,
      });
      const samples: DurationSample[] = [];
      let readyCount = 0;
      let inProgressCount = 0;

      for (const item of items) {
        const state = item.state.trim().toLowerCase();
        if (READY_ADO_STATES.has(state)) readyCount++;
        if (IN_PROGRESS_ADO_STATES.has(state)) inProgressCount++;
        if (
          DONE_ADO_STATES.has(state)
          && item.startedAt
          && item.completedAt
          && Date.parse(item.completedAt) >= sinceMs
        ) {
          samples.push({ createdAt: item.startedAt, doneAt: item.completedAt });
        }
      }

      return {
        readyCount,
        inProgressCount,
        medianCompletionDays: computeMedianDays(samples),
        sampleSize: samples.length,
      };
    }

    const [features, sessions] = await Promise.all([
      this.dependencies.listNativeFeatures({
        userId: input.userId,
        project: input.project,
        scope,
      }),
      this.dependencies.listDevSessions({
        userId: input.userId,
        project: input.project,
        scope,
      }),
    ]);
    let readyCount = 0;
    let inProgressCount = 0;
    const samples: DurationSample[] = [];

    for (const feature of features) {
      const status = computeFeatureWorkStatus(feature, sessions, sessions);
      if (status.state === 'ready') readyCount++;
      if (status.state === 'in_progress') inProgressCount++;

      if (status.state === 'complete' && status.sessionId) {
        const completed = sessions.find((session) => session.id === status.sessionId);
        if (completed && Date.parse(completed.updatedAt) >= sinceMs) {
          samples.push({ createdAt: completed.createdAt, doneAt: completed.updatedAt });
        }
      }
    }

    return {
      readyCount,
      inProgressCount,
      medianCompletionDays: computeMedianDays(samples),
      sampleSize: samples.length,
    };
  }
}

function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

function identityValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const identity = value as { uniqueName?: string; displayName?: string };
    return identity.uniqueName ?? identity.displayName ?? '';
  }
  return '';
}

/** Production dependencies backed by approved PRDs, scoped dev sessions, and ADO. */
export function createProductionMyWorkSummaryService(): MyWorkSummaryService {
  return new MyWorkSummaryService({
    async listNativeFeatures({ userId, project, scope }) {
      const approvedPrds = await db
        .selectDistinct({
          id: prds.id,
          backlogJson: prds.backlogJson,
          readyAt: prds.reviewedAt,
          updatedAt: prds.updatedAt,
          createdAt: prds.createdAt,
        })
        .from(prds)
        .leftJoin(interviews, eq(prds.interviewId, interviews.id))
        .leftJoin(designDocs, eq(designDocs.prdId, prds.id))
        .where(and(
          eq(prds.project, project),
          eq(prds.status, 'approved'),
          scope === 'mine'
            ? or(
              eq(interviews.designDocOwnerId, userId),
              and(
                isNull(interviews.designDocOwnerId),
                eq(designDocs.authorId, userId),
              ),
            )
            : undefined,
        ));

      return approvedPrds.flatMap((prd) => {
        const backlog = prd.backlogJson as {
          epics?: Array<{ features?: Array<{ id?: string; dependsOn?: string[] }> }>;
        } | null;
        let index = 0;
        return (backlog?.epics ?? []).flatMap((epic) =>
          (epic.features ?? []).map((feature) => {
            index += 1;
            return {
              featureId: feature.id ?? `FEAT-${String(index).padStart(3, '0')}`,
              prdId: prd.id,
              dependsOn: Array.isArray(feature.dependsOn) ? feature.dependsOn : [],
              readyAt: prd.readyAt ?? prd.updatedAt ?? prd.createdAt,
            };
          }),
        );
      });
    },

    async listDevSessions({ userId, project, scope }) {
      const rows = await db
        .select({
          id: devSessions.id,
          workItemId: devSessions.workItemId,
          featureId: devSessions.featureId,
          prdId: devSessions.prdId,
          status: devSessions.status,
          branchName: devSessions.branchName,
          createdAt: devSessions.createdAt,
          updatedAt: devSessions.updatedAt,
          chatThreadId: devSessions.chatThreadId,
          prUrl: devSessions.prUrl,
        })
        .from(devSessions)
        .where(and(
          eq(devSessions.project, project),
          scope === 'mine' ? eq(devSessions.authorId, userId) : undefined,
        ));
      return rows.map((row) => ({
        ...row,
        status: row.status as ActiveDevSession['status'],
      }));
    },

    async listAdoWork({ userId, project, since, scope }) {
      const [user] = await db
        .select({ email: appUsers.email, displayName: appUsers.displayName })
        .from(appUsers)
        .where(eq(appUsers.oid, userId))
        .limit(1);
      const assignee = user?.email ?? user?.displayName;
      if (scope === 'mine' && !assignee) throw new Error('Current user has no ADO identity');
      const identities = new Set(
        [user?.email, user?.displayName]
          .filter((value): value is string => !!value)
          .map((value) => value.toLowerCase()),
      );

      const ado = new AzureDevOpsService(project);
      const escapedProject = escapeWiql(project);
      const escapedAssignee = escapeWiql(assignee ?? '');
      const sinceDate = since.slice(0, 10);
      const result = await ado.queryWorkItemsByWiql({
        wiql: [
          'SELECT [System.Id] FROM WorkItems',
          `WHERE [System.TeamProject] = '${escapedProject}'`,
          ...(scope === 'mine' ? [`AND [System.AssignedTo] = '${escapedAssignee}'`] : []),
          "AND [System.WorkItemType] IN ('Feature', 'Product Backlog Item', 'Technical Backlog Item', 'Bug')",
          `AND ([System.State] NOT IN ('Done', 'Closed', 'Removed') OR [System.ChangedDate] >= '${sinceDate}')`,
        ].join(' '),
        fields: ['System.Id', 'System.State', 'System.AssignedTo'],
        maxResults: 200,
      });

      return Promise.all(result.items.map(async (item): Promise<AdoSummaryWorkItem> => {
        const state = String(item.fields['System.State'] ?? '');
        if (!DONE_ADO_STATES.has(state.trim().toLowerCase())) {
          return { id: item.id, state };
        }
        const revisions = await ado.getWorkItemRevisionHistory(item.id, 500);
        const started = revisions.find((revision) =>
          IN_PROGRESS_ADO_STATES.has(String(revision.state ?? '').trim().toLowerCase())
          && (
            scope === 'team'
            || identities.has(identityValue(revision.fields['System.AssignedTo']).toLowerCase())
          ));
        const completed = revisions.find((revision) =>
          DONE_ADO_STATES.has(String(revision.state ?? '').trim().toLowerCase()));
        return {
          id: item.id,
          state,
          startedAt: started?.changedDate ?? null,
          completedAt: completed?.changedDate ?? null,
        };
      }));
    },
  });
}
