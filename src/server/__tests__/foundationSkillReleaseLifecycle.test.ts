const mockSelectRows: unknown[][] = [];
const mockUpdateRows: unknown[][] = [];
const mockTxUpdateRows: unknown[][] = [];

function updateChain(queue: unknown[][]) {
  const chain: any = {
    set: jest.fn(),
    where: jest.fn(),
    returning: jest.fn(),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve([])),
  };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.returning.mockImplementation(async () => queue.shift() ?? []);
  return chain;
}

const mockTx = {
  update: jest.fn(() => updateChain(mockTxUpdateRows)),
  insert: jest.fn(() => ({
    values: jest.fn().mockResolvedValue(undefined),
  })),
  delete: jest.fn(() => updateChain(mockTxUpdateRows)),
};

const mockDb = {
  select: jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(async () => mockSelectRows.shift() ?? []),
    })),
  })),
  update: jest.fn(() => updateChain(mockUpdateRows)),
  insert: jest.fn(() => ({
    values: jest.fn().mockResolvedValue(undefined),
  })),
  transaction: jest.fn(async (callback: (tx: typeof mockTx) => unknown) =>
    callback(mockTx),
  ),
};

jest.mock('../db/drizzle', () => ({ db: mockDb }));
jest.mock('../services/azureArtifactsSkillService', () => ({
  isAzureArtifactsConfigured: jest.fn(() => true),
  verifyPackageArtifact: jest.fn(),
  promoteToReleaseView: jest.fn(),
  deprecatePackageVersion: jest.fn(),
}));

import {
  publishRelease,
  deleteDraftRelease,
} from '../services/foundationSkillReleaseService';
import {
  verifyPackageArtifact,
  promoteToReleaseView,
} from '../services/azureArtifactsSkillService';
import type { FoundationSkillArtifactManifest } from '../../shared/types/foundationSkills';

const mockVerify = verifyPackageArtifact as jest.Mock;
const mockPromote = promoteToReleaseView as jest.Mock;

const manifest: FoundationSkillArtifactManifest = {
  suiteVersion: '2.0.0',
  package: '@apex/skills',
  contractApiVersion: 1,
  skills: [
    {
      name: 'ui-lab',
      summary: 'UI.',
      tier: 'shippable',
      alwaysInstall: false,
      dependsOn: [],
    },
  ],
};

function row(status: 'draft' | 'publishing' | 'published' = 'draft') {
  return {
    id: 'release-1',
    version: '2.0.0',
    status,
    artifactPackage: '@apex/skills',
    artifactVersion: '2.0.0',
    artifactFeed: null,
    integritySha256: null,
    contractApiVersion: 1,
    selectedSkills: ['ui-lab'],
    targetProjects: [],
    skillTargets: {},
    manifestSnapshot: null,
    releaseNotes: null,
    breakingChanges: null,
    publishedBy: null,
    publishedAt: null,
    deprecatedBy: null,
    deprecatedAt: null,
    createdBy: 'admin',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectRows.length = 0;
  mockUpdateRows.length = 0;
  mockTxUpdateRows.length = 0;
});

describe('publishRelease', () => {
  it('persists server-verified manifest and integrity after promotion', async () => {
    mockSelectRows.push([row('draft')]);
    mockUpdateRows.push([row('publishing')]);
    mockTxUpdateRows.push([
      {
        ...row('published'),
        integritySha256: 'sha256',
        artifactFeed: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/',
        manifestSnapshot: manifest,
      },
    ]);
    mockVerify.mockResolvedValue({
      integritySha256: 'sha256',
      artifactFeed: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/',
      manifest,
    });
    mockPromote.mockResolvedValue(undefined);

    const result = await publishRelease('release-1', { id: 'admin' });

    expect(result.status).toBe('published');
    expect(result.integritySha256).toBe('sha256');
    expect(result.manifestSnapshot).toEqual(manifest);
    expect(mockPromote).toHaveBeenCalledWith('2.0.0');
  });

  it('returns the claim to draft when verification fails before promotion', async () => {
    mockSelectRows.push([row('draft')]);
    mockUpdateRows.push([row('publishing')], []);
    mockVerify.mockRejectedValue(new Error('artifact unavailable'));

    await expect(
      publishRelease('release-1', { id: 'admin' }),
    ).rejects.toThrow('artifact unavailable');
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockTx.update).toHaveBeenCalled();
  });

  it('rejects a concurrent publish when the draft claim is lost', async () => {
    mockSelectRows.push([row('draft')]);
    mockUpdateRows.push([]);

    await expect(
      publishRelease('release-1', { id: 'admin' }),
    ).rejects.toThrow(/changed while publication/i);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('reclaims a stale publishing release and finalizes it idempotently', async () => {
    mockSelectRows.push([
      {
        ...row('publishing'),
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
    ]);
    mockUpdateRows.push([row('publishing')]);
    mockTxUpdateRows.push([
      {
        ...row('published'),
        integritySha256: 'sha256',
        manifestSnapshot: manifest,
      },
    ]);
    mockVerify.mockResolvedValue({
      integritySha256: 'sha256',
      artifactFeed: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/',
      manifest,
    });
    mockPromote.mockResolvedValue(undefined);

    const result = await publishRelease('release-1', { id: 'admin' });

    expect(result.status).toBe('published');
  });

  it('keeps the reconciliation claim when DB finalization fails after promotion', async () => {
    mockSelectRows.push([row('draft')]);
    mockUpdateRows.push([row('publishing')]);
    mockTxUpdateRows.push([]);
    mockVerify.mockResolvedValue({
      integritySha256: 'sha256',
      artifactFeed: 'https://pkgs.dev.azure.com/org/_packaging/feed/npm/registry/',
      manifest,
    });
    mockPromote.mockResolvedValue(undefined);

    await expect(
      publishRelease('release-1', { id: 'admin' }),
    ).rejects.toThrow(/lost its publication claim/i);
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });
});

describe('deleteDraftRelease', () => {
  it('rejects deletion when the optimistic draft delete loses its race', async () => {
    mockSelectRows.push([row('draft')]);
    mockTxUpdateRows.push([]);

    await expect(
      deleteDraftRelease('release-1', { id: 'admin' }),
    ).rejects.toThrow(/changed while draft deletion/i);
  });
});
