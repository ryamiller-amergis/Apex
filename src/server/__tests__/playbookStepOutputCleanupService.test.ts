const referencedRows: Array<{
  stepRunId: string;
  reference: {
    schemaVersion: 1;
    container: 'playbook-step-outputs';
    key: string;
    sha256: string;
    sizeBytes: number;
    contentType: 'application/json';
  };
}> = [];

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => referencedRows,
      }),
    }),
  },
}));

import { reconcilePlaybookStepOutputs } from '../services/playbookStepOutputCleanupService';
import type { PlaybookStepOutputStore } from '../services/playbookStepOutputStore';

const reference = (key: string) => ({
  schemaVersion: 1 as const,
  container: 'playbook-step-outputs' as const,
  key,
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  contentType: 'application/json' as const,
});

function storeDouble(overrides: Partial<PlaybookStepOutputStore> = {}): PlaybookStepOutputStore {
  return {
    persist: jest.fn(),
    load: jest.fn(async (ref) => ({
      schemaVersion: 1 as const,
      project: 'Apex',
      runId: 'run-1',
      stepRunId: ref.key.includes('referenced') ? 'step-1' : 'other-step',
      stepId: 'draft',
      stepType: 'cursor-agent',
      completedAt: '2026-10-19T00:00:00.000Z',
      output: {},
    })),
    delete: jest.fn(async () => undefined),
    listKeys: jest.fn(async () => []),
    ...overrides,
  };
}

beforeEach(() => {
  referencedRows.length = 0;
});

describe('Playbook step-output reconciliation', () => {
  it('never deletes an object referenced by a retained step row', async () => {
    referencedRows.push({ stepRunId: 'step-1', reference: reference('referenced-output') });
    const store = storeDouble({
      listKeys: jest.fn(async () => [{ key: 'referenced-output', lastModifiedMs: 0 }]),
    });

    const result = await reconcilePlaybookStepOutputs({ store, now: 10_000_000 });

    expect(result.deletedOrphans).toEqual([]);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('deletes only unreferenced objects older than the grace period', async () => {
    const store = storeDouble({
      listKeys: jest.fn(async () => [
        { key: 'old-orphan', lastModifiedMs: 0 },
        { key: 'new-orphan', lastModifiedMs: 9_999_999 },
      ]),
    });

    const result = await reconcilePlaybookStepOutputs({ store, now: 10_000_000 });

    expect(result.deletedOrphans).toEqual(['old-orphan']);
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it('reports a retained reference whose object cannot be verified', async () => {
    referencedRows.push({ stepRunId: 'step-1', reference: reference('broken-output') });
    const store = storeDouble({
      load: jest.fn(async () => {
        throw new Error('checksum mismatch');
      }),
    });

    const result = await reconcilePlaybookStepOutputs({ store });

    expect(result.danglingReferences).toEqual([
      {
        stepRunId: 'step-1',
        key: 'broken-output',
        error: 'checksum mismatch',
      },
    ]);
  });
});
