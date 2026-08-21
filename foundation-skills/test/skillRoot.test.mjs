import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeInstall } from '../lib/install.mjs';
import { checkRepo } from '../lib/check.mjs';
import { readLockfile, serializeLockfile } from '../lib/lockfile.mjs';
import {
  migrateSkillRoot,
  planSkillRootMigration,
  rewriteRootPathReferences,
} from '../lib/migrateRoot.mjs';
import {
  KNOWN_SKILL_ROOTS,
  normalizeSkillRoot,
  resolveSkillRoot,
  safeRealpathSync,
} from '../lib/skillRoot.mjs';
import { PKG_ROOT, cleanup, makeRepo, SAMPLE_REPO } from './helpers.mjs';

test('fresh install can use .agents/skills as its canonical root', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['to-prd', 'post-skill-bootstrap'], {
      skillRoot: '.agents/skills',
    });

    const lock = readLockfile(repo);
    const bootstrapSkillText = fs.readFileSync(
      path.join(repo, '.agents/skills/post-skill-bootstrap/SKILL.md'),
      'utf8'
    );
    assert.equal(lock.skillRoot, '.agents/skills');
    assert.equal(lock.lockfileVersion, 3);
    assert.ok(
      lock.skills['to-prd'].managedFiles[
        '.agents/skills/to-prd/backlog-schema.json'
      ]
    );
    assert.match(bootstrapSkillText, /\.agents\/skills\//);
    assert.doesNotMatch(bootstrapSkillText, /\.cursor\/skills\//);
    assert.equal(fs.existsSync(path.join(repo, '.cursor/skills')), false);

    const check = checkRepo(PKG_ROOT, repo);
    assert.equal(check.skillRoot, '.agents/skills');
    assert.equal(
      check.skills.every((skill) => !skill.drift),
      true
    );
  } finally {
    cleanup(repo);
  }
});

test('fresh install defaults to an existing .agents/skills catalog', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.agents/skills/project-owned/SKILL.md':
      '---\nname: project-owned\ndescription: Existing project skill.\n---\n',
  });
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const lock = readLockfile(repo);
    assert.equal(lock.skillRoot, '.agents/skills');
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(
      fs.existsSync(path.join(repo, '.agents/skills/ui-lab/SKILL.md')),
      true
    );
    assert.equal(fs.existsSync(path.join(repo, '.cursor/skills')), false);
  } finally {
    cleanup(repo);
  }
});

test('existing lockfiles without skillRoot remain legacy-compatible', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const lock = readLockfile(repo);
    delete lock.skillRoot;
    fs.writeFileSync(
      path.join(repo, 'apex-skills.lock.json'),
      serializeLockfile(lock),
      'utf8'
    );

    assert.equal(
      resolveSkillRoot({ lock: readLockfile(repo) }),
      '.cursor/skills'
    );
    assert.equal(checkRepo(PKG_ROOT, repo).skills[0].drift, false);
  } finally {
    cleanup(repo);
  }
});

test('root migration preserves project-owned content and rewrites lock paths', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['to-prd']);
    const source = path.join(repo, '.cursor/skills/to-prd/SKILL.md');
    const customized = fs
      .readFileSync(source, 'utf8')
      .replace(
        '<!-- Yours. APEX never writes below this line. -->',
        '<!-- Yours. APEX never writes below this line. -->\n\nMatterWorx note.'
      );
    fs.writeFileSync(source, customized, 'utf8');
    fs.writeFileSync(
      path.join(repo, 'README.md'),
      'Install notes live under .cursor/skills.\n',
      'utf8'
    );

    const result = migrateSkillRoot(repo, '.agents/skills');
    const target = path.join(repo, '.agents/skills/to-prd/SKILL.md');
    const lock = readLockfile(repo);

    assert.equal(result.actions.length, 1);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(target, 'utf8'), customized);
    assert.equal(lock.skillRoot, '.agents/skills');
    assert.equal(lock.lockfileVersion, 3);
    assert.ok(
      lock.skills['to-prd'].managedFiles[
        '.agents/skills/to-prd/backlog-schema.json'
      ]
    );
    assert.equal(
      Object.keys(lock.skills['to-prd'].managedFiles).some((managedPath) =>
        managedPath.startsWith('.cursor/skills/')
      ),
      false
    );
    assert.ok(result.staleRootReferences.includes('README.md'));
    assert.equal(checkRepo(PKG_ROOT, repo).skills[0].drift, false);
  } finally {
    cleanup(repo);
  }
});

