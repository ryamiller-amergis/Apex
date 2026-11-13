import {
  classifyWorkItemReadiness,
  computeReleaseReadiness,
  filterAndSortInspectorItems,
  filterReleaseEpics,
  formatRemainingSummary,
  formatTargetDateCountdown,
  getEpicPlatform,
  sortReleaseEpics,
  type ReleaseEpic,
} from '../releaseReadiness';
import type { WorkItem } from '../../types/workitem';

const makeItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: 1,
  title: 'Sample Item',
  state: 'In Progress',
  workItemType: 'Feature',
  areaPath: 'MaxView\\Mobile',
  iterationPath: 'MaxView\\Sprint 1',
  changedDate: '2026-11-01',
  createdDate: '2026-10-20',
  ...overrides,
});

const makeEpic = (overrides: Partial<ReleaseEpic> = {}): ReleaseEpic => ({
  id: 100,
  version: 'v2.4.0',
  status: 'In Progress',
  areaPath: 'MaxView\\Mobile',
  platform: 'Mobile',
  progress: 50,
  totalItems: 4,
  completedItems: 2,
  greenItems: 2,
  amberItems: 1,
  redItems: 1,
  ...overrides,
});

describe('releaseReadiness utilities', () => {
  describe('getEpicPlatform', () => {
    it('prefers explicit platform and falls back to deriveReleasePlatform', () => {
      expect(getEpicPlatform({ platform: 'Mobile', areaPath: 'MaxView\\Desktop' })).toBe('Mobile');
      expect(getEpicPlatform({ areaPath: 'MaxView\\Desktop' })).toBe('Desktop');
      expect(getEpicPlatform({}, 'MaxView')).toBe('MaxView');
    });
  });

  describe('formatTargetDateCountdown', () => {
    const today = new Date(2026, 10, 13, 10, 0, 0); // Nov 13, 2026

    it('returns No target date when missing', () => {
      expect(formatTargetDateCountdown(undefined, 'In Progress', today)).toEqual({
        label: 'No target date',
        variant: 'none',
      });
    });

    it('formats upcoming days left', () => {
      expect(formatTargetDateCountdown('2026-11-18', 'In Progress', today)).toEqual({
        label: 'Nov 18 · 5d left',
        variant: 'due-soon',
      });
      expect(formatTargetDateCountdown('2026-11-30', 'New', today)).toEqual({
        label: 'Nov 30 · 17d left',
        variant: 'upcoming',
      });
    });

    it('formats overdue dates and today', () => {
      expect(formatTargetDateCountdown('2026-11-10', 'In Progress', today)).toEqual({
        label: 'Nov 10 · Overdue',
        variant: 'overdue',
      });
      expect(formatTargetDateCountdown('2026-11-13', 'In Progress', today)).toEqual({
        label: 'Nov 13 · Today',
        variant: 'due-soon',
      });
    });

    it('omits countdown for shipped releases', () => {
      expect(formatTargetDateCountdown('2026-11-01', 'Done', today)).toEqual({
        label: 'Nov 1',
        variant: 'shipped',
      });
    });
  });

  describe('formatRemainingSummary', () => {
    it('formats remaining Dev and UAT counts', () => {
      expect(formatRemainingSummary({ totalItems: 6, completedItems: 2, greenItems: 2, amberItems: 2, redItems: 2 })).toBe('2 Dev · 2 UAT');
      expect(formatRemainingSummary({ totalItems: 3, completedItems: 1, greenItems: 1, amberItems: 0, redItems: 2 })).toBe('2 Dev');
      expect(formatRemainingSummary({ totalItems: 3, completedItems: 2, greenItems: 2, amberItems: 1, redItems: 0 })).toBe('1 UAT');
      expect(formatRemainingSummary({ totalItems: 3, completedItems: 3, greenItems: 3, amberItems: 0, redItems: 0 })).toBe('All ready');
      expect(formatRemainingSummary({ totalItems: 0, completedItems: 0, greenItems: 0, amberItems: 0, redItems: 0 })).toBe('No items');
    });
  });

  describe('filterReleaseEpics & sortReleaseEpics', () => {
    const epics: ReleaseEpic[] = [
      makeEpic({ id: 1, version: 'v2.4.0', platform: 'Mobile', status: 'In Progress', targetDate: '2026-11-25', progress: 40, description: 'Biometric login' }),
      makeEpic({ id: 2, version: 'v3.0.0', platform: 'Desktop', status: 'New', targetDate: '2026-11-18', progress: 80, description: 'Ribbon redesign' }),
      makeEpic({ id: 3, version: 'v2.3.0', platform: 'Mobile', status: 'Done', targetDate: '2026-10-15', progress: 100, description: 'Offline sync' }),
    ];

    it('filters by lifecycle scope, platform, and search', () => {
      expect(filterReleaseEpics(epics, { platform: 'All', scope: 'active', search: '' }).map((e) => e.id)).toEqual([1, 2]);
      expect(filterReleaseEpics(epics, { platform: 'Mobile', scope: 'active', search: '' }).map((e) => e.id)).toEqual([1]);
      expect(filterReleaseEpics(epics, { platform: 'All', scope: 'shipped', search: '' }).map((e) => e.id)).toEqual([3]);
      expect(filterReleaseEpics(epics, { platform: 'All', scope: 'all', search: 'ribbon' }).map((e) => e.id)).toEqual([2]);
    });

    it('sorts by manual, targetDate, progress, and version', () => {
      expect(sortReleaseEpics(epics, 'manual', 'asc').map((e) => e.id)).toEqual([1, 2, 3]);
      expect(sortReleaseEpics(epics, 'targetDate', 'asc').map((e) => e.id)).toEqual([3, 2, 1]);
      expect(sortReleaseEpics(epics, 'progress', 'desc').map((e) => e.id)).toEqual([3, 2, 1]);
      expect(sortReleaseEpics(epics, 'version', 'asc').map((e) => e.id)).toEqual([3, 1, 2]);
    });
  });

  describe('computeReleaseReadiness & filterAndSortInspectorItems', () => {
    const items: WorkItem[] = [
      makeItem({ id: 10, title: 'Done item', state: 'Done', assignedTo: 'Alice' }),
      makeItem({ id: 11, title: 'UAT item', state: 'UAT - Ready For Test', assignedTo: 'Bob' }),
      makeItem({ id: 12, title: 'Dev item', state: 'In Progress', assignedTo: undefined }),
      makeItem({ id: 13, title: 'Blocked item', state: 'Blocked', assignedTo: 'Carol' }),
    ];

    it('classifies readiness buckets and computes gap counts', () => {
      expect(classifyWorkItemReadiness(items[0])).toBe('green');
      expect(classifyWorkItemReadiness(items[1])).toBe('amber');
      expect(classifyWorkItemReadiness(items[2])).toBe('red');
      expect(classifyWorkItemReadiness(items[3])).toBe('red');

      const summary = computeReleaseReadiness(items, makeEpic({ targetDate: undefined }), false);
      expect(summary.readyCount).toBe(1);
      expect(summary.uatCount).toBe(1);
      expect(summary.notReadyCount).toBe(2);
      expect(summary.unassignedCount).toBe(1);
      expect(summary.missingTargetDate).toBe(true);
      expect(summary.missingOutcome).toBe(true);
      expect(summary.isAllClear).toBe(false);
    });

    it('filters by tab and gap filter with Blocked/Red prioritized first', () => {
      expect(filterAndSortInspectorItems(items, 'needs-attention', null).map((i) => i.id)).toEqual([13, 12, 11]);
      expect(filterAndSortInspectorItems(items, 'ready', null).map((i) => i.id)).toEqual([10]);
      expect(filterAndSortInspectorItems(items, 'all', null).map((i) => i.id)).toEqual([13, 12, 11, 10]);
      expect(filterAndSortInspectorItems(items, 'ready', 'dev').map((i) => i.id)).toEqual([13, 12]);
      expect(filterAndSortInspectorItems(items, 'needs-attention', 'uat').map((i) => i.id)).toEqual([11]);
      expect(filterAndSortInspectorItems(items, 'needs-attention', 'unassigned').map((i) => i.id)).toEqual([12]);
    });
  });
});
