import type { ChatThread } from '../../shared/types/chat';

const isFeatureEnabled = jest.fn();
const isFlagEnabledForWholeProject = jest.fn();
const startCallerGrounding = jest.fn();
const readRemoteBranchTip = jest.fn();

jest.mock('../services/featureFlagService', () => ({
  ...jest.requireActual('../services/featureFlagService'),
  isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args),
  isFlagEnabledForWholeProject: (...args: unknown[]) =>
    isFlagEnabledForWholeProject(...args),
}));

jest.mock('../services/callerGroundingService', () => ({
  ...jest.requireActual('../services/callerGroundingService'),
  callerGroundingService: {
    start: (...args: unknown[]) => startCallerGrounding(...args),
  },
}));

jest.mock('../services/runGroundingService', () => ({
  ...jest.requireActual('../services/runGroundingService'),
  runGroundingService: {
    getGroundings: jest.fn().mockResolvedValue([]),
    findActiveByRepoBranch: jest.fn().mockResolvedValue([]),
    activateGroundings: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/groundingProfileResolver', () => ({
  ...jest.requireActual('../services/groundingProfileResolver'),
  groundingProfileResolver: {
    registerConnectionProfile: jest.fn(() => ({ id: 'profile-light' })),
    whenShared: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/repoCacheService', () => ({
  ...jest.requireActual('../services/repoCacheService'),
  readCachedOriginSha: jest.fn().mockResolvedValue(null),
  readRemoteBranchTip: (...args: unknown[]) => readRemoteBranchTip(...args),
}));

import { defaultResolveGrounding } from '../services/durableInteractiveTurnService';
import { runGroundingService } from '../services/runGroundingService';

const SHA = 'a'.repeat(40);

const thread = {
  id: 'thread-1',
  workspaceDir: '/tmp/thread-1',
  kickoff: { project: 'Apex', repo: 'Apex', branch: 'main' },
} as unknown as ChatThread;

describe('defaultResolveGrounding', () => {
  const originalUrl = process.env.REPO_READ_SERVICE_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REPO_READ_SERVICE_URL = 'http://repo-read.internal';
    readRemoteBranchTip.mockResolvedValue(SHA);
    startCallerGrounding.mockResolvedValue({
      mode: 'local',
      resolvedSha: 'b'.repeat(40),
      profileId: 'profile-checkout',
    });
  });

  afterAll(() => {
    if (originalUrl === undefined) delete process.env.REPO_READ_SERVICE_URL;
    else process.env.REPO_READ_SERVICE_URL = originalUrl;
  });

  it('pins the commit without an App Service checkout for whole-V2 projects that read through repo-read', async () => {
    isFlagEnabledForWholeProject.mockResolvedValue(true);
    isFeatureEnabled.mockResolvedValue(true);

    const grounding = await defaultResolveGrounding({ thread, userId: 'user-1' });

    expect(startCallerGrounding).not.toHaveBeenCalled();
    expect(grounding).toMatchObject({ sha: SHA, profileId: 'profile-light' });
    expect(runGroundingService.activateGroundings).toHaveBeenCalledTimes(1);
  });

  it('reuses the active pin on a later turn without saving it again', async () => {
    isFlagEnabledForWholeProject.mockResolvedValue(true);
    isFeatureEnabled.mockResolvedValue(true);
    const pinned = 'c'.repeat(40);
    jest.mocked(runGroundingService.getGroundings).mockResolvedValueOnce([
      { repoRole: 'target', isActive: true, groundedSha: pinned },
    ] as unknown as Awaited<ReturnType<typeof runGroundingService.getGroundings>>);

    const grounding = await defaultResolveGrounding({ thread, userId: 'user-1' });

    expect(grounding).toMatchObject({ sha: pinned });
    expect(runGroundingService.activateGroundings).not.toHaveBeenCalled();
    expect(readRemoteBranchTip).not.toHaveBeenCalled();
  });

  it('keeps the App Service checkout when repo-read is off for the project', async () => {
    isFlagEnabledForWholeProject.mockResolvedValue(true);
    isFeatureEnabled.mockResolvedValue(false);

    const grounding = await defaultResolveGrounding({ thread, userId: 'user-1' });

    expect(startCallerGrounding).toHaveBeenCalledTimes(1);
    expect(grounding).toMatchObject({ profileId: 'profile-checkout' });
  });

  it('keeps the App Service checkout when the repo-read service URL is not set', async () => {
    delete process.env.REPO_READ_SERVICE_URL;
    isFlagEnabledForWholeProject.mockResolvedValue(true);
    isFeatureEnabled.mockResolvedValue(true);

    await defaultResolveGrounding({ thread, userId: 'user-1' });

    expect(startCallerGrounding).toHaveBeenCalledTimes(1);
  });
});
