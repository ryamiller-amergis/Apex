import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { isAppNativeRequirementsProject } from '../../shared/types/devWorkbench';
import { db } from '../db/drizzle';
import {
  apexReleases,
  apexWorkItemEvents,
  apexWorkItems,
  devSessions,
} from '../db/schema';
import { listDeployments } from './apexDeploymentService';
import { AzureDevOpsService } from './azureDevOps';
import { computeMedianDays } from './medianDuration';

export interface DeliveryItem {
  id: string | number;
  releaseTags: string[];
  /** Apex/Amego first development start (dev_sessions.created_at). */
  nativeDevStartedAt?: string | null;
  /** ADO item's first revision in In Progress or Active. */
  adoFirstInProgressAt?: string | null;
  /** Observed completion used when no deployment tracker record exists. */
  observedProductionAt?: string | null;
}

export interface DeploymentRecord {
  deployedAt: string;
}

export interface LatestReleaseDeployments {
  dev?: DeploymentRecord;
  staging?: DeploymentRecord;
  production?: DeploymentRecord;
}

export interface DeliveryCycleTimeDependencies {
  listDeliveryItems(input: { project: string; since: string }): Promise<DeliveryItem[]>;
  getLatestDeploymentsByRelease(
    releaseName: string,
    project: string,
  ): Promise<LatestReleaseDeployments>;
}

export interface ReleaseCycleTime {
  workItemId: string | number;
  releaseName: string;
  devStartedAt: string;
  productionDeployedAt: string;
  cycleTimeDays: number;
}

export interface DeliveryCycleTime {
  medianCycleTimeDays: number | null;
  releases: ReleaseCycleTime[];
}

const DAYS_90_MS = 90 * 24 * 60 * 60 * 1000;
const RELEASE_PREFIX = 'Release:';

export class DeliveryCycleTimeService {
  constructor(private readonly dependencies: DeliveryCycleTimeDependencies) {}

  async getCycleTime(input: { project: string; now?: Date }): Promise<DeliveryCycleTime> {
    if (!input.project) throw new Error('project is required');

    const now = input.now ?? new Date();
    const sinceMs = now.getTime() - DAYS_90_MS;
    const since = new Date(sinceMs).toISOString();
    const items = await this.dependencies.listDeliveryItems({ project: input.project, since });
    const releases: ReleaseCycleTime[] = [];

    for (const item of items) {
      const startValue = item.nativeDevStartedAt ?? item.adoFirstInProgressAt;
      const startMs = startValue ? Date.parse(startValue) : Number.NaN;
      if (Number.isNaN(startMs)) continue;

      const releaseNames = [...new Set(item.releaseTags
        .filter((tag) => tag.startsWith(RELEASE_PREFIX))
        .map((tag) => tag.slice(RELEASE_PREFIX.length).trim())
        .filter(Boolean))];
      if (releaseNames.length === 0) continue;

      const productionCandidates = item.observedProductionAt
        ? [{
          releaseName: releaseNames[0],
          deployedAt: item.observedProductionAt,
          deployedMs: Date.parse(item.observedProductionAt),
        }]
        : await Promise.all(releaseNames.map(async (releaseName) => {
          const latest = await this.dependencies.getLatestDeploymentsByRelease(
            releaseName,
            input.project,
          );
          const deployedAt = latest.production?.deployedAt;
          const deployedMs = deployedAt ? Date.parse(deployedAt) : Number.NaN;
          return { releaseName, deployedAt, deployedMs };
        }));
      const firstProduction = productionCandidates
        .filter((candidate) =>
          candidate.deployedAt
          && !Number.isNaN(candidate.deployedMs)
          && candidate.deployedMs >= startMs
          && candidate.deployedMs >= sinceMs
          && candidate.deployedMs <= now.getTime())
        .sort((a, b) => a.deployedMs - b.deployedMs)[0];
      if (!firstProduction?.deployedAt) continue;

      const devStartedAt = new Date(startMs).toISOString();
      const productionDeployedAt = new Date(firstProduction.deployedMs).toISOString();
      const cycleTimeDays = (firstProduction.deployedMs - startMs) / (24 * 60 * 60 * 1000);
      releases.push({
        workItemId: item.id,
        releaseName: firstProduction.releaseName,
        devStartedAt,
        productionDeployedAt,
        cycleTimeDays: Math.round(cycleTimeDays * 10) / 10,
      });
    }

    releases.sort((a, b) => a.productionDeployedAt.localeCompare(b.productionDeployedAt));
    return {
      medianCycleTimeDays: computeMedianDays(releases.map((release) => ({
        createdAt: release.devStartedAt,
        doneAt: release.productionDeployedAt,
      }))),
      releases,
    };
  }
}

function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

