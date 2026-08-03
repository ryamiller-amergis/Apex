/**
 * @jest-environment node
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RepositoryIdentity } from '../../shared/types/repoReader';
import {
  GroundingProfileResolver,
  type GroundingCallerContext,
  type RunProjectAuthorization,
} from '../services/groundingProfileResolver';
import { RepoReaderError } from '../services/repoReader';

jest.setTimeout(30_000);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function createCheckout(): { root: string; sha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-profile-acceptance-'));
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'pinned local content\n');
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.writeFileSync(
    path.join(root, 'src', 'nested', 'search.ts'),
    'export const acceptanceNeedle = true;\n',
  );
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Apex Test']);
  git(root, ['config', 'user.email', 'apex-test@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'acceptance fixture']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']) };
}

function identity(sha: string): RepositoryIdentity {
  return {
    provider: 'ado',
    project: 'Apex',
    repo: 'profile-acceptance-fixture',
    sha,
  };
}

const caller: GroundingCallerContext = {
  userId: 'developer-1',
  runRef: 'interview:run-1',
  project: 'Apex',
};

describe('PBI-001 workspace profile acceptance', () => {
  it('AC-0 resolves authorized local profiles and reads the pinned snapshot', async () => {
    // Given an authorized profile backed by a valid checkout.
    const fixture = createCheckout();
    const callOrder: string[] = [];
    const authorization: RunProjectAuthorization = {
      authorize: jest.fn(async () => {
        callOrder.push('authorize');
        return true;
      }),
    };
    const isFeatureEnabled = jest.fn(async () => {
      callOrder.push('flag');
      return true;
    });
    const resolver = new GroundingProfileResolver({ authorization, isFeatureEnabled });
    const profile = resolver.registerProfile({
      runRef: caller.runRef,
      ...identity(fixture.sha),
      checkoutPath: fixture.root,
    });

    try {
      // When the caller resolves the profile and reads, lists, and searches.
      const reader = await resolver.resolveProfile(profile.id, caller);
      const [content, entries, matches] = await Promise.all([
        reader.readFile('README.md'),
        reader.listDir('src'),
        reader.searchCode('acceptanceNeedle'),
      ]);

      // Then all operations use the authorized pinned local snapshot contract.
      expect(callOrder).toEqual(['authorize', 'flag']);
      expect(authorization.authorize).toHaveBeenCalledWith(expect.objectContaining({
        userId: caller.userId,
        callerRunRef: caller.runRef,
        ownerRunRef: caller.runRef,
        callerProject: caller.project,
        ownerProject: caller.project,
      }));
      expect(reader.identity).toEqual(identity(fixture.sha));
      expect(content).toBe('pinned local content\n');
      expect(entries).toEqual([
        { path: '/src/nested', name: 'nested', isFolder: true },
      ]);
      expect(matches).toEqual([
        {
          path: '/src/nested/search.ts',
          fileName: 'search.ts',
          repository: 'profile-acceptance-fixture',
          project: 'Apex',
          branch: fixture.sha,
          matches: [{
            lineNumber: 1,
            snippet: 'export const acceptanceNeedle = true;',
          }],
        },
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('AC-1 returns a controlled fallback-eligible failure for unreadable checkout', async () => {
    // Given an authorized profile whose checkout cannot be read.
    const missingCheckout = path.join(
      os.tmpdir(),
      `sensitive-missing-checkout-${Date.now()}`,
    );
    const resolver = new GroundingProfileResolver({
      authorization: { authorize: async () => true },
      isFeatureEnabled: async () => true,
    });
    const profile = resolver.registerProfile({
      runRef: caller.runRef,
      ...identity('pinned-sha'),
      checkoutPath: missingCheckout,
    });

    // When a repository operation is requested.
    const reader = await resolver.resolveProfile(profile.id, caller);
    const failure = await reader.readFile('README.md').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Then the failure is typed, sanitized, controlled, and fallback-eligible.
    expect(failure).toBeInstanceOf(RepoReaderError);
    expect(failure).toMatchObject({
      code: 'LOCAL_READ_UNAVAILABLE',
      fallbackEligible: true,
      message: 'Repository content is unavailable',
    });
    expect(String(failure)).not.toContain(missingCheckout);
    expect(String(failure)).not.toContain('README.md');
  });

  it('AC-2 returns empty content, bounded entries, and no-match results', async () => {
    // Given a repository with an empty file, nested directories, and over 1,000 entries.
    const fixture = createCheckout();
    const crowded = path.join(fixture.root, 'crowded');
    fs.mkdirSync(crowded);
    for (let index = 0; index < 1_001; index += 1) {
      fs.writeFileSync(path.join(crowded, `${String(index).padStart(4, '0')}.txt`), '');
    }
    const resolver = new GroundingProfileResolver({
      authorization: { authorize: async () => true },
      isFeatureEnabled: async () => true,
    });
    const profile = resolver.registerProfile({
      runRef: caller.runRef,
      ...identity(fixture.sha),
      checkoutPath: fixture.root,
    });

    try {
      // When the corresponding operations run through the resolved profile.
      const reader = await resolver.resolveProfile(profile.id, caller);
      const [emptyContent, rootEntries, boundedEntries, noMatches] = await Promise.all([
        reader.readFile('empty.txt'),
        reader.listDir(''),
        reader.listDir('crowded'),
        reader.searchCode('this-fixed-string-does-not-exist'),
      ]);

      // Then empties remain valid, nesting is represented, and caps are exact.
      expect(emptyContent).toBe('');
      expect(rootEntries).toEqual(expect.arrayContaining([
        { path: '/src', name: 'src', isFolder: true },
        { path: '/crowded', name: 'crowded', isFolder: true },
      ]));
      expect(boundedEntries).toHaveLength(1_000);
      expect(boundedEntries[0]?.name).toBe('0000.txt');
      expect(boundedEntries[999]?.name).toBe('0999.txt');
      expect(boundedEntries).not.toContainEqual(expect.objectContaining({ name: '1000.txt' }));
      expect(noMatches).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('AC-3 denies unauthorized resolution and escaping paths without disclosure', async () => {
    // Given a profile, an unauthorized caller, and paths that escape its checkout.
    const fixture = createCheckout();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-profile-secret-'));
    const secretContent = 'outside repository secret';
    fs.writeFileSync(path.join(outside, 'secret.txt'), secretContent);
    fs.symlinkSync(outside, path.join(fixture.root, 'escape-link'), 'junction');
    let authorized = false;
    const isFeatureEnabled = jest.fn(async () => true);
    const resolver = new GroundingProfileResolver({
      authorization: { authorize: async () => authorized },
      isFeatureEnabled,
    });
    const profile = resolver.registerProfile({
      runRef: caller.runRef,
      ...identity(fixture.sha),
      checkoutPath: fixture.root,
    });

    try {
      // When the unauthorized caller resolves the otherwise matching profile.
      const deniedResolution = await resolver.resolveProfile(profile.id, caller).then(
        () => undefined,
        (error: unknown) => error,
      );

      // Then authorization is denied before feature work, with no path or content disclosure.
      expect(deniedResolution).toBeInstanceOf(RepoReaderError);
      expect(deniedResolution).toMatchObject({
        code: 'ACCESS_DENIED',
        fallbackEligible: false,
        message: 'Grounding profile access denied',
      });
      expect(isFeatureEnabled).not.toHaveBeenCalled();
      expect(String(deniedResolution)).not.toContain(fixture.root);
      expect(String(deniedResolution)).not.toContain(secretContent);

      // When an authorized resolution attempts traversal and symlink escape reads.
      authorized = true;
      const reader = await resolver.resolveProfile(profile.id, caller);
      const escapingReads = [
        reader.readFile('../secret.txt'),
        reader.readFile('escape-link/secret.txt'),
      ];

      // Then each read is denied without revealing the checkout, target path, or content.
      for (const operation of escapingReads) {
        const deniedRead = await operation.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(deniedRead).toBeInstanceOf(RepoReaderError);
        expect(deniedRead).toMatchObject({
          code: 'ACCESS_DENIED',
          fallbackEligible: false,
          message: 'Repository path access denied',
        });
        expect(String(deniedRead)).not.toContain(fixture.root);
        expect(String(deniedRead)).not.toContain(outside);
        expect(String(deniedRead)).not.toContain(secretContent);
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
