import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  buildArtifactCliArgs,
  resolveReleasedSkillsForProject,
  validateGeneratedDiff,
  reconcileRollbackWorkspace,
  buildGeneratedCliEnv,
} from '../services/foundationSkillRepoUpdateService';
import type { FoundationSkillRelease } from '../../shared/types/foundationSkills';

jest.mock('../services/foundationSkillReleaseService', () => ({
  getRelease: jest.fn(),
  getLatestPublishedRelease: jest.fn(),
  isReleaseVisibleToProject: jest.fn(),
  getVisibleSkillsForProject: jest.fn(),
  listRollbackTargets: jest.fn(),
  semverGreaterThan: jest.fn(),
  appendAudit: jest.fn(),
}));
jest.mock('../services/foundationSkillCompatibilityService', () => ({
  checkCompatibility: jest.fn(),
  getRepoStatus: jest.fn(),
}));
jest.mock('../services/repoCheckoutService', () => ({
  checkoutDefaultBranch: jest.fn(),
  checkoutFeatureBranch: jest.fn(),
  pushBranch: jest.fn(),
  cleanupWorkspace: jest.fn(),
}));
jest.mock('../services/repoCacheService', () => ({
  resolveGitRemote: jest.fn(),
}));
jest.mock('../services/skillCatalogGitHub', () => ({
  createPullRequest: jest.fn(),
}));

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.keys(item as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((out, key) => {
          out[key] = sort((item as Record<string, unknown>)[key]);
          return out;
        }, {});
    }
    return item;
  };
  return JSON.stringify(sort(value), null, 2) + '\n';
}

function release(): FoundationSkillRelease {
  return {
    id: 'release-2',
    version: '2.0.0',
    status: 'published',
    artifactPackage: '@apex/skills',
    artifactVersion: '2.0.0',
    artifactFeed:
      'https://pkgs.dev.azure.com/amergis/_packaging/apex-skills/npm/registry/',
    integritySha256: 'verified',
    contractApiVersion: 1,
    selectedSkills: ['ui-lab', 'to-prd'],
    targetProjects: [],
    skillTargets: {
      'ui-lab': ['MaxView'],
      'to-prd': ['MatterWorx'],
    },
    manifestSnapshot: {
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
        {
          name: 'to-prd',
          summary: 'PRD.',
          tier: 'shippable',
          alwaysInstall: false,
          dependsOn: [],
        },
        {
          name: 'post-skill-bootstrap',
          summary: 'Setup.',
          tier: 'shippable',
          alwaysInstall: true,
          dependsOn: [],
        },
      ],
    },
    releaseNotes: null,
    breakingChanges: null,
    publishedBy: 'admin',
    publishedAt: '2026-08-06T00:00:00.000Z',
    deprecatedBy: null,
    deprecatedAt: null,
    createdBy: 'admin',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
  };
}

describe('resolveReleasedSkillsForProject', () => {
  it('uses per-project targeting and artifact-specific always-install skills', () => {
    expect(resolveReleasedSkillsForProject(release(), 'MaxView')).toEqual([
      'ui-lab',
      'post-skill-bootstrap',
    ]);
  });
});
describe('buildArtifactCliArgs', () => {
  it('returns a shell-free argument array for the verified local CLI', () => {
    expect(buildArtifactCliArgs('2.0.0', ['ui-lab'])).toEqual([
      'bin/apex-skills.mjs',
      'install',
      'ui-lab',
      '--skip-feed',
    ]);
  });

  it('rejects command injection payloads', () => {
    expect(() => buildArtifactCliArgs('2.0.0; whoami', ['ui-lab'])).toThrow(
      /artifact version/i
    );
    expect(() => buildArtifactCliArgs('2.0.0', ['ui-lab && whoami'])).toThrow(
      /skill name/i
    );
    expect(() => buildArtifactCliArgs('2.0.0-01', ['ui-lab'])).toThrow(
      /artifact version/i
    );
    expect(() => buildArtifactCliArgs('2.0.0-alpha..1', ['ui-lab'])).toThrow(
      /artifact version/i
    );
  });
});
describe('validateGeneratedDiff', () => {
  it('accepts only lock/config and managed skill paths', () => {
    expect(() =>
      validateGeneratedDiff(
        [
          'apex-skills.lock.json',
          '.apex/config.json',
          '.cursor/skills/ui-lab/SKILL.md',
          '.apex/backups/ui-lab/SKILL.md.old',
        ],
        ['ui-lab'],
        null
      )
    ).not.toThrow();
  });

  it('allows only versioned reconciliation backups for managed skills', () => {
    expect(() =>
      validateGeneratedDiff(
        [
          '.cursor/skills/newer-skill/SKILL.md',
          '.apex/rollback-backups/2.0.0/newer-skill/SKILL.md',
        ],
        ['ui-lab', 'newer-skill'],
        '2.0.0'
      )
    ).not.toThrow();
  });

  it('rejects npm credentials and unrelated source changes', () => {
    expect(() =>
      validateGeneratedDiff(
        ['.npmrc', '.cursor/skills/ui-lab/.NPMRC', 'src/server/index.ts'],
        ['ui-lab'],
        null
      )
    ).toThrow(/unexpected generated files/i);
  });
});

