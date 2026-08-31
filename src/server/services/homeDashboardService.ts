import type {
  ArtifactCycleTimeData,
  DevToProductionData,
  HomeDashboardPayload,
  IncompletePipelineData,
  MyWorkData,
  OpenBugsOnPbisData,
  TileResult,
} from '../../shared/types/homeDashboard';
import { isAppNativeRequirementsProject } from '../../shared/types/devWorkbench';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../shared/types/menuSettings';
import type { ProjectMenuConfig } from '../../shared/types/menuSettings';
import { getMedians } from './artifactCycleTimeService';
import {
  createProductionDefectRollupService,
  type DefectRollup,
} from './defectRollupService';
import {
  createProductionDeliveryCycleTimeService,
  type DeliveryCycleTime,
} from './deliveryCycleTimeService';
import { getUserGroupNames } from './groupService';
import { getMenuConfig } from './menuSettingsService';
import {
  createProductionMyWorkSummaryService,
  type MyWorkSummary,
} from './myWorkSummaryService';
import { getIncompletePipeline } from './pipelineArtifactStatusService';
import { getUserPermissions } from './rbacService';
import { trackEvent } from './telemetry';

export const HOME_DASHBOARD_LOCAL_TIMEOUT_MS = 2_000;
export const HOME_DASHBOARD_REMOTE_TIMEOUT_MS = 5_000;

const WINDOW_DAYS = 90 as const;
const MAX_CACHE_ENTRIES = 200;

export interface HomeDashboardDependencies {
  getUserPermissions(userId: string, project: string): Promise<Set<string>>;
  getMenuConfig(project: string): Promise<ProjectMenuConfig | null>;
  getUserGroupNames(userId: string): Promise<string[]>;
  getIncompletePipeline(project: string): Promise<IncompletePipelineData>;
  getArtifactCycleTime(project: string): Promise<ArtifactCycleTimeData>;
  getMyWorkSummary(input: { userId: string; project: string }): Promise<MyWorkSummary>;
  getDefectRollup(input: { project: string }): Promise<DefectRollup>;
  getDeliveryCycleTime(input: { project: string }): Promise<DeliveryCycleTime>;
  trackEvent(
    name: string,
    properties?: Record<string, string>,
    measurements?: Record<string, number>,
  ): void;
}

export interface HomeDashboardOptions {
  localTimeoutMs?: number;
  remoteTimeoutMs?: number;
}

export interface HomeDashboardInput {
  userId: string;
  project: string;
  isSuperAdmin: boolean;
}

interface CacheEntry<T> {
  data: T;
  updatedAt: number;
}

type DashboardTile = keyof HomeDashboardPayload;

function errorMessage(timedOut: boolean): string {
  if (timedOut) return 'The data source timed out. Retry to refresh this tile.';
  return 'The data source failed. Retry to refresh this tile.';
}

function timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HOME_DASHBOARD_TIMEOUT')), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class HomeDashboardService {
  private readonly localTimeoutMs: number;
  private readonly remoteTimeoutMs: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly dependencies: HomeDashboardDependencies,
    options: HomeDashboardOptions = {},
  ) {
    this.localTimeoutMs = options.localTimeoutMs ?? HOME_DASHBOARD_LOCAL_TIMEOUT_MS;
    this.remoteTimeoutMs = options.remoteTimeoutMs ?? HOME_DASHBOARD_REMOTE_TIMEOUT_MS;
  }

  async getDashboard(input: HomeDashboardInput): Promise<HomeDashboardPayload> {
    if (!input.userId || !input.project) throw new Error('userId and project are required');

    const permissions = await this.dependencies.getUserPermissions(input.userId, input.project);
    const [menuConfig, groupNames] = await Promise.all([
      !input.isSuperAdmin && permissions.has('interviews:view')
        ? this.dependencies.getMenuConfig(input.project).catch(() => ({
          project: input.project,
          enabledViews: [],
        }))
        : Promise.resolve(null),
      permissions.has('dev-workbench:view')
        ? this.dependencies.getUserGroupNames(input.userId).catch(() => [])
        : Promise.resolve([]),
    ]);
    const enabledViews = new Set(menuConfig?.enabledViews ?? DEFAULT_ENABLED_MENU_VIEWS);
    const groups = new Set(groupNames.map((name) => name.toLowerCase()));
    const projectUsesLocalWorkData = isAppNativeRequirementsProject(input.project);
    const canViewInterviewTiles = input.isSuperAdmin
      || (permissions.has('interviews:view') && enabledViews.has('backlog'));
    const canViewMyWork = permissions.has('dev-workbench:view') && groups.has('developer');

    const incompletePipeline = canViewInterviewTiles
      ? this.loadTile(
        'incompletePipeline',
        input.project,
        () => this.dependencies.getIncompletePipeline(input.project),
        (data) => data.groups.every((group) => group.count === 0),
        this.localTimeoutMs,
      )
      : Promise.resolve(null);
    const artifactCycleTime = canViewInterviewTiles
      ? this.loadTile(
        'artifactCycleTime',
        input.project,
        () => this.dependencies.getArtifactCycleTime(input.project),
        (data) => Object.values(data).every((kpi) => kpi.sampleSize === 0),
        this.localTimeoutMs,
      )
      : Promise.resolve(null);
    const myWork = canViewMyWork
      ? this.loadTile(
        'myWork',
        input.project,
        async () => this.mapMyWork(await this.dependencies.getMyWorkSummary({
          userId: input.userId,
          project: input.project,
        })),
        (data) => data.ready === 0
          && data.inProgress === 0
          && data.cycleTime.sampleSize === 0,
        projectUsesLocalWorkData ? this.localTimeoutMs : this.remoteTimeoutMs,
      )
      : Promise.resolve(null);
    const openBugsOnPbis = permissions.has('calendar:view')
      ? this.loadTile(
        'openBugsOnPbis',
        input.project,
        async () => this.mapDefects(await this.dependencies.getDefectRollup({
          project: input.project,
        })),
        (data) => data.totalOpenBugs === 0,
        this.remoteTimeoutMs,
        `${input.project}:openBugsOnPbis`,
      )
      : Promise.resolve(null);
    const devToProduction = permissions.has('planning:releases')
      ? this.loadTile(
        'devToProduction',
        input.project,
        async () => this.mapDelivery(await this.dependencies.getDeliveryCycleTime({
          project: input.project,
        })),
        (data) => data.sampleSize === 0,
        this.remoteTimeoutMs,
        `${input.project}:devToProduction`,
      )
      : Promise.resolve(null);

    const [pipelineResult, cycleTimeResult, myWorkResult, defectsResult, deliveryResult] =
      await Promise.all([
        incompletePipeline,
        artifactCycleTime,
        myWork,
        openBugsOnPbis,
        devToProduction,
      ]);

    return {
      incompletePipeline: pipelineResult,
      artifactCycleTime: cycleTimeResult,
      myWork: myWorkResult,
      openBugsOnPbis: defectsResult,
      devToProduction: deliveryResult,
    };
  }

  private async loadTile<T>(
    tile: DashboardTile,
    project: string,
    load: () => Promise<T>,
    isEmpty: (data: T) => boolean,
    timeoutMs: number,
    cacheKey?: string,
  ): Promise<TileResult<T>> {
    const startedAt = Date.now();
    let result: TileResult<T>;
    try {
      const data = await timeout(Promise.resolve().then(load), timeoutMs);
      result = { status: isEmpty(data) ? 'empty' : 'ok', data };
      if (cacheKey) this.updateCache(cacheKey, data);
    } catch (error) {
      const cached = cacheKey
        ? this.cache.get(cacheKey) as CacheEntry<T> | undefined
        : undefined;
      result = {
        status: 'error',
        data: null,
        ...(cached ? { lastKnownData: cached.data } : {}),
        message: errorMessage(
          error instanceof Error && error.message === 'HOME_DASHBOARD_TIMEOUT',
        ),
      };
    }

    this.dependencies.trackEvent(
      'home_dashboard.tile_result',
      { tile, project, status: result.status },
      { durationMs: Date.now() - startedAt },
    );
    return result;
  }

  private updateCache<T>(key: string, data: T): void {
    this.cache.delete(key);
    this.cache.set(key, { data, updatedAt: Date.now() });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
  }

  private mapMyWork(summary: MyWorkSummary): MyWorkData {
    return {
      ready: summary.readyCount,
      inProgress: summary.inProgressCount,
      cycleTime: {
        medianDays: summary.medianCompletionDays,
        sampleSize: summary.sampleSize,
        windowDays: WINDOW_DAYS,
      },
    };
  }

  private mapDefects(rollup: DefectRollup): OpenBugsOnPbisData {
    return {
      totalOpenBugs: rollup.projectOpenDefectCount,
      rows: rollup.pbiRows.map((row) => ({
        pbiId: String(row.pbiId),
        title: row.title,
        openBugCount: row.openDefectCount,
        updatedAt: row.changedAt ?? '',
      })),
    };
  }

  private mapDelivery(cycleTime: DeliveryCycleTime): DevToProductionData {
    return {
      medianDays: cycleTime.medianCycleTimeDays,
      sampleSize: cycleTime.releases.length,
      windowDays: WINDOW_DAYS,
    };
  }
}

export function createHomeDashboardService(
  dependencies: HomeDashboardDependencies,
  options?: HomeDashboardOptions,
): HomeDashboardService {
  return new HomeDashboardService(dependencies, options);
}

const productionMyWork = createProductionMyWorkSummaryService();
const productionDefects = createProductionDefectRollupService();
const productionDelivery = createProductionDeliveryCycleTimeService();

const productionService = createHomeDashboardService({
  getUserPermissions,
  getMenuConfig,
  getUserGroupNames,
  getIncompletePipeline,
  getArtifactCycleTime: getMedians,
  getMyWorkSummary: (input) => productionMyWork.getSummary(input),
  getDefectRollup: (input) => productionDefects.getRollup(input),
  getDeliveryCycleTime: (input) => productionDelivery.getCycleTime(input),
  trackEvent,
});

/** Production entry point for the eventual GET /api/home-dashboard route. */
export function getHomeDashboard(input: HomeDashboardInput): Promise<HomeDashboardPayload> {
  return productionService.getDashboard(input);
}