test('root migration rewrites generated root references but not project notes', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['post-skill-bootstrap']);
    const source = path.join(
      repo,
      '.cursor/skills/post-skill-bootstrap/SKILL.md'
    );
    const customized = fs
      .readFileSync(source, 'utf8')
      .replace(
        '<!-- Yours. APEX never writes below this line. -->',
        '<!-- Yours. APEX never writes below this line. -->\n\n' +
          'Historical note: .cursor/skills/archive'
      );
    fs.writeFileSync(source, customized, 'utf8');

    const result = migrateSkillRoot(repo, '.agents/skills');
    const migrated = fs.readFileSync(
      path.join(repo, '.agents/skills/post-skill-bootstrap/SKILL.md'),
      'utf8'
    );

    assert.match(
      migrated,
      /Skill install root:[\s\S]*?\.agents\/skills\/[\s\S]*?APEX:\/slot/
    );
    assert.match(migrated, /legacy fallback: `\.cursor\/skills`/);
    assert.match(migrated, /Historical note: \.cursor\/skills\/archive/);
    assert.equal(checkRepo(PKG_ROOT, repo).skills[0].drift, false);
    assert.ok(
      result.staleRootReferences.includes(
        '.agents/skills/post-skill-bootstrap/SKILL.md'
      )
    );
  } finally {
    cleanup(repo);
  }
});

test('root path rewrite does not treat skills as a substring', () => {
  const adapter = [
    'Lockfile: apex-skills.lock.json',
    'Catalog: skills/ui-lab/SKILL.md',
    'Also under .agents/skills/other/SKILL.md',
    'Project path: docs-skills/example/SKILL.md',
    'Nested path: docs/skills/guide.md',
    'Prose about skills in general.',
  ].join('\n');

  const rewritten = rewriteRootPathReferences(
    adapter,
    'skills',
    '.agents/skills'
  );
  assert.match(rewritten, /apex-skills\.lock\.json/);
  assert.match(rewritten, /Catalog: \.agents\/skills\/ui-lab\/SKILL\.md/);
  assert.match(rewritten, /\.agents\/skills\/other\/SKILL\.md/);
  assert.match(rewritten, /docs-skills\/example\/SKILL\.md/);
  assert.match(rewritten, /docs\/skills\/guide\.md/);
  assert.match(rewritten, /Prose about skills in general\./);
  assert.doesNotMatch(rewritten, /apex-\.agents\/skills\.lock/);
  assert.doesNotMatch(rewritten, /docs-\.agents\/skills/);
  assert.doesNotMatch(rewritten, /docs\/\.agents\/skills/);
  assert.equal(
    rewriteRootPathReferences(
      'See .cursor/skills/ui-lab/SKILL.md',
      '.cursor/skills',
      '.agents/skills'
    ),
    'See .agents/skills/ui-lab/SKILL.md'
  );
});

