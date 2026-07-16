import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));
jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  isThreadIdle: jest.fn(),
  sendMessage: jest.fn(),
}));
jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));

import { computeFingerprint } from '../services/designModuleService';

describe('designModuleService source fingerprinting', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-module-'));
    fs.mkdirSync(path.join(root, 'src', 'services'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'services', 'alpha.ts'),
      'export const alpha = 1;\n'
    );
    fs.writeFileSync(
      path.join(root, 'src', 'services', 'beta.ts'),
      'export const beta = 2;\n'
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hashes matched files deterministically and detects content changes', () => {
    const first = computeFingerprint(['src/services/*.ts'], root);
    const second = computeFingerprint(['src/services/*.ts'], root);

    expect(first.sourceAvailable).toBe(true);
    expect(first.files).toEqual([
      'src/services/alpha.ts',
      'src/services/beta.ts',
    ]);
    expect(second.fingerprint).toBe(first.fingerprint);

    fs.writeFileSync(
      path.join(root, 'src', 'services', 'alpha.ts'),
      'export const alpha = 3;\n'
    );
    expect(
      computeFingerprint(['src/services/*.ts'], root).fingerprint
    ).not.toBe(first.fingerprint);
  });

  it('returns an unavailable result when no source matches', () => {
    expect(computeFingerprint(['src/missing/**/*.ts'], root)).toEqual({
      fingerprint: null,
      sourceAvailable: false,
      files: [],
    });
  });

  it('rejects paths outside the repository', () => {
    expect(() => computeFingerprint(['../secret.txt'], root)).toThrow(
      'stay within the repository'
    );
  });
});

describe('design module documentation skill contract', () => {
  const skillPath = path.join(
    process.cwd(),
    '.cursor',
    'skills',
    'design-module-doc',
    'SKILL.md'
  );

  it('requires principal-level architecture, runtime, state, and operations sections', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');

    expect(skill).toContain('## Purpose and Scope');
    expect(skill).toContain('## System and Component Architecture');
    expect(skill).toContain('## Runtime Sequence and Data Flow');
    expect(skill).toContain('## Persistence and State Model');
    expect(skill).toContain('## Reliability, Failure, and Recovery');
    expect(skill).toContain('## Security and Operational Boundaries');
    expect(skill).toContain('at least two useful Mermaid views');
    expect(skill).toContain('blue/green or slot topology');
    expect(skill).toContain('exact `.ai-pilot` input/output paths');
  });

  it('constrains generated diagrams to conservative Mermaid v11 syntax', () => {
    const skill = fs.readFileSync(skillPath, 'utf8');

    expect(skill).toContain('Mermaid v11-compatible');
    expect(skill).toContain('flowchart LR');
    expect(skill).toContain('sequenceDiagram');
    expect(skill).toContain('stateDiagram-v2');
    expect(skill).toContain('Avoid beta/experimental syntax');
  });
});

describe('seeded design module documentation', () => {
  const migrationPath = path.join(
    process.cwd(),
    'migrations',
    '20260715224500_enrich-design-module-docs.sql'
  );
  const moduleDelimiters = [
    'chat',
    'interview',
    'pdf',
    'analysis',
    'infra',
    'cicd',
  ];
  const requiredSections = [
    '## Purpose and Scope',
    '## System and Component Architecture',
    '## Runtime Sequence and Data Flow',
    '## Persistence and State Model',
    '## Key Files and Layers',
    '## Detailed Runtime Flow',
    '## Reliability, Failure, and Recovery',
    '## Security and Operational Boundaries',
    '## Related Docs',
  ];

  it('updates exactly six seeded slugs without seeding RBAC', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration.match(/^\s{4}'(chat-home|interview-workflow|pdf-assembly|backlog-ai-analysis|infrastructure|ci-cd)',$/gm)).toHaveLength(6);
    expect(migration).not.toContain('INSERT INTO app_permissions');
    expect(migration).not.toContain('INSERT INTO app_role_permissions');
    expect(migration).toContain('WHERE dm.slug = seed.slug');
  });

  it('uses six curated source scopes that resolve in the repository', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');
    const sourceScopes = Array.from(
      migration.matchAll(/'(\[[\s\S]*?\])'::jsonb/g),
      (match) => JSON.parse(match[1]) as string[]
    );

    expect(sourceScopes).toHaveLength(6);
    for (const sourceGlobs of sourceScopes) {
      expect(sourceGlobs.length).toBeGreaterThan(5);
      expect(sourceGlobs).not.toContain('src/**');
      const fingerprint = computeFingerprint(sourceGlobs);
      expect(fingerprint.sourceAvailable).toBe(true);
      expect(fingerprint.files).toHaveLength(sourceGlobs.length);
    }
  });

  it.each(moduleDelimiters)(
    'provides complete principal-level content for %s',
    (delimiter) => {
      const migration = fs.readFileSync(migrationPath, 'utf8');
      const marker = `$${delimiter}$`;
      const start = migration.indexOf(marker);
      const end = migration.indexOf(marker, start + marker.length);

      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const content = migration.slice(start + marker.length, end);
      for (const section of requiredSections) {
        expect(content).toContain(section);
      }
      expect(content.match(/```mermaid/g)?.length).toBeGreaterThanOrEqual(2);
      expect(content.match(/```/g)?.length ?? 0).toBe(
        (content.match(/```mermaid/g)?.length ?? 0) * 2
      );
    }
  );

  it('includes the critical interview and blue-green implementation boundaries', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('Express interview routes');
    expect(migration).toContain('kickoff-transcript.md');
    expect(migration).toContain('slug.prd.md and slug.backlog.json');
    expect(migration).toContain('interviews and prds');
    expect(migration).toContain('Azure App Service blue-green topology');
    expect(migration).toContain('Staging slot with new package');
    expect(migration).toContain('Inverse swap rollback');
    expect(migration).toContain('deployment_outcomes');
  });
});
