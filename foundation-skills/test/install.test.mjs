import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeInstall, planInstall } from '../lib/install.mjs';
import { readLockfile, lockfileIntegrity, LOCKFILE_VERSION } from '../lib/lockfile.mjs';
import { hasFence, hashManaged, END_MARKER } from '../lib/managedRegion.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

test('install writes fenced SKILL.md, companions path, and v2 lockfile (no .apex/foundation)', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    assert.equal(res.dryRun, false);
    assert.equal(fs.existsSync(path.join(repo, '.apex/foundation/ui-lab/SKILL.md')), false);
    const skillMd = path.join(repo, '.cursor/skills/ui-lab/SKILL.md');
    assert.ok(fs.existsSync(skillMd));
    const text = fs.readFileSync(skillMd, 'utf8');
    assert.ok(hasFence(text));
    assert.ok(text.includes(END_MARKER));
    assert.ok(text.includes('## Project notes'));
    assert.ok(fs.existsSync(path.join(repo, 'apex-skills.lock.json')));

    const lock = readLockfile(repo);
    assert.equal(lock.lockfileVersion, LOCKFILE_VERSION);
    assert.equal(lock.suiteVersion, '0.2.0');
    assert.ok(lock.skills['ui-lab'].managedRegionHash);
    assert.equal(typeof lock.skills['ui-lab'].managedFiles, 'object');
    assert.equal(lock.skills['ui-lab'].adapterScaffolded, true);
    assert.equal(lock.skills['ui-lab'].vendored, undefined);
    assert.equal(typeof lock.integrity, 'string');
    assert.equal(lock.integrity, lockfileIntegrity({ ...lock, integrity: undefined }));
  } finally {
    cleanup(repo);
  }
});

test('never clobbers a pre-existing unfenced team adapter', () => {
  const repo = makeRepo({ ...SAMPLE_REPO, '.cursor/skills/ui-lab/SKILL.md': '# my edits\n' });
  try {
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const content = fs.readFileSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'), 'utf8');
    assert.equal(content, '# my edits\n');
    assert.ok(res.warnings.some((w) => /without an APEX managed fence/.test(w)));
  } finally {
    cleanup(repo);
  }
});

test('dry-run writes nothing', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab'], { dryRun: true });
    assert.equal(res.dryRun, true);
    assert.equal(fs.existsSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(repo, 'apex-skills.lock.json')), false);
  } finally {
    cleanup(repo);
  }
});

test('unknown skill aborts with error', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    assert.throws(() => executeInstall(PKG_ROOT, repo, ['does-not-exist']), /Unknown skill/);
  } finally {
    cleanup(repo);
  }
});

test('in-fence drift backs up and continues (does not abort)', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const skillMd = path.join(repo, '.cursor/skills/ui-lab/SKILL.md');
    let text = fs.readFileSync(skillMd, 'utf8');
    // Tamper inside the managed region
    text = text.replace(END_MARKER, 'HAND EDIT INSIDE FENCE\n' + END_MARKER);
    fs.writeFileSync(skillMd, text, 'utf8');

    const res = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    assert.ok(res.warnings.some((w) => /Backed up drifted managed region/.test(w)));
    const after = fs.readFileSync(skillMd, 'utf8');
    assert.ok(!after.includes('HAND EDIT INSIDE FENCE'));
    // Backup directory should exist
    const backups = fs.readdirSync(path.join(repo, '.apex/backups/ui-lab'));
    assert.ok(backups.some((f) => f.startsWith('SKILL.md.')));
  } finally {
    cleanup(repo);
  }
});

test('re-install preserves project notes below the fence', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const adapterPath = path.join(repo, '.cursor/skills/ui-lab/SKILL.md');
    let text = fs.readFileSync(adapterPath, 'utf8');
    text = text.replace(
      '<!-- Yours. APEX never writes below this line. -->\n',
      '<!-- Yours. APEX never writes below this line. -->\n\nMaxView PHI first.\n',
    );
    fs.writeFileSync(adapterPath, text, 'utf8');

    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const after = fs.readFileSync(adapterPath, 'utf8');
    assert.ok(after.includes('MaxView PHI first.'));
    assert.ok(hasFence(after));
  } finally {
    cleanup(repo);
  }
});