test('mixed-root collisions block install and migration', () => {
  const installRepo = makeRepo({
    ...SAMPLE_REPO,
    '.cursor/skills/ui-lab/SKILL.md': '# existing legacy skill\n',
  });
  try {
    assert.throws(
      () =>
        executeInstall(PKG_ROOT, installRepo, ['ui-lab'], {
          skillRoot: '.agents/skills',
        }),
      /exists outside canonical root/
    );
    assert.equal(
      fs.existsSync(path.join(installRepo, '.agents/skills/ui-lab')),
      false
    );
  } finally {
    cleanup(installRepo);
  }

  const genericCollisionRepo = makeRepo({
    ...SAMPLE_REPO,
    'skills/ui-lab/SKILL.md': '# generic catalog skill\n',
  });
  try {
    assert.throws(
      () =>
        executeInstall(PKG_ROOT, genericCollisionRepo, ['ui-lab'], {
          skillRoot: '.agents/skills',
        }),
      /exists outside canonical root/
    );
  } finally {
    cleanup(genericCollisionRepo);
  }

  const migrationRepo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, migrationRepo, ['ui-lab']);
    fs.mkdirSync(path.join(migrationRepo, '.agents/skills/ui-lab'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(migrationRepo, '.agents/skills/ui-lab/SKILL.md'),
      '# project-owned collision\n',
      'utf8'
    );

    const plan = planSkillRootMigration(migrationRepo, '.agents/skills');
    assert.match(plan.errors.join('\n'), /already exists outside/);
    assert.throws(
      () => migrateSkillRoot(migrationRepo, '.agents/skills'),
      /migration aborted/
    );
    assert.equal(
      fs.existsSync(path.join(migrationRepo, '.cursor/skills/ui-lab/SKILL.md')),
      true
    );
  } finally {
    cleanup(migrationRepo);
  }
});

test('a harness symlink to the canonical catalog is not a collision', (t) => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab'], {
      skillRoot: '.agents/skills',
    });
    fs.mkdirSync(path.join(repo, '.cursor'), { recursive: true });
    try {
      fs.symlinkSync(
        '../.agents/skills',
        path.join(repo, '.cursor/skills'),
        'dir'
      );
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('directory symlinks are not available in this environment');
        return;
      }
      throw error;
    }

    assert.equal(checkRepo(PKG_ROOT, repo).skills[0].rootCollision, false);
    assert.doesNotThrow(() =>
      executeInstall(PKG_ROOT, repo, ['ui-lab'], {
        skillRoot: '.agents/skills',
      })
    );
  } finally {
    cleanup(repo);
  }
});

test('skill roots must remain repository-relative', () => {
  assert.deepEqual(
    [...KNOWN_SKILL_ROOTS],
    ['.agents/skills', '.cursor/skills', 'skills']
  );
  assert.equal(normalizeSkillRoot('./.agents/skills/'), '.agents/skills');
  assert.equal(normalizeSkillRoot('.agents/foo/../skills'), '.agents/skills');
  assert.throws(() => normalizeSkillRoot('../skills'), /within the repository/);
  assert.throws(() => normalizeSkillRoot('/tmp/skills'), /repository-relative/);
  assert.throws(() => normalizeSkillRoot('C:\\skills'), /repository-relative/);
  assert.throws(() => normalizeSkillRoot('company/skills'), /one of/);
});

test('safeRealpathSync falls back to the literal path when resolution fails', () => {
  const abs = path.resolve('definitely-missing-apex-skill-root-apex152');
  assert.equal(safeRealpathSync(abs), abs);
});

test('root migration rejects lockfile skill keys that escape the catalog', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab'], { skillRoot: 'skills' });
    const lock = readLockfile(repo);
    lock.skills['../src'] = { ...lock.skills['ui-lab'] };
    fs.writeFileSync(
      path.join(repo, 'apex-skills.lock.json'),
      serializeLockfile(lock),
      'utf8'
    );
    const canary = path.join(repo, 'src/canary.txt');
    fs.mkdirSync(path.dirname(canary), { recursive: true });
    fs.writeFileSync(canary, 'do-not-move\n', 'utf8');

    const plan = planSkillRootMigration(repo, '.agents/skills');
    assert.match(plan.errors.join('\n'), /not a valid Agent Skills name/);
    assert.equal(plan.actions.length, 1);
    assert.equal(fs.readFileSync(canary, 'utf8'), 'do-not-move\n');
    assert.equal(fs.existsSync(path.join(repo, '.agents/src')), false);
  } finally {
    cleanup(repo);
  }
});
