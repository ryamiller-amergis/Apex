/**
 * @jest-environment node
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RepoReader, RepositoryIdentity } from '../../shared/types/repoReader';
import {
  GroundingProfileResolver,
  type RunProjectAuthorization,
} from '../services/groundingProfileResolver';
import { LocalCheckoutReader } from '../services/localCheckoutReader';
import { RemoteCatalogReader } from '../services/remoteCatalogReader';
import { RepoReaderError } from '../services/repoReader';
import * as adoCatalog from '../services/skillCatalog';
import * as skillCatalogFacade from '../services/skillCatalogFacade';
import * as githubCatalog from '../services/skillCatalogGitHub';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeFixture(): { root: string; sha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-repo-reader-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const needle = true;\n');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Apex Test']);
  git(root, ['config', 'user.email', 'apex-test@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']) };
}

function identity(
  provider: RepositoryIdentity['provider'],
  sha: string,
): RepositoryIdentity {
  return {
    provider,
    project: provider === 'github' ? 'acme' : 'Apex',
    repo: 'reader-fixture',
    sha,
  };
}

async function exerciseContract(reader: RepoReader) {
  const content = await reader.readFile('README.md');
  const entries = await reader.listDir('src');
  const matches = await reader.searchCode('needle');
  return { content, entries, matches };
}

describe('TBI-001 DoD-0 exposes one contract for read, list, and search', () => {
  it('reads files, bounds directories, searches code, and returns correct empty outcomes', async () => {
    // Arrange
    const fixture = makeFixture();
    const reader: RepoReader = new LocalCheckoutReader({
      identity: identity('ado', fixture.sha),
      checkoutPath: fixture.root,
    });

    try {
      const crowded = path.join(fixture.root, 'crowded');
      fs.mkdirSync(crowded);
      for (let index = 0; index < 1_001; index += 1) {
        fs.writeFileSync(path.join(crowded, `${String(index).padStart(4, '0')}.txt`), '');
      }

      // Act
      const result = await exerciseContract(reader);
      const emptyContent = await reader.readFile('empty.txt');
      const boundedEntries = await reader.listDir('crowded');
      const noMatches = await reader.searchCode('definitely-not-present');

      // Assert
      expect(result.content).toBe('fixture\n');
      expect(result.entries).toEqual([
        { path: '/src/index.ts', name: 'index.ts', isFolder: false },
      ]);
      expect(result.matches).toEqual([
        {
          path: '/src/index.ts',
          fileName: 'index.ts',
          repository: 'reader-fixture',
          project: 'Apex',
          branch: fixture.sha,
          matches: [{ lineNumber: 1, snippet: 'export const needle = true;' }],
        },
      ]);
      expect(emptyContent).toBe('');
      expect(boundedEntries).toHaveLength(1_000);
      expect(noMatches).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('TBI-008 DoD-0 measures read, list, and search without leaking checkout paths', async () => {
    // Arrange
    const fixture = makeFixture();
    const telemetry = jest.fn();
    const reader = new LocalCheckoutReader({
      identity: identity('ado', fixture.sha),
      checkoutPath: fixture.root,
      telemetryContext: {
        caller: 'interview',
        project: 'Apex',
        runId: 'thread-1',
      },
      telemetry,
      now: jest
        .fn()
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(1_018)
        .mockReturnValueOnce(2_000)
        .mockReturnValueOnce(2_025)
        .mockReturnValueOnce(3_000)
        .mockReturnValueOnce(3_040),
    });

    try {
      // Act
      await reader.readFile('README.md');
      await reader.listDir('src');
      await reader.searchCode('needle');

      // Assert
      expect(telemetry.mock.calls).toEqual([
        [
          'grounding.read.latency',
          { caller: 'interview', project: 'Apex', runId: 'thread-1' },
          { durationMs: 18 },
        ],
        [
          'grounding.read.latency',
          { caller: 'interview', project: 'Apex', runId: 'thread-1' },
          { durationMs: 25 },
        ],
        [
          'grounding.read.latency',
          { caller: 'interview', project: 'Apex', runId: 'thread-1' },
          { durationMs: 40 },
        ],
      ]);
      expect(JSON.stringify(telemetry.mock.calls)).not.toContain(fixture.root);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('TBI-001 DoD-1 rejects traversal, symlink escape, expiry, and cross-run access safely', () => {
  it('denies unsafe paths without leaking checkout paths or outside content', async () => {
    // Arrange
    const fixture = makeFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-repo-outside-'));
    const secretContent = 'outside-secret';
    fs.writeFileSync(path.join(outside, 'secret.txt'), secretContent);
    fs.symlinkSync(outside, path.join(fixture.root, 'escape-link'), 'junction');
    const reader = new LocalCheckoutReader({
      identity: identity('ado', fixture.sha),
      checkoutPath: fixture.root,
    });

    try {
      // Act
      const attempts = [
        reader.readFile('../secret.txt'),
        reader.readFile(path.join(outside, 'secret.txt')),
        reader.readFile('escape-link/secret.txt'),
      ];

      // Assert
      for (const attempt of attempts) {
        await expect(attempt).rejects.toMatchObject({
          name: 'RepoReaderError',
          code: 'ACCESS_DENIED',
          fallbackEligible: false,
        });
        await expect(attempt).rejects.not.toThrow(fixture.root);
        await expect(attempt).rejects.not.toThrow(outside);
        await expect(attempt).rejects.not.toThrow(secretContent);
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns sanitized fallback-eligible failures for unreadable checkouts', async () => {
    // Arrange
    const missingCheckout = path.join(os.tmpdir(), 'missing-sensitive-checkout');
    const reader = new LocalCheckoutReader({
      identity: identity('ado', 'abc123'),
      checkoutPath: missingCheckout,
    });

    // Act
    const operation = reader.readFile('README.md');

    // Assert
    await expect(operation).rejects.toMatchObject({
      name: 'RepoReaderError',
      code: 'LOCAL_READ_UNAVAILABLE',
      fallbackEligible: true,
    });
    await expect(operation).rejects.not.toThrow(missingCheckout);
  });

  it('rejects expired and cross-run profiles, then selects readers only after authorization', async () => {
    // Arrange
    const fixture = makeFixture();
    const calls: string[] = [];
    let now = 1_000;
    const authorization: RunProjectAuthorization = {
      authorize: jest.fn(async () => {
        calls.push('authorize');
        return true;
      }),
    };
    const resolver = new GroundingProfileResolver({
      authorization,
      now: () => now,
      isFeatureEnabled: async () => {
        calls.push('flag');
        return true;
      },
    });
    const profile = resolver.registerProfile({
      runRef: 'interview:run-1',
      ...identity('ado', fixture.sha),
      checkoutPath: fixture.root,
      ttlMs: 100,
    });

    try {
      // Act / Assert: cross-run
      await expect(resolver.resolveProfile(profile.id, {
        userId: 'user-1',
        runRef: 'interview:run-2',
        project: 'Apex',
      })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
      expect(calls).toEqual([]);

      // Act / Assert: authorized local selection and authorization ordering
      const local = await resolver.resolveProfile(profile.id, {
        userId: 'user-1',
        runRef: 'interview:run-1',
        project: 'Apex',
      });
      expect(local).toBeInstanceOf(LocalCheckoutReader);
      expect(calls).toEqual(['authorize', 'flag']);

      // Act / Assert: expiry
      now = 1_101;
      await expect(resolver.resolveProfile(profile.id, {
        userId: 'user-1',
        runRef: 'interview:run-1',
        project: 'Apex',
      })).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' });
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('returns the remote reader when the feature flag is disabled', async () => {
    // Arrange
    const resolver = new GroundingProfileResolver({
      authorization: { authorize: async () => true },
      isFeatureEnabled: async () => false,
    });
    const profile = resolver.registerProfile({
      runRef: 'adr:run-1',
      ...identity('github', 'abc123'),
      checkoutPath: 'not-used-while-disabled',
    });

    // Act
    const reader = await resolver.resolveProfile(profile.id, {
      userId: 'user-1',
      runRef: 'adr:run-1',
      project: 'acme',
    });

    // Assert
    expect(reader).toBeInstanceOf(RemoteCatalogReader);
  });

  it('TBI-008 preserves the originating caller for convergence targeting', async () => {
    // Arrange
    const isConvergenceEnabled = jest.fn().mockResolvedValue(true);
    const resolver = new GroundingProfileResolver({
      authorization: { authorize: async () => true },
      isFeatureEnabled: async () => false,
      isRemoteSearchConvergenceEnabled: isConvergenceEnabled,
    });
    const profile = resolver.registerProfile({
      runRef: 'chat:interview-thread',
      caller: 'interview',
      ...identity('github', 'abc123'),
      checkoutPath: 'not-used-while-disabled',
    });
    const reader = await resolver.resolveProfile(profile.id, {
      userId: 'user-1',
      runRef: 'chat:interview-thread',
      project: 'acme',
    });

    // Act
    const search = reader.searchCode('needle');

    // Assert
    await expect(search).rejects.toMatchObject({
      code: 'REMOTE_SEARCH_DISABLED',
    });
    expect(isConvergenceEnabled).toHaveBeenCalledWith({
      userId: 'user-1',
      project: 'acme',
      caller: 'interview',
    });
  });
});

describe('TBI-001 DoD-2 preserves remote catalog fallback shapes', () => {
  it.each([
    {
      provider: 'ado' as const,
      searchResult: [{
        path: '/src/a.ts',
        fileName: 'a.ts',
        repository: 'repo',
        project: 'project',
        branch: 'main',
        matches: [{ lineNumber: 2, snippet: 'needle' }],
      }],
    },
    {
      provider: 'github' as const,
      searchResult: [{
        path: '/src/a.ts',
        url: 'https://github.example/src/a.ts',
        matches: [{ fragment: 'needle' }],
      }],
    },
  ])('preserves $provider read, list, and search results byte-for-byte', async ({
    provider,
    searchResult,
  }) => {
    // Arrange
    const catalog = {
      getSkillFile: jest.fn().mockResolvedValue('remote-content'),
      listRepoDir: jest.fn().mockResolvedValue([
        { path: '/src/a.ts', name: 'a.ts', isFolder: false },
      ]),
      searchRepoCode: jest.fn().mockResolvedValue(searchResult),
    };
    const reader = new RemoteCatalogReader(identity(provider, 'pinned-sha'), catalog);

    // Act
    const content = await reader.readFile('/src/a.ts');
    const entries = await reader.listDir('/src');
    const matches = await reader.searchCode('needle', 99);

    // Assert
    expect(content).toBe('remote-content');
    expect(entries).toEqual([{ path: '/src/a.ts', name: 'a.ts', isFolder: false }]);
    expect(matches).toBe(searchResult);
    expect(catalog.getSkillFile).toHaveBeenCalledWith(
      identity(provider, 'pinned-sha').project,
      'reader-fixture',
      '/src/a.ts',
      'pinned-sha',
      provider,
    );
    expect(catalog.listRepoDir).toHaveBeenCalledWith(
      identity(provider, 'pinned-sha').project,
      'reader-fixture',
      '/src',
      'pinned-sha',
      provider,
    );
    expect(catalog.searchRepoCode).toHaveBeenCalledWith(
      identity(provider, 'pinned-sha').project,
      'reader-fixture',
      'needle',
      'pinned-sha',
      30,
      provider,
    );
  });

  it('provider-routes the newly exposed facade list and search operations', async () => {
    // Arrange
    const adoList = [{ path: '/ado.ts', name: 'ado.ts', isFolder: false }];
    const githubList = [{ path: '/github.ts', name: 'github.ts', isFolder: false }];
    const adoSearch = [{
      path: '/ado.ts',
      fileName: 'ado.ts',
      repository: 'repo',
      project: 'project',
      matches: [{ snippet: 'needle' }],
    }];
    const githubSearch = [{
      path: '/github.ts',
      url: 'https://github.example/github.ts',
      matches: [{ fragment: 'needle' }],
    }];
    const adoListSpy = jest.spyOn(adoCatalog, 'listRepoDir').mockResolvedValue(adoList);
    const githubListSpy = jest.spyOn(githubCatalog, 'listRepoDir').mockResolvedValue(githubList);
    const adoSearchSpy = jest.spyOn(adoCatalog, 'searchRepoCode').mockResolvedValue(adoSearch);
    const githubSearchSpy = jest.spyOn(githubCatalog, 'searchRepoCode')
      .mockResolvedValue(githubSearch);

    try {
      // Act
      const results = await Promise.all([
        skillCatalogFacade.listRepoDir('project', 'repo', '/src', 'main', 'ado'),
        skillCatalogFacade.listRepoDir('org', 'repo', '/src', 'main', 'github'),
        skillCatalogFacade.searchRepoCode('project', 'repo', 'needle', 'main', 99, 'ado'),
        skillCatalogFacade.searchRepoCode('org', 'repo', 'needle', 'main', 99, 'github'),
      ]);

      // Assert
      expect(results).toEqual([adoList, githubList, adoSearch, githubSearch]);
      expect(adoListSpy).toHaveBeenCalledWith('project', 'repo', '/src', 'main');
      expect(githubListSpy).toHaveBeenCalledWith('repo', '/src', 'main');
      expect(adoSearchSpy).toHaveBeenCalledWith('project', 'repo', 'needle', 'main', 30);
      expect(githubSearchSpy).toHaveBeenCalledWith(
        'repo',
        'needle',
        'main',
        undefined,
        30,
      );
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('TBI-001 DoD-3 provides provider-parity for GitHub and ADO identities', () => {
  it('runs the same local reader contract for both existing SkillProvider values', async () => {
    // Arrange
    const fixture = makeFixture();
    const readers = (['ado', 'github'] as const).map((provider) =>
      new LocalCheckoutReader({
        identity: identity(provider, fixture.sha),
        checkoutPath: fixture.root,
      }));

    try {
      // Act
      const results = await Promise.all(readers.map(exerciseContract));

      // Assert
      expect(results[0].content).toBe(results[1].content);
      expect(results[0].entries).toEqual(results[1].entries);
      expect(results[0].matches.map(({ path: matchPath, matches }) => ({
        path: matchPath,
        matches,
      }))).toEqual(results[1].matches.map(({ path: matchPath, matches }) => ({
        path: matchPath,
        matches,
      })));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('TBI-001 NFR-profile-opacity does not encode checkout paths or credentials in profile IDs', () => {
  it('returns a cryptographically opaque process-local identifier', () => {
    // Arrange
    const checkoutPath = 'C:\\sensitive\\checkout?credential=top-secret';
    const resolver = new GroundingProfileResolver({
      authorization: { authorize: async () => true },
      isFeatureEnabled: async () => true,
    });

    // Act
    const first = resolver.registerProfile({
      runRef: 'run-1',
      ...identity('github', 'abc123'),
      checkoutPath,
    });
    const second = resolver.registerProfile({
      runRef: 'run-1',
      ...identity('github', 'abc123'),
      checkoutPath,
    });

    // Assert
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toContain('sensitive');
    expect(first.id).not.toContain('credential');
    expect(first.id).not.toContain('top-secret');
    expect(JSON.stringify(first)).not.toContain(checkoutPath);
  });
});

describe('TBI-001 NFR-local-latency completes fixture read, list, and search below one second', () => {
  it('completes all three local operations below one second under normal fixture load', async () => {
    // Arrange
    const fixture = makeFixture();
    const reader = new LocalCheckoutReader({
      identity: identity('ado', fixture.sha),
      checkoutPath: fixture.root,
    });

    try {
      // Act
      const startedAt = performance.now();
      await exerciseContract(reader);
      const elapsedMs = performance.now() - startedAt;

      // Assert
      expect(elapsedMs).toBeLessThan(1_000);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('RepoReaderError public failure contract', () => {
  it('retains typed fallback eligibility without exposing an internal cause', () => {
    const error = new RepoReaderError(
      'LOCAL_READ_UNAVAILABLE',
      'Repository content is unavailable',
      true,
    );

    expect(error).toMatchObject({
      code: 'LOCAL_READ_UNAVAILABLE',
      fallbackEligible: true,
      message: 'Repository content is unavailable',
    });
  });
});
