import {
  PlaybookSpendCapExceededError,
  createPlaybookSpendPolicyService,
  type PlaybookSpendPolicyStore,
} from '../services/playbookSpendPolicyService';

const NOW = new Date('2026-09-22T16:00:00.000Z');

function createStore(): jest.Mocked<PlaybookSpendPolicyStore> {
  return {
    get: jest.fn(),
    create: jest.fn(),
    setWarningCrossing: jest.fn(),
    clearWarningCrossing: jest.fn(),
    update: jest.fn(),
    getDefaultNoHistoryCapUsd: jest.fn().mockResolvedValue('30.000000'),
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    project: 'Apex',
    enabled: true,
    baselineCostUsd: '10.000000',
    capUsd: '30.000000',
    warningActive: false,
    warningGeneration: 0,
    warningCrossedAt: null,
    warningRecipientUserIds: [],
    overrideByUserId: null,
    overrideToUsd: null,
    overrideAt: null,
    overrideReason: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('FEAT-015 playbook spend admission', () => {
  it('uses the exact trailing 30-day getSummary figure and enables at 3x baseline', async () => {
    const store = createStore();
    store.get.mockResolvedValue(null);
    store.create.mockImplementation(async (row) => policy(row));
    const getSummary = jest.fn().mockResolvedValue({ totalCostUsd: 10 });
    const service = createPlaybookSpendPolicyService({
      store,
      getSummary,
      listAdminUserIds: jest.fn(),
      notify: jest.fn(),
      now: () => NOW,
    });

    const result = await service.updatePolicy({
      project: 'Apex',
      actorUserId: 'admin-1',
      enabled: true,
      reason: 'Enable conservative project cap',
    });

    expect(getSummary).toHaveBeenCalledWith({
      project: 'Apex',
      from: '2026-08-24T00:00:00.000Z',
      to: '2026-09-22T23:59:59.999Z',
    });
    expect(result.baselineCostUsd).toBe('10.000000');
    expect(result.capUsd).toBe('30.000000');
  });

  it('uses the configuration-backed fallback when a project has no spend history', async () => {
    const store = createStore();
    store.get.mockResolvedValue(null);
    store.getDefaultNoHistoryCapUsd.mockResolvedValue('25.000000');
    store.create.mockImplementation(async (row) => policy(row));
    const service = createPlaybookSpendPolicyService({
      store,
      getSummary: jest.fn().mockResolvedValue({ totalCostUsd: 0 }),
      listAdminUserIds: jest.fn(),
      notify: jest.fn(),
      now: () => NOW,
    });

    const result = await service.updatePolicy({
      project: 'Apex',
      actorUserId: 'admin-1',
      enabled: true,
      reason: 'Enable conservative project cap',
    });

    expect(result.baselineCostUsd).toBe('0.000000');
    expect(result.capUsd).toBe('25.000000');
  });

  it('warns exactly once at the 75% boundary and rejects at the cap', async () => {
    const store = createStore();
    store.get.mockResolvedValue(policy());
    store.setWarningCrossing.mockResolvedValue(
      policy({
        warningActive: true,
        warningGeneration: 1,
        warningRecipientUserIds: ['admin-1'],
      })
    );
    const getSummary = jest
      .fn()
      .mockResolvedValueOnce({ totalCostUsd: 22.5 })
      .mockResolvedValueOnce({ totalCostUsd: 22.5 })
      .mockResolvedValueOnce({ totalCostUsd: 30 });
    const notify = jest.fn();
    const service = createPlaybookSpendPolicyService({
      store,
      getSummary,
      listAdminUserIds: jest.fn().mockResolvedValue(['admin-1']),
      notify,
      now: () => NOW,
    });

    await service.assertAdmission('Apex');
    store.get.mockResolvedValue(
      policy({
        warningActive: true,
        warningGeneration: 1,
        warningRecipientUserIds: ['admin-1'],
      })
    );
    await service.assertAdmission('Apex');

    expect(store.setWarningCrossing).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    await expect(service.assertAdmission('Apex')).rejects.toBeInstanceOf(
      PlaybookSpendCapExceededError
    );
  });

  it('persists override audit fields and notifies prior warning recipients', async () => {
    const store = createStore();
    store.get.mockResolvedValue(
      policy({
        warningActive: true,
        warningGeneration: 3,
        warningRecipientUserIds: ['admin-1'],
      })
    );
    store.update.mockImplementation(async (_project, changes) =>
      policy(changes)
    );
    const notify = jest.fn();
    const service = createPlaybookSpendPolicyService({
      store,
      getSummary: jest.fn().mockResolvedValue({ totalCostUsd: 30 }),
      listAdminUserIds: jest.fn(),
      notify,
      now: () => NOW,
    });

    await service.updatePolicy({
      project: 'Apex',
      actorUserId: 'admin-2',
      capUsd: '45',
      reason: 'Approved delivery spike for release',
    });

    expect(store.update).toHaveBeenCalledWith(
      'Apex',
      expect.objectContaining({
        capUsd: '45.000000',
        overrideByUserId: 'admin-2',
        overrideToUsd: '45.000000',
        overrideAt: NOW.toISOString(),
        overrideReason: 'Approved delivery spike for release',
      })
    );
    expect(notify).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({ kind: 'override', generation: 3 })
    );
  });
});
