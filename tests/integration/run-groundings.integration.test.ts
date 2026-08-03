import './setup';
import { eq } from 'drizzle-orm';
import { db } from './setup';
import pool from '../../src/server/db';
import { runGroundings } from '../../src/server/db/schema';
import {
  RunGroundingRepositoryError,
  runGroundingRepository,
} from '../../src/server/services/runGroundingRepository';
import type {
  CreateRunGroundingInput,
  RunType,
} from '../../src/shared/types/runGrounding';

const TEST_PROJECT = 'RunGroundingIntegration';

function groundingInput(
  runType: RunType,
  runId: string,
  repoRole: 'target' | 'skill'
): CreateRunGroundingInput {
  return {
    runType,
    runId,
    project: TEST_PROJECT,
    repoRole,
    provider: 'github',
    repository: repoRole === 'target' ? 'ASM/AI-Pilot' : 'ASM/agent-skills',
    branch: 'main',
    groundedSha: `${runType}-${repoRole}-sha`,
    groundedAt: '2026-08-02T14:00:00.000Z',
  };
}

async function cleanup(): Promise<void> {
  await db.delete(runGroundings).where(eq(runGroundings.project, TEST_PROJECT));
}

describe('run_groundings PostgreSQL integration', () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => pool.end());

  it.each(['chat', 'one_shot', 'service'] as const)(
    'DoD-2 / AC-2 persists independent target and skill rows for %s runs',
    async (runType) => {
      const runId = `integration-${runType}`;
      await runGroundingRepository.activateGroundings([
        groundingInput(runType, runId, 'target'),
        groundingInput(runType, runId, 'skill'),
      ]);

      const rows = await runGroundingRepository.findByRun({
        runType,
        runId,
        project: TEST_PROJECT,
      });

      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ repoRole: 'target', isActive: true }),
          expect.objectContaining({ repoRole: 'skill', isActive: true }),
        ])
      );
    }
  );

  it('DoD-0 / BR-005 enforces one active row per role and retains re-ground history', async () => {
    const ref = {
      runType: 'chat' as const,
      runId: 'integration-unique-role',
      project: TEST_PROJECT,
    };
    await runGroundingRepository.createGrounding(
      groundingInput(ref.runType, ref.runId, 'target')
    );

    await expect(
      runGroundingRepository.createGrounding(
        groundingInput(ref.runType, ref.runId, 'target')
      )
    ).rejects.toMatchObject<Partial<RunGroundingRepositoryError>>({
      code: 'run_grounding_persistence_failed',
      operation: 'create',
    });

    await runGroundingRepository.reground(ref, 'target', 'replacement-sha');
    const rows = await runGroundingRepository.findByRun(ref);

    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.isActive)).toEqual([
      expect.objectContaining({ groundedSha: 'replacement-sha' }),
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groundedSha: 'chat-target-sha',
          isActive: false,
        }),
      ])
    );
  });
});
