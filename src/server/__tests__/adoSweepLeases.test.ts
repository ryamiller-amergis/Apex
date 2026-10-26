/**
 * The UAT auto-release and feature auto-complete sweeps run on every App
 * Service instance. A Postgres lease lets one instance poll Azure DevOps per
 * interval; manual triggers skip the lease.
 */

const mockWithRepoCacheLease = jest.fn();
const mockParseAutoCheckTeams = jest.fn();

class MockNonblockingError extends Error {}

jest.mock('../services/repoCacheLeaseService', () => ({
  NonblockingRepoCacheLeaseUnavailableError: MockNonblockingError,
  withRepoCacheLease: (...args: unknown[]) => mockWithRepoCacheLease(...args),
}));
jest.mock('../services/adoTeamConfig', () => ({
  parseAutoCheckTeams: (...args: unknown[]) => mockParseAutoCheckTeams(...args),
}));
jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn(),
}));

import { UatAutoReleaseService } from '../services/uatAutoReleaseService';
import { FeatureAutoCompleteService } from '../services/featureAutoComplete';

const cases = [
  {
    name: 'UatAutoReleaseService',
    create: () => new UatAutoReleaseService(),
    leaseKey: 'uat-auto-release:sweep',
    intervalMs: 5 * 60 * 1000,
  },
  {
    name: 'FeatureAutoCompleteService',
    create: () => new FeatureAutoCompleteService(),
    leaseKey: 'feature-auto-complete:sweep',
    intervalMs: 15 * 60 * 1000,
  },
];

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe.each(cases)('$name sweep lease', ({ create, leaseKey, intervalMs }) => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockParseAutoCheckTeams.mockReturnValue({ teams: [], skippedAreaPaths: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('claims a non-blocking lease that expires before the next interval', async () => {
    mockWithRepoCacheLease.mockImplementation(async (_key, operation) => operation({}));
    const service = create();

    service.start();
    await flush();
    service.stop();

    expect(mockWithRepoCacheLease).toHaveBeenCalledWith(
      leaseKey,
      expect.any(Function),
      { leaseMs: intervalMs - 5000, waitMs: 0, releaseOnComplete: false },
    );
    expect(mockParseAutoCheckTeams).toHaveBeenCalledTimes(1);
  });

  it('skips the sweep when another instance holds the lease', async () => {
    mockWithRepoCacheLease.mockRejectedValue(new MockNonblockingError(leaseKey));
    const service = create();

    service.start();
    await flush();
    service.stop();

    expect(mockParseAutoCheckTeams).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('logs and skips the sweep when the lease store fails', async () => {
    mockWithRepoCacheLease.mockRejectedValue(new Error('db down'));
    const service = create();

    service.start();
    await flush();
    service.stop();

    expect(mockParseAutoCheckTeams).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('runs a manual trigger without the lease', async () => {
    const service = create();

    await service.triggerCheck();

    expect(mockWithRepoCacheLease).not.toHaveBeenCalled();
    expect(mockParseAutoCheckTeams).toHaveBeenCalledTimes(1);
  });
});
