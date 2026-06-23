import { deploymentOutcomes } from '../db/schema';

// ── Mock Drizzle ──────────────────────────────────────────────────────────────

const mockReturning = jest.fn();
const mockValues = jest.fn().mockReturnValue({ returning: mockReturning });
const mockInsert = jest.fn().mockReturnValue({ values: mockValues });

const mockLimit = jest.fn();
const mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
const mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy, limit: mockLimit });
const mockFrom = jest.fn().mockReturnValue({ where: mockWhere, orderBy: mockOrderBy });
const mockSelect = jest.fn().mockReturnValue({ from: mockFrom });

// selectDistinct shares the same chain shape as select
const mockDistinctFrom = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
const mockSelectDistinct = jest.fn().mockReturnValue({ from: mockDistinctFrom });

const mockUpdateReturning = jest.fn();
const mockUpdateWhere = jest.fn().mockReturnValue({ returning: mockUpdateReturning });
const mockUpdateSet = jest.fn().mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = jest.fn().mockReturnValue({ set: mockUpdateSet });

const mockDeleteReturning = jest.fn();
const mockDeleteWhere = jest.fn().mockReturnValue({ returning: mockDeleteReturning });
const mockDelete = jest.fn().mockReturnValue({ where: mockDeleteWhere });

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => mockSelect(),
    selectDistinct: () => mockSelectDistinct(),
    insert: (table: unknown) => mockInsert(table),
    update: (table: unknown) => mockUpdate(table),
    delete: (table: unknown) => mockDelete(table),
  },
}));

import {
  recordOutcome,
  getOutcomeByDeployment,
  getOutcomesByRelease,
  getAllOutcomes,
  getOutcomeSummary,
  getDistinctReleaseVersions,
  updateOutcome,
  deleteOutcome,
} from '../services/deploymentOutcomeService';
import type { DeploymentOutcome, CreateOutcomeInput } from '../../shared/types/deploymentOutcome';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const now = '2026-06-08T12:00:00.000Z';

const sampleOutcome: DeploymentOutcome = {
  id: 'aaaa-bbbb-cccc-dddd',
  deploymentId: 'deploy-1',
  releaseVersion: '2026.06.1',
  environment: 'production',
  result: 'success',
  downtimeMinutes: undefined,
  details: undefined,
  reportedBy: 'user-oid-1',
  reportedAt: now,
};

const sampleInput: CreateOutcomeInput = {
  deploymentId: 'deploy-1',
  releaseVersion: '2026.06.1',
  result: 'success',
};

// ── Schema smoke test ─────────────────────────────────────────────────────────

describe('deploymentOutcomes schema', () => {
  it('exports the deploymentOutcomes table with expected columns', () => {
    expect(deploymentOutcomes).toBeDefined();
    expect(deploymentOutcomes.id).toBeDefined();
    expect(deploymentOutcomes.deploymentId).toBeDefined();
    expect(deploymentOutcomes.releaseVersion).toBeDefined();
    expect(deploymentOutcomes.environment).toBeDefined();
    expect(deploymentOutcomes.result).toBeDefined();
    expect(deploymentOutcomes.downtimeMinutes).toBeDefined();
    expect(deploymentOutcomes.details).toBeDefined();
    expect(deploymentOutcomes.reportedBy).toBeDefined();
    expect(deploymentOutcomes.reportedAt).toBeDefined();
    expect(deploymentOutcomes.deployedAt).toBeDefined();
  });
});

// ── Service tests ─────────────────────────────────────────────────────────────

