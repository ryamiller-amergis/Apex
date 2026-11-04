/**
 * S3 — Preview lease and queue manager tests (TBI-024 DoD-0..3, PBI-027 AC-0..3 / VT-01..VT-06).
 */
import {
  createPreviewLeaseService,
  type PreviewLeaseStore,
} from '../services/buildPreviewLeaseService';

interface MemoryLease {
  project: string;
  repository: string;
  buildRunId: string;
  buildRevisionId: string;
  grantedAtMs: number;
  expiresAtMs: number;
}

interface MemoryQueuedRevision {
  revisionId: string;
  buildRunId: string;
  project: string;
  repository: string;
  deploymentStatus: 'queued' | 'deploying' | 'succeeded' | 'failed' | 'not_started';
  runStatus: string;
  queuedAtMs: number;
}

function createMemoryLeaseStore(initialNowMs = 1_000_000): {
  store: PreviewLeaseStore;
  leases: Map<string, MemoryLease>;
  revisions: MemoryQueuedRevision[];
  events: Array<{ buildRunId: string; eventType: string; detail?: Record<string, unknown> }>;
  setNow: (ms: number) => void;
} {
  let nowMs = initialNowMs;
  const leases = new Map<string, MemoryLease>();
  const revisions: MemoryQueuedRevision[] = [];
  const events: Array<{ buildRunId: string; eventType: string; detail?: Record<string, unknown> }> = [];

  const pairKey = (project: string, repo: string) => `${project}::${repo}`;

  const store: PreviewLeaseStore = {
    now: () => new Date(nowMs),
    async tryUpsertLease({ project, repository, buildRunId, buildRevisionId, grantedAt, expiresAt }) {
      const key = pairKey(project, repository);
      const existing = leases.get(key);
      const gMs = new Date(grantedAt).getTime();
      const eMs = new Date(expiresAt).getTime();
      if (!existing || existing.expiresAtMs <= gMs || existing.buildRunId === buildRunId) {
        const next: MemoryLease = {
          project,
          repository,
          buildRunId,
          buildRevisionId,
          grantedAtMs: gMs,
          expiresAtMs: eMs,
        };
        leases.set(key, next);
        return {
          project,
          repository,
          buildRunId,
          buildRevisionId,
          grantedAt: new Date(gMs).toISOString(),
          expiresAt: new Date(eMs).toISOString(),
        };
      }
      return null;
    },
    async deleteLeaseByRun(buildRunId) {
      for (const [k, v] of leases.entries()) {
        if (v.buildRunId === buildRunId) {
          leases.delete(k);
          return { project: v.project, repository: v.repository, buildRevisionId: v.buildRevisionId };
        }
      }
      return null;
    },
    async deleteExpiredLeases(nowIso) {
      const cutoff = new Date(nowIso).getTime();
      const freed: Array<{
        project: string;
        repository: string;
        buildRunId: string;
        buildRevisionId: string;
      }> = [];
      for (const [k, v] of leases.entries()) {
        if (v.expiresAtMs <= cutoff) {
          leases.delete(k);
          freed.push({
            project: v.project,
            repository: v.repository,
            buildRunId: v.buildRunId,
            buildRevisionId: v.buildRevisionId,
          });
        }
      }
      return freed;
    },
    async updateLeaseExpiry(buildRunId, expiresAt) {
      for (const v of leases.values()) {
        if (v.buildRunId === buildRunId) {
          v.expiresAtMs = new Date(expiresAt).getTime();
          return true;
        }
      }
      return false;
    },
    async getLeaseForPair(project, repository) {
      const v = leases.get(pairKey(project, repository));
      if (!v) return null;
      return {
        project: v.project,
        repository: v.repository,
        buildRunId: v.buildRunId,
        buildRevisionId: v.buildRevisionId,
        grantedAt: new Date(v.grantedAtMs).toISOString(),
        expiresAt: new Date(v.expiresAtMs).toISOString(),
      };
    },
    async listWaitingRevisions(project, repository) {
      return revisions
        .filter(
          (r) =>
            r.project === project
            && r.repository === repository
            && r.deploymentStatus === 'queued'
            && r.runStatus === 'deploying',
        )
        .sort((a, b) => a.queuedAtMs - b.queuedAtMs || a.revisionId.localeCompare(b.revisionId))
        .map((r) => ({
          revisionId: r.revisionId,
          buildRunId: r.buildRunId,
          project: r.project,
          repository: r.repository,
          queuedAt: new Date(r.queuedAtMs).toISOString(),
        }));
    },
    async findRevisionPair(revisionId) {
      const r = revisions.find((item) => item.revisionId === revisionId);
      if (!r) return null;
      return {
        revisionId: r.revisionId,
        buildRunId: r.buildRunId,
        project: r.project,
        repository: r.repository,
        deploymentStatus: r.deploymentStatus,
        runStatus: r.runStatus,
      };
    },
    async appendEvent(ev) {
      events.push(ev);
    },
  };

  return {
    store,
    leases,
    revisions,
    events,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

describe('buildPreviewLeaseService (TBI-024 DoD-0..3, PBI-027 AC-0..3 / VT-01..VT-06)', () => {
  it('VT-01 TBI-024 DoD-0 / PBI-027 AC-3 grants the lease to exactly one holder across 10 concurrent requests', async () => {
    const { store, leases } = createMemoryLeaseStore();
    const service = createPreviewLeaseService(store);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        service.tryGrantLease({
          project: 'Apex',
          repository: 'apex-repo',
          buildRunId: `run-${idx}`,
          buildRevisionId: `rev-${idx}`,
        }),
      ),
    );

    const winners = results.filter((r) => r.granted);
    expect(winners).toHaveLength(1);
    expect(leases.size).toBe(1);
    expect(leases.get('Apex::apex-repo')?.buildRunId).toBe(winners[0].lease?.buildRunId);
  });

  it('VT-02 TBI-024 DoD-2 / PBI-027 AC-0 orders waiting revisions first-come-first-served with tie-break on revisionId', async () => {
    const { store, revisions } = createMemoryLeaseStore();
    const service = createPreviewLeaseService(store);

    revisions.push(
      {
        revisionId: 'rev-b',
        buildRunId: 'run-2',
        project: 'Apex',
        repository: 'apex-repo',
        deploymentStatus: 'queued',
        runStatus: 'deploying',
        queuedAtMs: 2000,
      },
      {
        revisionId: 'rev-a',
        buildRunId: 'run-1',
        project: 'Apex',
        repository: 'apex-repo',
        deploymentStatus: 'queued',
        runStatus: 'deploying',
        queuedAtMs: 1000,
      },
      {
        revisionId: 'rev-c',
        buildRunId: 'run-3',
        project: 'Apex',
        repository: 'apex-repo',
        deploymentStatus: 'queued',
        runStatus: 'deploying',
        queuedAtMs: 2000,
      },
    );

    const first = await service.claimNextWaitingLease('Apex', 'apex-repo');
    expect(first?.buildRevisionId).toBe('rev-a');
    revisions.find((r) => r.revisionId === 'rev-a')!.deploymentStatus = 'deploying';

    await service.releaseLease({ buildRunId: 'run-1', reason: 'cancel' });
    const second = await service.claimNextWaitingLease('Apex', 'apex-repo');
    expect(second?.buildRevisionId).toBe('rev-b');
  });

  it('VT-03 TBI-024 DoD-1 / PBI-027 AC-1 releases lease for accept, cancel, failure, expiry and is idempotent on repeat', async () => {
    const { store, events } = createMemoryLeaseStore();
    const service = createPreviewLeaseService(store);

    for (const reason of ['accept', 'cancel', 'failure', 'expiry'] as const) {
      await service.tryGrantLease({
        project: 'Apex',
        repository: 'apex-repo',
        buildRunId: `run-${reason}`,
        buildRevisionId: `rev-${reason}`,
      });

      const first = await service.releaseLease({ buildRunId: `run-${reason}`, reason });
      const second = await service.releaseLease({ buildRunId: `run-${reason}`, reason });

      expect(first.released).toBe(true);
      expect(second.released).toBe(false);
    }

    const releaseEvents = events.filter((e) => e.eventType === 'lease_released');
    expect(releaseEvents).toHaveLength(4);
    expect(releaseEvents.map((e) => e.detail?.reason)).toEqual([
      'accept',
      'cancel',
      'failure',
      'expiry',
    ]);
  });

  it('VT-04 TBI-024 DoD-1 / PBI-027 AC-2 expires leases with expires_at <= now (inclusive boundary) and leaves future leases intact', async () => {
    const { store, leases, setNow } = createMemoryLeaseStore(10_000);
    const service = createPreviewLeaseService(store);

    leases.set('Apex::repo-a', {
      project: 'Apex',
      repository: 'repo-a',
      buildRunId: 'run-a',
      buildRevisionId: 'rev-a',
      grantedAtMs: 1_000,
      expiresAtMs: 9_000, // now - 1s
    });
    leases.set('Apex::repo-b', {
      project: 'Apex',
      repository: 'repo-b',
      buildRunId: 'run-b',
      buildRevisionId: 'rev-b',
      grantedAtMs: 1_000,
      expiresAtMs: 11_000, // now + 1s
    });
    leases.set('Apex::repo-c', {
      project: 'Apex',
      repository: 'repo-c',
      buildRunId: 'run-c',
      buildRevisionId: 'rev-c',
      grantedAtMs: 1_000,
      expiresAtMs: 10_000, // === now (inclusive)
    });

    setNow(10_000);
    const freed = await service.expireLeases();

    expect(freed.map((f) => f.repository).sort()).toEqual(['repo-a', 'repo-c']);
    expect(leases.has('Apex::repo-a')).toBe(false);
    expect(leases.has('Apex::repo-c')).toBe(false);
    expect(leases.has('Apex::repo-b')).toBe(true);
  });

  it('VT-05 TBI-024 DoD-3 / PBI-027 AC-0 computes 1-based queue position per pair excluding the lease holder', async () => {
    const { store, revisions } = createMemoryLeaseStore();
    const service = createPreviewLeaseService(store);

    await service.tryGrantLease({
      project: 'Apex',
      repository: 'repo-p',
      buildRunId: 'run-holder',
      buildRevisionId: 'rev-holder',
    });

    revisions.push(
      {
        revisionId: 'rev-holder',
        buildRunId: 'run-holder',
        project: 'Apex',
        repository: 'repo-p',
        deploymentStatus: 'deploying',
        runStatus: 'deploying',
        queuedAtMs: 500,
      },
      {
        revisionId: 'rev-p1',
        buildRunId: 'run-p1',
        project: 'Apex',
        repository: 'repo-p',
        deploymentStatus: 'queued',
        runStatus: 'deploying',
        queuedAtMs: 1000,
      },
      {
        revisionId: 'rev-p2',
        buildRunId: 'run-p2',
        project: 'Apex',
        repository: 'repo-p',
        deploymentStatus: 'queued',
        runStatus: 'deploying',
        queuedAtMs: 2000,
      },
      {
        revisionId: 'rev-p3',
        buildRunId: 'run-p3',
        project: 'Apex',
        repository: 'repo-p',
        deploymentStatus: 'queued',
        runStatus: 'deploying',
        queuedAtMs: 3000,
      },
      {
        revisionId: 'rev-q1',
        buildRunId: 'run-q1',
        project: 'Apex',
        repository: 'repo-q',
        deploymentStatus: 'queued',
        runStatus: 'deploying',
        queuedAtMs: 1500,
      },
    );

    expect(await service.getQueuePosition('rev-holder')).toBeNull();
    expect(await service.getQueuePosition('rev-p1')).toBe(1);
    expect(await service.getQueuePosition('rev-p2')).toBe(2);
    expect(await service.getQueuePosition('rev-p3')).toBe(3);
    expect(await service.getQueuePosition('rev-q1')).toBe(1);
  });

  it('VT-06 TBI-024 re-grants the lease to the same run on revision 2 and refreshes expires_at', async () => {
    const { store, leases, setNow } = createMemoryLeaseStore(1_000);
    const service = createPreviewLeaseService(store);

    const first = await service.tryGrantLease({
      project: 'Apex',
      repository: 'apex-repo',
      buildRunId: 'run-r',
      buildRevisionId: 'rev-1',
    });
    expect(first.granted).toBe(true);
    const firstExpiry = first.lease!.expiresAt;

    setNow(50_000);
    const second = await service.tryGrantLease({
      project: 'Apex',
      repository: 'apex-repo',
      buildRunId: 'run-r',
      buildRevisionId: 'rev-2',
    });

    expect(second.granted).toBe(true);
    expect(second.lease?.buildRevisionId).toBe('rev-2');
    expect(new Date(second.lease!.expiresAt).getTime()).toBeGreaterThan(
      new Date(firstExpiry).getTime(),
    );
    expect(leases.size).toBe(1);
  });
});