describe('buildGeneratedCliEnv', () => {
  it('passes only runtime basics and the validated APEX URL', () => {
    const oldDatabase = process.env.DATABASE_URL;
    const oldPat = process.env.AZURE_ARTIFACTS_PAT;
    process.env.DATABASE_URL = 'secret-database';
    process.env.AZURE_ARTIFACTS_PAT = 'secret-pat';
    try {
      const env = buildGeneratedCliEnv('https://apex.example.com');
      expect(env.APEX_URL).toBe('https://apex.example.com');
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.AZURE_ARTIFACTS_PAT).toBeUndefined();
    } finally {
      if (oldDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = oldDatabase;
      if (oldPat === undefined) delete process.env.AZURE_ARTIFACTS_PAT;
      else process.env.AZURE_ARTIFACTS_PAT = oldPat;
    }
  });

  it('rejects insecure or credential-bearing APEX URLs', () => {
    expect(() => buildGeneratedCliEnv('http://apex.example.com')).toThrow(
      /HTTPS/i
    );
    expect(() =>
      buildGeneratedCliEnv('https://user:pass@apex.example.com')
    ).toThrow(/credentials/i);
  });
});

describe('reconcileRollbackWorkspace', () => {
  it('quarantines skills absent from the target release and removes the old lock', () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'apex-rollback-test-')
    );
    try {
      fs.mkdirSync(path.join(workspace, '.cursor/skills/ui-lab'), {
        recursive: true,
      });
      fs.mkdirSync(path.join(workspace, '.cursor/skills/newer-skill'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(workspace, '.cursor/skills/newer-skill/SKILL.md'),
        'TEAM_CUSTOMIZATION\n'
      );
      fs.mkdirSync(
        path.join(
          workspace,
          '.apex/rollback-backups/2.0.0/newer-skill/existing-attempt'
        ),
        { recursive: true }
      );
      fs.writeFileSync(
        path.join(workspace, 'apex-skills.lock.json'),
        (() => {
          const lock = {
            lockfileVersion: 2,
            suiteVersion: '2.1.0',
            package: '@apex/skills',
            skills: { 'ui-lab': {}, 'newer-skill': {} },
          };
          const integrity = createHash('sha256')
            .update(stableJson(lock))
            .digest('hex');
          return JSON.stringify({ ...lock, integrity }, null, 2);
        })()
      );

      const result = reconcileRollbackWorkspace(
        workspace,
        ['ui-lab'],
        '2.0.0',
        'rollback',
        '2.1.0'
      );

      expect(result.removedSkills).toEqual(['newer-skill']);
      expect(
        fs.existsSync(path.join(workspace, '.cursor/skills/newer-skill'))
      ).toBe(false);
      const backupRoot = path.join(
        workspace,
        '.apex/rollback-backups/2.0.0/newer-skill'
      );
      const attempts = fs.readdirSync(backupRoot);
      expect(attempts).toContain('existing-attempt');
      const generatedAttempt = attempts.find(
        (name) => name !== 'existing-attempt'
      );
      expect(generatedAttempt).toBeDefined();
      expect(
        fs.readFileSync(
          path.join(backupRoot, generatedAttempt!, 'SKILL.md'),
          'utf8'
        )
      ).toContain('TEAM_CUSTOMIZATION');
      expect(fs.existsSync(path.join(workspace, 'apex-skills.lock.json'))).toBe(
        false
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a rollback when the source lock does not match the installed version', () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'apex-rollback-test-')
    );
    try {
      const lock = {
        lockfileVersion: 2,
        suiteVersion: '2.1.0',
        package: '@apex/skills',
        skills: { 'ui-lab': {} },
      };
      const integrity = createHash('sha256')
        .update(stableJson(lock))
        .digest('hex');
      fs.writeFileSync(
        path.join(workspace, 'apex-skills.lock.json'),
        JSON.stringify({ ...lock, integrity }, null, 2)
      );

      expect(() =>
        reconcileRollbackWorkspace(
          workspace,
          ['ui-lab'],
          '2.0.0',
          'rollback',
          '9.9.9'
        )
      ).toThrow(/source lock version/i);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a forward update that does not move to a newer release', () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'apex-update-test-')
    );
    try {
      const lock = {
        lockfileVersion: 2,
        suiteVersion: '2.1.0',
        package: '@apex/skills',
        skills: { 'ui-lab': {} },
      };
      const integrity = createHash('sha256')
        .update(stableJson(lock))
        .digest('hex');
      fs.writeFileSync(
        path.join(workspace, 'apex-skills.lock.json'),
        JSON.stringify({ ...lock, integrity }, null, 2)
      );

      expect(() =>
        reconcileRollbackWorkspace(workspace, ['ui-lab'], '2.0.0', 'update')
      ).toThrow(/newer than source/i);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('allows a stable release to replace its prerelease', () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'apex-update-test-')
    );
    try {
      const lock = {
        lockfileVersion: 2,
        suiteVersion: '2.0.0-beta.1',
        package: '@apex/skills',
        skills: { 'ui-lab': {} },
      };
      const integrity = createHash('sha256')
        .update(stableJson(lock))
        .digest('hex');
      fs.writeFileSync(
        path.join(workspace, 'apex-skills.lock.json'),
        JSON.stringify({ ...lock, integrity }, null, 2)
      );

      expect(() =>
        reconcileRollbackWorkspace(workspace, ['ui-lab'], '2.0.0', 'update')
      ).not.toThrow();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
