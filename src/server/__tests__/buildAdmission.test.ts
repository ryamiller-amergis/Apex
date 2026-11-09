import { BUILD_CONCURRENCY_LIMITS } from '../../shared/types/build';
import {
  decideAdmission,
  promoteQueuedBuilds,
  type PromotionIo,
  type QueuedBuild,
} from '../services/buildOrchestrator/admission';

function queued(id: string, project: string, queuedAt: string): QueuedBuild {
  return {
    id,
    project,
    repository: 'apex',
    requestedByUserId: 'user-1',
    prompt: 'ship it',
    skillSettingsId: 'settings-1',
    queuedAt,
  };
}

describe('decideAdmission (VT-05)', () => {
  it('queues at position 1 with project_limit when the project holds 3 slots', () => {
    expect(decideAdmission({ projectSlots: 3, platformSlots: 3, olderQueued: 0 })).toEqual({
      status: 'queued',
      queueReason: 'project_limit',
      queuePosition: 1,
    });
  });

  it('queues with platform_limit when the platform holds 10 and the project has room', () => {
    expect(decideAdmission({
      projectSlots: 0,
      platformSlots: BUILD_CONCURRENCY_LIMITS.platform,
      olderQueued: 0,
    }).queueReason).toBe('platform_limit');
  });

  it('admits intake when both caps have room and nobody is waiting', () => {
    expect(decideAdmission({ projectSlots: 2, platformSlots: 9, olderQueued: 0 }).status).toBe('intake');
  });
});

describe('promoteQueuedBuilds (VT-13, VT-14)', () => {
  const open = async () => ({ flagOn: true, allowed: true, hasRunPermission: true });

  it('promotes the oldest queued build once, then changes nothing while the caps stay full', async () => {
    const rows = [
      queued('a-old', 'A', '2026-10-26T00:00:00.000Z'),
      queued('a-new', 'A', '2026-10-26T00:01:00.000Z'),
      queued('b', 'B', '2026-10-26T00:02:00.000Z'),
    ];
    const launched: string[] = [];
    const first = await promoteQueuedBuilds(memoryIo(rows, new Map([['A', 2], ['B', 0]]), 9, launched, open));
    expect(first).toEqual(['a-old']);
    const second = await promoteQueuedBuilds(memoryIo(
      rows,
      new Map([['A', 3], ['B', 0]]),
      10,
      launched,
      open,
    ));
    expect(second).toEqual([]);
    const third = await promoteQueuedBuilds(memoryIo(rows, new Map([['A', 3], ['B', 0]]), 9, launched, open));
    expect(third).toEqual(['b']);
  });

  it('leaves a build queued when the flag is off and suspends it when permission is gone', async () => {
    const rows = [queued('q', 'A', '2026-10-26T00:00:00.000Z')];
    const suspended: string[] = [];
    const off = memoryIo(rows, new Map([['A', 0]]), 0, [], async () => ({
      flagOn: false,
      allowed: true,
      hasRunPermission: true,
    }), suspended);
    expect(await promoteQueuedBuilds(off)).toEqual([]);
    expect(suspended).toEqual([]);
    expect(rows).toHaveLength(1);

    const revoked = memoryIo(rows, new Map([['A', 0]]), 0, [], async () => ({
      flagOn: true,
      allowed: true,
      hasRunPermission: false,
    }), suspended);
    await promoteQueuedBuilds(revoked);
    expect(suspended).toEqual(['q:permission_revoked']);
  });
});

function memoryIo(
  rows: QueuedBuild[],
  projectSlots: Map<string, number>,
  platform: number,
  launched: string[],
  checks: (build: QueuedBuild) => Promise<{ flagOn: boolean; allowed: boolean; hasRunPermission: boolean }>,
  suspended: string[] = [],
): PromotionIo {
  return {
    async transaction(fn) {
      const tx = {
        lock: async () => undefined,
        listQueued: async () => [...rows],
        projectSlots: async (project: string) => projectSlots.get(project) ?? 0,
        platformSlots: async () => platform,
        checks,
        markIntake: async (id: string) => {
          const index = rows.findIndex((row) => row.id === id);
          if (index < 0) return false;
          rows.splice(index, 1);
          return true;
        },
        suspend: async (id: string, reason: string) => {
          suspended.push(`${id}:${reason}`);
          const index = rows.findIndex((row) => row.id === id);
          if (index >= 0) rows.splice(index, 1);
        },
      };
      return fn(tx);
    },
    launch: async (build) => {
      launched.push(build.id);
    },
  };
}
