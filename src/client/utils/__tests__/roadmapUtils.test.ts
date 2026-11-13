import type { WorkItem } from '../../types/workitem';
import type {
  RoadmapAdhocIdeaDto,
  RoadmapChangeEventDto,
  RoadmapPlanOverlayDto,
} from '../../../shared/types/roadmap';
import {
  buildWorkbenchItems,
  calculateHealthStatus,
  calculateRoadmapDriftKpis,
  calculateSlipDays,
  calculateWeightedRollup,
  deriveDefaultHorizon,
  resolveWorkItemSchedule,
  shiftIsoDate,
} from '../roadmapUtils';

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 501,
    title: 'Provider Credentialing Modernization',
    state: 'New',
    workItemType: 'Epic',
    changedDate: '2026-11-01T00:00:00.000Z',
    createdDate: '2026-10-15T00:00:00.000Z',
    areaPath: 'MaxView',
    iterationPath: 'MaxView\\Sprint 12',
    ...overrides,
  };
}

function makeOverlay(
  overrides: Partial<RoadmapPlanOverlayDto> = {},
): RoadmapPlanOverlayDto {
  return {
    id: 'ov-1',
    project: 'MaxView',
    workItemId: 501,
    workItemType: 'Epic',
    horizon: 'now',
    plannedStartDate: '2026-11-01',
    plannedTargetDate: '2026-12-15',
    baselineTargetDate: '2026-12-01',
    confidence: 'high',
    notes: 'Overlay note',
    sortOrder: 0,
    updatedBy: 'user-1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('roadmapUtils', () => {
  describe('4-tier schedule resolution', () => {
    it('Tier 1: prioritizes Apex Plan overlay dates over ADO targetDate and child dates', () => {
      const epic = makeWorkItem({ targetDate: '2027-02-01' });
      const overlay = makeOverlay({
        plannedStartDate: '2026-11-10',
        plannedTargetDate: '2026-12-20',
        baselineTargetDate: '2026-12-06',
      });
      const child = makeWorkItem({
        id: 502,
        workItemType: 'Feature',
        targetDate: '2027-03-01',
      });

      const resolved = resolveWorkItemSchedule(epic, overlay, [child]);
      expect(resolved).toEqual({
        scheduleSource: 'apex-plan',
        effectiveStartDate: '2026-11-10',
        effectiveTargetDate: '2026-12-20',
        baselineTargetDate: '2026-12-06',
        slipDays: 14,
      });
    });

    it('Tier 2: falls back to ADO TargetDate when Apex Plan target is unset', () => {
      const epic = makeWorkItem({
        createdDate: '2026-10-01T00:00:00.000Z',
        targetDate: '2026-12-10',
      });
      const resolved = resolveWorkItemSchedule(epic, undefined, []);
      expect(resolved.scheduleSource).toBe('ado-target');
      expect(resolved.effectiveTargetDate).toBe('2026-12-10');
      expect(resolved.effectiveStartDate).toBe('2026-10-01');
    });

    it('Tier 3: infers min/max dates from active child Features/PBIs when Epic has no targetDate', () => {
      const epic = makeWorkItem({ targetDate: undefined });
      const children: WorkItem[] = [
        makeWorkItem({
          id: 601,
          workItemType: 'Feature',
          state: 'In Progress',
          targetDate: '2026-12-05',
        }),
        makeWorkItem({
          id: 602,
          workItemType: 'Product Backlog Item',
          state: 'New',
          dueDate: '2026-12-22',
        }),
        makeWorkItem({
          id: 603,
          workItemType: 'Feature',
          state: 'Removed',
          targetDate: '2027-06-01',
        }),
      ];

      const resolved = resolveWorkItemSchedule(epic, undefined, children);
      expect(resolved.scheduleSource).toBe('inferred-child');
      expect(resolved.effectiveTargetDate).toBe('2026-12-22');
    });

    it('Tier 4: resolves as unscheduled (Horizon Only) when neither Epic, overlay, nor children carry dates', () => {
      const epic = makeWorkItem({ targetDate: undefined });
      const resolved = resolveWorkItemSchedule(epic, undefined, []);
      expect(resolved).toEqual({
        scheduleSource: 'unscheduled',
        effectiveStartDate: null,
        effectiveTargetDate: null,
        baselineTargetDate: null,
        slipDays: null,
      });
    });
  });

  describe('default horizon & weighted rollup & slip helpers', () => {
    const fixedNow = new Date(2026, 10, 13, 12, 0, 0); // Nov 13, 2026

    it('derives default horizon from work item state and 60-day window', () => {
      expect(deriveDefaultHorizon('In Progress', null, fixedNow)).toBe('now');
      expect(deriveDefaultHorizon('Active', null, fixedNow)).toBe('now');
      expect(deriveDefaultHorizon('New', '2027-03-01', fixedNow)).toBe('later');
      expect(deriveDefaultHorizon('New', null, fixedNow)).toBe('unplanned');
    });

    it('computes weighted progress across Done, UAT, In Progress, and Todo children', () => {
      const children: WorkItem[] = [
        makeWorkItem({ id: 1, state: 'Done' }), // 100
        makeWorkItem({ id: 2, state: 'UAT - Ready For Test' }), // 75
        makeWorkItem({ id: 3, state: 'In Progress' }), // 50
        makeWorkItem({ id: 4, state: 'New' }), // 0
        makeWorkItem({ id: 5, state: 'Removed' }), // ignored
      ];
      const rollup = calculateWeightedRollup(children);
      expect(rollup.totalCount).toBe(4);
      expect(rollup.doneCount).toBe(1);
      expect(rollup.uatCount).toBe(1);
      expect(rollup.inProgressCount).toBe(1);
      expect(rollup.todoCount).toBe(1);
      expect(rollup.weightedCompletionPct).toBe(Math.round(225 / 4));
    });

    it('shifts dates by weeks and months and computes slip days', () => {
      expect(shiftIsoDate('2026-12-01', { days: 14 })).toBe('2026-12-15');
      expect(shiftIsoDate('2026-12-15', { days: -7 })).toBe('2026-12-08');
      expect(calculateSlipDays('2026-12-01', '2026-12-15')).toBe(14);
    });

    it('computes health status accurately for overdue, ahead, and on-track items', () => {
      expect(calculateHealthStatus(40, 100, -5)).toBe('behind');
      expect(calculateHealthStatus(100, 100, -5)).toBe('on-track');
      expect(calculateHealthStatus(80, 40, 20)).toBe('ahead');
      expect(calculateHealthStatus(0, 10, 90)).toBe('on-track');
    });

    it('builds workbench items including undated ADO Epics and excludes ReleaseVersion containers', () => {
      const undatedEpic = makeWorkItem({
        id: 701,
        title: 'Undated Staffing Epic',
        state: 'Active',
        targetDate: undefined,
      });
      const releaseEpic = makeWorkItem({
        id: 702,
        title: 'Release v2.4',
        state: 'Active',
        tags: 'ReleaseVersion; Production',
      });
      const adhocIdea: RoadmapAdhocIdeaDto = {
        id: 'idea-1',
        project: 'MaxView',
        title: 'Sandbox Triage Bot',
        ownerLabel: 'Alex',
        horizon: 'later',
        effortSize: 'M',
        confidence: 'medium',
        releaseLabel: null,
        notes: null,
        plannedStartDate: null,
        plannedTargetDate: null,
        baselineTargetDate: null,
        promotedFeatureRequestId: null,
        promotedAdoWorkItemId: null,
        promotedAt: null,
        archived: false,
        sortOrder: 0,
        createdBy: 'u1',
        updatedBy: 'u1',
        createdAt: '2026-11-13T00:00:00.000Z',
        updatedAt: '2026-11-13T00:00:00.000Z',
      };

      const items = buildWorkbenchItems({
        workItems: [undatedEpic, releaseEpic],
        overlays: [],
        ideas: [adhocIdea],
        childrenByEpicId: new Map(),
        selectedStatuses: new Set(['Active', 'New']),
        showAdhocIdeas: true,
        searchQuery: '',
        now: fixedNow,
      });

      expect(items.map((i) => i.title)).toEqual([
        'Sandbox Triage Bot',
        'Undated Staffing Epic',
      ]);

      const events: RoadmapChangeEventDto[] = [
        {
          id: 'ev-1',
          project: 'MaxView',
          workItemId: 701,
          adhocIdeaId: null,
          itemTitle: 'Undated Staffing Epic',
          itemOrigin: 'ado',
          eventKind: 'horizon_changed',
          fromHorizon: 'unplanned',
          toHorizon: 'now',
          oldTargetDate: null,
          newTargetDate: null,
          deltaDays: null,
          reason: 'Horizon Re-prioritized',
          note: null,
          syncedToAdo: false,
          actorId: 'u1',
          actorName: 'Alex',
          createdAt: '2026-11-13T00:00:00.000Z',
        },
      ];

      const kpis = calculateRoadmapDriftKpis(items, events);
      expect(kpis.activeNowNextCount).toBe(1);
      expect(kpis.auditedMovesCount).toBe(1);
    });
  });
});