test('plan reports actions without writing', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const plan = planInstall(PKG_ROOT, repo, ['ui-lab']);
    assert.equal(plan.errors.length, 0);
    assert.equal(plan.actions.length, 1);
    assert.equal(fs.existsSync(path.join(repo, 'apex-skills.lock.json')), false);
  } finally {
    cleanup(repo);
  }
});

test('install --fill rewrites managed region from current evidence', () => {
  const repo = makeRepo({ 'package.json': JSON.stringify({ name: 'bare' }) });
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const adapterPath = path.join(repo, '.cursor/skills/ui-lab/SKILL.md');
    assert.match(fs.readFileSync(adapterPath, 'utf8'), /TODO\(designTokens\)/);

    fs.mkdirSync(path.join(repo, 'src/styles'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'src/styles/theme.css'),
      ':root { --color-primary: #112233; }\n',
    );

    const res = executeInstall(PKG_ROOT, repo, ['ui-lab'], { fill: true });
    const after = fs.readFileSync(adapterPath, 'utf8');
    assert.match(after, /--color-primary/);
    assert.doesNotMatch(after, /TODO\(designTokens\)/);
    assert.ok(res.warnings.some((w) => /re-filled/.test(w)));
  } finally {
    cleanup(repo);
  }
});

test('install companions for to-prd land under .cursor/skills', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['to-prd']);
    assert.ok(fs.existsSync(path.join(repo, '.cursor/skills/to-prd/backlog-schema.json')));
    assert.ok(fs.existsSync(path.join(repo, '.cursor/skills/to-prd/prd-template.md')));
    assert.equal(fs.existsSync(path.join(repo, '.apex/foundation/to-prd/backlog-schema.json')), false);
    const lock = readLockfile(repo);
    assert.ok(lock.skills['to-prd'].managedFiles['.cursor/skills/to-prd/backlog-schema.json']);
  } finally {
    cleanup(repo);
  }
});

test('managedRegionHash changes only when fence content changes', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const skillMd = path.join(repo, '.cursor/skills/ui-lab/SKILL.md');
    const h1 = hashManaged(fs.readFileSync(skillMd, 'utf8'));
    const lock1 = readLockfile(repo).skills['ui-lab'].managedRegionHash;
    assert.equal(h1, lock1);

    // Edit below fence
    fs.appendFileSync(skillMd, '\nExtra note.\n');
    assert.equal(hashManaged(fs.readFileSync(skillMd, 'utf8')), h1);
  } finally {
    cleanup(repo);
  }
});

test('v1 lockfile + .apex/foundation migrates to fenced .cursor/skills and removes legacy dir', () => {
  const foundationText = fs.readFileSync(
    path.join(PKG_ROOT, 'foundation/ui-lab/SKILL.md'),
    'utf8',
  );
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.apex/foundation/ui-lab/SKILL.md': foundationText,
    '.cursor/skills/ui-lab/SKILL.md': '# Pre-existing unfenced adapter\n\nTeam notes.\n',
    'apex-skills.lock.json': JSON.stringify({
      lockfileVersion: 1,
      suiteVersion: '0.2.0',
      package: '@apex/skills',
      skills: {
        'ui-lab': {
          contractRange: '>=0.1.0',
          vendored: { '.apex/foundation/ui-lab/SKILL.md': 'deadbeef' },
          adapterScaffolded: true,
        },
      },
    }, null, 2) + '\n',
  });
  try {
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    assert.ok(res.migration?.didMigrate);
    assert.equal(fs.existsSync(path.join(repo, '.apex/foundation')), false);
    const skillMd = fs.readFileSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'), 'utf8');
    assert.ok(hasFence(skillMd));
    // Original unfenced content preserved in project section
    assert.ok(skillMd.includes('Team notes.') || skillMd.includes('Pre-existing unfenced'));
    const lock = readLockfile(repo);
    assert.equal(lock.lockfileVersion, LOCKFILE_VERSION);
    assert.ok(lock.skills['ui-lab'].managedRegionHash);
    assert.equal(lock.skills['ui-lab'].vendored, undefined);
  } finally {
    cleanup(repo);
  }
});
