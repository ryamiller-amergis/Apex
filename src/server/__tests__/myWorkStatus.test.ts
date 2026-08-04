import type { ActiveDevSession, BacklogFeatureItem } from '../../shared/types/devWorkbench';
import {
  computeFeatureWorkStatus,
  formatMyWorkStatusLabel,
  rollupWorkStatus,
  type FeatureWorkStatus,
  type MyWorkStatus,
} from '../../shared/utils/myWorkStatus';

describe('computeFeatureWorkStatus', () => {
  const feature: Pick<BacklogFeatureItem, 'featureId' | 'prdId' | 'dependsOn' | 'readyAt'> = {
    featureId: 'FEAT-001',
    prdId: 'prd-1',
    dependsOn: [],
    readyAt: '2026-07-01T10:00:00.000Z',
  };

  it('returns Ready with readyAt when there is no session', () => {
    const result = computeFeatureWorkStatus(feature, []);
    expect(result).toMatchObject({
      state: 'ready',
      statusAt: '2026-07-01T10:00:00.000Z',
      hasCloudSession: false,
      hasPr: false,
    });
  });

  it('returns In Progress with session createdAt on Start Local / Start Development', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's1',
        workItemId: null,
        chatThreadId: null,
        branchName: null,
        status: 'in_progress',
        prUrl: null,
        createdAt: '2026-07-02T12:00:00.000Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    const result = computeFeatureWorkStatus(feature, sessions);
    expect(result).toMatchObject({
      state: 'in_progress',
      statusAt: '2026-07-02T12:00:00.000Z',
      sessionId: 's1',
      hasCloudSession: false,
    });
  });

  it('marks hasCloudSession when the active session has a chat thread', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's1',
        workItemId: null,
        chatThreadId: 'thread-1',
        branchName: 'feature/x',
        status: 'setting_up',
        prUrl: null,
        createdAt: '2026-07-02T12:00:00.000Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    expect(computeFeatureWorkStatus(feature, sessions).hasCloudSession).toBe(true);
  });

  it('treats In PR as In Progress', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's1',
        workItemId: null,
        chatThreadId: 'thread-1',
        branchName: 'feature/x',
        status: 'in_progress',
        prUrl: 'https://example.com/pr/1',
        createdAt: '2026-07-02T12:00:00.000Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    const result = computeFeatureWorkStatus(feature, sessions);
    expect(result.state).toBe('in_progress');
    expect(result.hasPr).toBe(true);
  });

  it('returns Complete with completed session timestamp', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's1',
        workItemId: null,
        chatThreadId: null,
        branchName: null,
        status: 'completed',
        prUrl: null,
        createdAt: '2026-07-03T08:00:00.000Z',
        updatedAt: '2026-07-03T08:00:00.000Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    expect(computeFeatureWorkStatus(feature, sessions)).toMatchObject({
      state: 'complete',
      statusAt: '2026-07-03T08:00:00.000Z',
    });
  });

  it('returns Ready after a closed session (not completed)', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's1',
        workItemId: null,
        chatThreadId: 'thread-1',
        branchName: 'feature/x',
        status: 'closed',
        prUrl: null,
        createdAt: '2026-07-02T12:00:00.000Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    expect(computeFeatureWorkStatus(feature, sessions).state).toBe('ready');
  });

  it('sets blockedBy when a dependency is not complete, without changing Ready status', () => {
    const blockedFeature = { ...feature, dependsOn: ['FEAT-000'] };
    const result = computeFeatureWorkStatus(blockedFeature, [], []);
    expect(result.state).toBe('ready');
    expect(result.blockedBy).toBe('FEAT-000');
  });

  it('does not satisfy a dependency from a different PRD with the same feature id', () => {
    const blockedFeature = { ...feature, featureId: 'FEAT-002', dependsOn: ['FEAT-001'] };
    const otherPrdCompletion: ActiveDevSession = {
      id: 'other-prd-session',
      workItemId: null,
      chatThreadId: null,
      branchName: null,
      status: 'completed',
      prUrl: null,
      createdAt: '2026-07-03T08:00:00.000Z',
      prdId: 'prd-2',
      featureId: 'FEAT-001',
    };

    expect(
      computeFeatureWorkStatus(blockedFeature, [], [otherPrdCompletion]),
    ).toMatchObject({
      state: 'ready',
      blockedBy: 'FEAT-001',
    });
  });

  it('prefers completed over an older active session for the same feature', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's-active',
        workItemId: null,
        chatThreadId: 'thread-1',
        branchName: 'feature/x',
        status: 'in_progress',
        prUrl: null,
        createdAt: '2026-07-02T12:00:00.000Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
      {
        id: 's-done',
        workItemId: null,
        chatThreadId: null,
        branchName: null,
        status: 'completed',
        prUrl: null,
        createdAt: '2026-07-04T12:00:00.000Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    expect(computeFeatureWorkStatus(feature, sessions).state).toBe('complete');
  });

  it('prefers a cloud session over a local synthetic in_progress session', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's-local',
        workItemId: null,
        chatThreadId: null,
        branchName: null,
        status: 'in_progress',
        prUrl: null,
        createdAt: '2026-07-02T10:00:00.000Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
      {
        id: 's-cloud',
        workItemId: null,
        chatThreadId: 'thread-1',
        branchName: 'feature/x',
        status: 'in_progress',
        prUrl: null,
        createdAt: '2026-07-02T12:00:00.000Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    expect(computeFeatureWorkStatus(feature, sessions)).toMatchObject({
      state: 'in_progress',
      sessionId: 's-cloud',
      hasCloudSession: true,
    });
  });
});

