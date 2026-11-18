import { sweepAbandonedBuildIntakes } from '../services/buildIntakeAbandonSweep';
import { db } from '../db/drizzle';
import { isFeatureEnabled, isFeatureOperational } from '../services/featureFlagService';
import { recordSkillSignal } from '../services/skillSignalService';

jest.mock('../db/drizzle', () => ({ db: { execute: jest.fn() } }));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn(), isFeatureOperational: jest.fn() }));
jest.mock('../services/skillSignalService', () => ({ recordSkillSignal: jest.fn() }));

describe('sweepAbandonedBuildIntakes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isFeatureOperational).mockResolvedValue(true);
    jest.mocked(recordSkillSignal).mockResolvedValue(true);
  });

  it('records one abandoned signal per stale intake in projects with the flag on', async () => {
    jest.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [{ project: 'Apex' }, { project: 'Off' }] } as never)
      .mockResolvedValueOnce({
        rows: [
          { interview_id: 'i1', project: 'Apex', author_id: 'u1', brief_id: 'b1', brief_version: 2, last_activity: '2026-10-01' },
          { interview_id: 'i2', project: 'Apex', author_id: 'u2', brief_id: null, brief_version: null, last_activity: '2026-10-02' },
        ],
      } as never);
    jest.mocked(isFeatureEnabled).mockImplementation(async (_key, ctx) => ctx?.project === 'Apex');

    await expect(sweepAbandonedBuildIntakes(Date.parse('2026-11-09'))).resolves.toBe(2);

    expect(recordSkillSignal).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'build_intake', kind: 'abandoned', subjectType: 'build_brief', subjectId: 'b1',
      idempotencyKey: 'abandoned:build_intake:i1',
    }));
    expect(recordSkillSignal).toHaveBeenCalledWith(expect.objectContaining({
      subjectType: 'build_intake', subjectId: 'i2', metadata: expect.objectContaining({ neverDrafted: true }),
    }));
  });

  it('does nothing when no project has the flag on', async () => {
    jest.mocked(db.execute).mockResolvedValueOnce({ rows: [{ project: 'Off' }] } as never);
    jest.mocked(isFeatureEnabled).mockResolvedValue(false);
    await expect(sweepAbandonedBuildIntakes()).resolves.toBe(0);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('skips the queries when the flag is off everywhere', async () => {
    jest.mocked(isFeatureOperational).mockResolvedValue(false);
    await expect(sweepAbandonedBuildIntakes()).resolves.toBe(0);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