describe('deploymentOutcomeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── recordOutcome ─────────────────────────────────────────────────────────

  describe('recordOutcome', () => {
    it('inserts a row and returns the created outcome', async () => {
      mockReturning.mockResolvedValue([sampleOutcome]);

      const result = await recordOutcome(sampleInput, 'user-oid-1');

      expect(mockInsert).toHaveBeenCalledWith(deploymentOutcomes);
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          deploymentId: 'deploy-1',
          releaseVersion: '2026.06.1',
          result: 'success',
          reportedBy: 'user-oid-1',
        }),
      );
      expect(mockReturning).toHaveBeenCalled();
      expect(result).toEqual(sampleOutcome);
    });
  });

  // ── updateOutcome ───────────────────────────────────────────────────────

  describe('updateOutcome', () => {
    it('updates a row and returns the outcome', async () => {
      const updated = { ...sampleOutcome, result: 'rollback' as const };
      mockUpdateReturning.mockResolvedValue([updated]);

      const result = await updateOutcome('aaaa-bbbb-cccc-dddd', { result: 'rollback' });

      expect(mockUpdate).toHaveBeenCalledWith(deploymentOutcomes);
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'rollback' }),
      );
      expect(result).toEqual(updated);
    });

    it('returns null when outcome does not exist', async () => {
      mockUpdateReturning.mockResolvedValue([]);

      const result = await updateOutcome('missing', { result: 'success' });

      expect(result).toBeNull();
    });
  });

  // ── deleteOutcome ─────────────────────────────────────────────────────────

  describe('deleteOutcome', () => {
    it('returns true when a row is deleted', async () => {
      mockDeleteReturning.mockResolvedValue([{ id: 'aaaa-bbbb-cccc-dddd' }]);

      const result = await deleteOutcome('aaaa-bbbb-cccc-dddd');

      expect(mockDelete).toHaveBeenCalledWith(deploymentOutcomes);
      expect(result).toBe(true);
    });

    it('returns false when no row is deleted', async () => {
      mockDeleteReturning.mockResolvedValue([]);

      const result = await deleteOutcome('missing');

      expect(result).toBe(false);
    });
  });

  // ── getOutcomeByDeployment ────────────────────────────────────────────────

  describe('getOutcomeByDeployment', () => {
    it('returns an outcome when found', async () => {
      mockLimit.mockResolvedValue([sampleOutcome]);

      const result = await getOutcomeByDeployment('deploy-1');

      expect(mockSelect).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalledWith(deploymentOutcomes);
      expect(result).toEqual(sampleOutcome);
    });

    it('returns null when not found', async () => {
      mockLimit.mockResolvedValue([]);

      const result = await getOutcomeByDeployment('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ── getOutcomesByRelease ──────────────────────────────────────────────────

  describe('getOutcomesByRelease', () => {
    it('returns outcomes ordered by reported_at DESC', async () => {
      const outcomes = [sampleOutcome, { ...sampleOutcome, id: 'eeee' }];
      mockOrderBy.mockResolvedValue(outcomes);

      const result = await getOutcomesByRelease('2026.06.1');

      expect(mockFrom).toHaveBeenCalledWith(deploymentOutcomes);
      expect(mockWhere).toHaveBeenCalled();
      expect(result).toEqual(outcomes);
    });
  });

  // ── getAllOutcomes ────────────────────────────────────────────────────────

  describe('getAllOutcomes', () => {
    it('returns all outcomes when no filters provided', async () => {
      mockOrderBy.mockResolvedValue([sampleOutcome]);

      const result = await getAllOutcomes();

      expect(mockFrom).toHaveBeenCalledWith(deploymentOutcomes);
      expect(result).toEqual([sampleOutcome]);
    });

    it('applies filters when provided', async () => {
      mockOrderBy.mockResolvedValue([sampleOutcome]);

      const result = await getAllOutcomes({
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        result: 'success',
      });

      expect(mockWhere).toHaveBeenCalled();
      expect(result).toEqual([sampleOutcome]);
    });
  });

  // ── getOutcomeSummary ────────────────────────────────────────────────────

  describe('getOutcomeSummary', () => {
    it('returns aggregated counts and monthly breakdown', async () => {
      const allOutcomes: DeploymentOutcome[] = [
        { ...sampleOutcome, id: '1', result: 'success', reportedAt: '2026-01-15T00:00:00Z' },
        { ...sampleOutcome, id: '2', result: 'success', reportedAt: '2026-01-20T00:00:00Z' },
        { ...sampleOutcome, id: '3', result: 'downtime', downtimeMinutes: 30, reportedAt: '2026-02-10T00:00:00Z' },
        { ...sampleOutcome, id: '4', result: 'rollback', reportedAt: '2026-02-15T00:00:00Z' },
        { ...sampleOutcome, id: '5', result: 'downtime', downtimeMinutes: 60, reportedAt: '2026-02-20T00:00:00Z' },
      ];

      mockOrderBy.mockResolvedValue(allOutcomes);

      const summary = await getOutcomeSummary();

      expect(summary.total).toBe(5);
      expect(summary.success).toBe(2);
      expect(summary.downtime).toBe(2);
      expect(summary.rollback).toBe(1);
      expect(summary.avgDowntimeMinutes).toBe(45);
      expect(summary.byMonth).toEqual([
        { month: '2026-01', success: 2, downtime: 0, rollback: 0 },
        { month: '2026-02', success: 0, downtime: 2, rollback: 1 },
      ]);
    });

    it('returns zero avgDowntimeMinutes when no downtime outcomes exist', async () => {
      mockOrderBy.mockResolvedValue([
        { ...sampleOutcome, id: '1', result: 'success', reportedAt: '2026-03-01T00:00:00Z' },
      ]);

      const summary = await getOutcomeSummary();

      expect(summary.avgDowntimeMinutes).toBe(0);
    });

    it('returns empty summary when no outcomes exist', async () => {
      mockOrderBy.mockResolvedValue([]);

      const summary = await getOutcomeSummary();

      expect(summary.total).toBe(0);
      expect(summary.success).toBe(0);
      expect(summary.downtime).toBe(0);
      expect(summary.rollback).toBe(0);
      expect(summary.avgDowntimeMinutes).toBe(0);
      expect(summary.byMonth).toEqual([]);
    });

    it('groups byMonth using deployedAt when set, falling back to reportedAt', async () => {
      // outcome 1: deployed Feb, reported Jun — should land in Feb
      // outcome 2: no deployedAt — falls back to reportedAt (Jun)
      const mixed: DeploymentOutcome[] = [
        {
          ...sampleOutcome,
          id: 'a',
          result: 'success',
          deployedAt: '2026-02-10T00:00:00Z',
          reportedAt: '2026-06-01T00:00:00Z',
        },
        {
          ...sampleOutcome,
          id: 'b',
          result: 'rollback',
          deployedAt: undefined,
          reportedAt: '2026-06-05T00:00:00Z',
        },
      ];

      mockOrderBy.mockResolvedValue(mixed);

      const summary = await getOutcomeSummary();

      expect(summary.byMonth).toEqual([
        { month: '2026-02', success: 1, downtime: 0, rollback: 0 },
        { month: '2026-06', success: 0, downtime: 0, rollback: 1 },
      ]);
    });
  });

  // ── getAllOutcomes with releaseVersions filter ────────────────────────────────

  describe('getAllOutcomes with releaseVersions filter', () => {
    it('applies inArray filter when releaseVersions array is provided', async () => {
      mockOrderBy.mockResolvedValue([sampleOutcome]);

      const result = await getAllOutcomes({ releaseVersions: ['2026.06.1', '2026.05.1'] });

      // where() must be called (inArray condition was built)
      expect(mockWhere).toHaveBeenCalled();
      expect(result).toEqual([sampleOutcome]);
    });

    it('falls back to eq filter when only releaseVersion (singular) is provided', async () => {
      mockOrderBy.mockResolvedValue([sampleOutcome]);

      const result = await getAllOutcomes({ releaseVersion: '2026.06.1' });

      expect(mockWhere).toHaveBeenCalled();
      expect(result).toEqual([sampleOutcome]);
    });

    it('ignores empty releaseVersions array and returns all outcomes', async () => {
      mockOrderBy.mockResolvedValue([sampleOutcome]);

      const result = await getAllOutcomes({ releaseVersions: [] });

      // empty array should NOT add an inArray filter — no where() call
      expect(mockWhere).not.toHaveBeenCalled();
      expect(result).toEqual([sampleOutcome]);
    });
  });

  // ── getDistinctReleaseVersions ────────────────────────────────────────────────

  describe('getDistinctReleaseVersions', () => {
    it('queries selectDistinct and returns version strings', async () => {
      mockOrderBy.mockResolvedValue([
        { releaseVersion: '2026.06.1' },
        { releaseVersion: '2026.05.1' },
      ]);

      const result = await getDistinctReleaseVersions();

      expect(mockSelectDistinct).toHaveBeenCalled();
      expect(mockDistinctFrom).toHaveBeenCalledWith(deploymentOutcomes);
      expect(result).toEqual(['2026.06.1', '2026.05.1']);
    });

    it('returns an empty array when no outcomes exist', async () => {
      mockOrderBy.mockResolvedValue([]);

      const result = await getDistinctReleaseVersions();

      expect(result).toEqual([]);
    });
  });
});