describe('rollupWorkStatus', () => {
  const child = (state: MyWorkStatus, statusAt: string | null): Pick<FeatureWorkStatus, 'state' | 'statusAt'> => ({
    state,
    statusAt,
  });

  it('returns Ready when all children are Ready (earliest readyAt)', () => {
    const result = rollupWorkStatus([
      child('ready', '2026-07-01T10:00:00.000Z'),
      child('ready', '2026-07-01T09:00:00.000Z'),
    ]);
    expect(result).toEqual({ state: 'ready', statusAt: '2026-07-01T09:00:00.000Z' });
  });

  it('returns Complete when all children are Complete (latest completeAt)', () => {
    const result = rollupWorkStatus([
      child('complete', '2026-07-03T10:00:00.000Z'),
      child('complete', '2026-07-04T10:00:00.000Z'),
    ]);
    expect(result).toEqual({ state: 'complete', statusAt: '2026-07-04T10:00:00.000Z' });
  });

  it('returns In Progress when any child is In Progress (earliest in-progress At)', () => {
    const result = rollupWorkStatus([
      child('ready', '2026-07-01T10:00:00.000Z'),
      child('in_progress', '2026-07-02T15:00:00.000Z'),
      child('complete', '2026-07-03T10:00:00.000Z'),
    ]);
    expect(result).toEqual({ state: 'in_progress', statusAt: '2026-07-02T15:00:00.000Z' });
  });

  it('returns In Progress for Ready + Complete mix with no In Progress child', () => {
    const result = rollupWorkStatus([
      child('ready', '2026-07-01T10:00:00.000Z'),
      child('complete', '2026-07-03T08:00:00.000Z'),
    ]);
    expect(result).toEqual({ state: 'in_progress', statusAt: '2026-07-03T08:00:00.000Z' });
  });

  it('returns Ready with null timestamp for an empty child list', () => {
    expect(rollupWorkStatus([])).toEqual({ state: 'ready', statusAt: null });
  });
});

describe('formatMyWorkStatusLabel', () => {
  it('formats labels', () => {
    expect(formatMyWorkStatusLabel('ready')).toBe('Ready');
    expect(formatMyWorkStatusLabel('in_progress')).toBe('In Progress');
    expect(formatMyWorkStatusLabel('complete')).toBe('Complete');
  });
});
