import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appUsers,
  standupFollowups,
  standupParticipants,
} from '../db/schema';
import type {
  ParticipantPreparedBrief,
  StandupStructuredUpdate,
} from '../../shared/types/standup';
import {
  evaluateParticipantBrief,
  normalizeDeliveryModel,
  resolveStandupPolicy,
  type EvidencePipelineFailure,
  type EvidencePullRequest,
  type EvidenceWorkItem,
} from './standupDeliveryPolicyService';
import { AzureDevOpsService } from './azureDevOps';

function escapeWiqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function hasAdoConfiguration(): boolean {
  if (process.env.E2E_MODE === 'true' || process.env.NODE_ENV === 'test') {
    return false;
  }
  return Boolean(process.env.ADO_ORG_URL && process.env.ADO_PAT);
}

async function fetchAdoEvidenceForMember(params: {
  project: string;
  areaPath?: string | null;
  memberEmail?: string | null;
  memberDisplayName?: string | null;
  enablePrEvidence: boolean;
  enablePipelineEvidence: boolean;
}): Promise<{
  activeWorkItems: EvidenceWorkItem[];
  changedSinceLastWorkItems: EvidenceWorkItem[];
  pullRequests: EvidencePullRequest[];
  pipelineFailures: EvidencePipelineFailure[];
}> {
  const empty = {
    activeWorkItems: [] as EvidenceWorkItem[],
    changedSinceLastWorkItems: [] as EvidenceWorkItem[],
    pullRequests: [] as EvidencePullRequest[],
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

    const [activeRows, changedRows] = await Promise.all([
      ado
        .queryWorkItemsByWiql({ wiql: activeQuery, maxResults: 40 })
        .catch(() => []),
      ado
        .queryWorkItemsByWiql({ wiql: changedQuery, maxResults: 30 })
        .catch(() => []),
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

    const activeWorkItems = (activeRows as unknown as Array<Record<string, unknown>>)
      .map(mapRawItem)
      .filter((item) => item.id > 0);
    const changedSinceLastWorkItems = (
      changedRows as unknown as Array<Record<string, unknown>>
    )
      .map(mapRawItem)
      .filter((item) => item.id > 0);

    return {
      activeWorkItems,
      changedSinceLastWorkItems,
      pullRequests: [],
      pipelineFailures: [],
    };
  } catch (err) {
    console.warn(
      '[standupEvidenceCollector] Falling back to empty ADO evidence:',
      (err as Error).message,
    );
    return empty;
  }
}

async function findPriorSubmittedUpdate(
  userId: string,
  currentSessionId: string,
): Promise<StandupStructuredUpdate | null> {
  if (!db.query.standupParticipants?.findMany) return null;
  try {
    const rows = await db.query.standupParticipants.findMany({
      where: and(
        eq(standupParticipants.userId, userId),
        eq(standupParticipants.status, 'submitted'),
        ne(standupParticipants.sessionId, currentSessionId),
      ),
      orderBy: desc(standupParticipants.submittedAt),
      limit: 5,
    });
    const withUpdate = rows.find((r) => r.structuredUpdate != null);
    return withUpdate?.structuredUpdate ?? null;
  } catch {
    return null;
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
      .filter((f) =>
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
 * Computes and persists `preparedBrief` for a standup participant row.
 * Safe to invoke during session creation, lazy `/my-session` reads, or manual refresh.
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

  const [adoEvidence, priorStructuredUpdate, openFollowups] = await Promise.all([
    fetchAdoEvidenceForMember({
      project: config.project,
      areaPath: config.areaPath,
      memberEmail,
      memberDisplayName,
      enablePrEvidence: resolvedPolicy.enablePrEvidence,
      enablePipelineEvidence: resolvedPolicy.enablePipelineEvidence,
    }),
    resolvedPolicy.enableCommitmentMemory
      ? findPriorSubmittedUpdate(participant.userId, participant.sessionId)
      : Promise.resolve(null),
    findOpenFollowupsForUser(participant.userId),
  ]);

  const brief = evaluateParticipantBrief({
    deliveryModel,
    teamGoal: config.teamGoal ?? null,
    policy: resolvedPolicy,
    expectedIterationPath: config.iterationPath ?? null,
    activeWorkItems: adoEvidence.activeWorkItems,
    changedSinceLastWorkItems: adoEvidence.changedSinceLastWorkItems,
    pullRequests: adoEvidence.pullRequests,
    pipelineFailures: adoEvidence.pipelineFailures,
    priorStructuredUpdate,
    openFollowups,
  });

  await db
    .update(standupParticipants)
    .set({ preparedBrief: brief })
    .where(eq(standupParticipants.id, participantId));

  return brief;
}