/** Production adapter backed by ADO revisions or the Apex Work Board, plus PG deployments. */
export function createProductionDeliveryCycleTimeService(): DeliveryCycleTimeService {
  const deploymentsInFlight = new Map<
    string,
    Promise<Awaited<ReturnType<typeof listDeployments>>>
  >();

  return new DeliveryCycleTimeService({
    async listDeliveryItems({ project, since }) {
      if (isAppNativeRequirementsProject(project)) {
        const rows = await db
          .select({
            id: apexWorkItems.id,
            releaseName: apexReleases.version,
            releaseFallbackName: apexReleases.name,
          })
          .from(apexWorkItems)
          .innerJoin(apexReleases, eq(apexWorkItems.releaseId, apexReleases.id))
          .where(and(
            eq(apexWorkItems.project, project),
            isNotNull(apexWorkItems.releaseId),
          ));
        if (rows.length === 0) return [];

        const events = await db
          .select({
            workItemId: apexWorkItemEvents.workItemId,
            createdAt: apexWorkItemEvents.createdAt,
          })
          .from(apexWorkItemEvents)
          .where(and(
            inArray(apexWorkItemEvents.workItemId, rows.map((row) => row.id)),
            eq(apexWorkItemEvents.toStatus, 'in-progress'),
          ))
          .orderBy(asc(apexWorkItemEvents.createdAt));
        const firstStart = new Map<string, string>();
        for (const event of events) {
          if (!firstStart.has(event.workItemId)) {
            firstStart.set(event.workItemId, event.createdAt);
          }
        }

        return rows.map((row) => ({
          id: row.id,
          releaseTags: [`${RELEASE_PREFIX}${row.releaseName ?? row.releaseFallbackName}`],
          nativeDevStartedAt: firstStart.get(row.id) ?? null,
        }));
      }

      const ado = new AzureDevOpsService(project);
      // ADO's ChangedDate field uses date precision in WIQL and rejects ISO
      // timestamps that include a time component.
      const sinceDate = since.slice(0, 10);
      const result = await ado.queryWorkItemsByWiql({
        wiql: [
          'SELECT [System.Id] FROM WorkItems',
          `WHERE [System.TeamProject] = '${escapeWiql(project)}'`,
          "AND [System.Tags] CONTAINS 'Release:'",
          `AND [System.ChangedDate] >= '${sinceDate}'`,
        ].join(' '),
        fields: ['System.Id', 'System.Tags'],
        maxResults: 500,
      });
      if (result.items.length === 0) {
        // MaxView's Releases tab is backed by ReleaseVersion Epics rather than
        // Release:<name> work-item tags and Apex deployment records. Use completed
        // related work items so the KPI reflects delivery flow, not how long the
        // release Epic remained open.
        const releaseResult = await ado.queryWorkItemsByWiql({
          wiql: [
            'SELECT [System.Id] FROM WorkItems',
            `WHERE [System.TeamProject] = '${escapeWiql(project)}'`,
            "AND [System.WorkItemType] = 'Epic'",
            "AND [System.Tags] CONTAINS 'ReleaseVersion'",
            "AND [System.State] IN ('Done', 'Closed')",
            `AND [System.ChangedDate] >= '${sinceDate}'`,
          ].join(' '),
          fields: [
            'System.Id',
            'System.Title',
            'System.State',
            'System.ChangedDate',
            'Microsoft.VSTS.Scheduling.StartDate',
          ],
          maxResults: 200,
        });

        const deliveryItems: DeliveryItem[] = [];
        const batchSize = 3;
        for (let i = 0; i < releaseResult.items.length; i += batchSize) {
          const batch = await Promise.all(
            releaseResult.items.slice(i, i + batchSize).map(async (release) => {
              const releaseName = String(release.fields['System.Title'] ?? '');
              const cycleTime = await ado.getRelatedItemsCycleTime(release.id);
              return cycleTime.items
                .filter((item) =>
                  item.cycleTimeDays != null
                  && item.lastInProgressAt
                  && item.lastDoneAt)
                .map((item): DeliveryItem => ({
                  id: item.id,
                  releaseTags: [`${RELEASE_PREFIX}${releaseName}`],
                  adoFirstInProgressAt: item.lastInProgressAt,
                  observedProductionAt: item.lastDoneAt,
                }));
            }),
          );
          deliveryItems.push(...batch.flat());
        }
        return deliveryItems;
      }
      const sessionRows = result.items.length === 0
        ? []
        : await db
          .select({ workItemId: devSessions.workItemId, createdAt: devSessions.createdAt })
          .from(devSessions)
          .where(and(
            eq(devSessions.project, project),
            inArray(devSessions.workItemId, result.items.map((item) => item.id)),
          ))
          .orderBy(asc(devSessions.createdAt));
      const firstSession = new Map<number, string>();
      for (const session of sessionRows) {
        if (session.workItemId != null && !firstSession.has(session.workItemId)) {
          firstSession.set(session.workItemId, session.createdAt);
        }
      }

      return Promise.all(result.items.map(async (item): Promise<DeliveryItem> => {
        const revisions = await ado.getWorkItemRevisionHistory(item.id, 500);
        const firstInProgress = revisions.find((revision) => {
          const state = String(revision.state ?? '').trim().toLowerCase();
          return state === 'in progress' || state === 'active';
        });
        return {
          id: item.id,
          releaseTags: String(item.fields['System.Tags'] ?? '')
            .split(';')
            .map((tag) => tag.trim())
            .filter(Boolean),
          nativeDevStartedAt: firstSession.get(item.id) ?? null,
          adoFirstInProgressAt: firstInProgress?.changedDate ?? null,
        };
      }));
    },

    async getLatestDeploymentsByRelease(releaseName, project) {
      let projectDeployments = deploymentsInFlight.get(project);
      if (!projectDeployments) {
        projectDeployments = listDeployments(project);
        deploymentsInFlight.set(project, projectDeployments);
        void projectDeployments.then(
          () => setTimeout(() => deploymentsInFlight.delete(project), 0).unref?.(),
          () => setTimeout(() => deploymentsInFlight.delete(project), 0).unref?.(),
        );
      }
      const matching = (await projectDeployments).filter((deployment) =>
        deployment.version === releaseName);
      const latest: LatestReleaseDeployments = {};
      for (const deployment of matching) {
        const environment = deployment.environment === 'prod'
          ? 'production'
          : deployment.environment;
        if (!latest[environment]) latest[environment] = { deployedAt: deployment.deployedAt };
      }
      return latest;
    },
  });
}
