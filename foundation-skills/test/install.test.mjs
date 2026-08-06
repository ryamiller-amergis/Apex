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
    assert.ok(text.includes('APEX:BEGIN adapter'));
    assert.ok(text.includes('## Project notes'));

    assert.ok(fs.existsSync(path.join(repo, 'apex-skills.lock.json')));

    const lock = readLockfile(repo);
    assert.equal(lock.lockfileVersion, LOCKFILE_VERSION);
    assert.equal(lock.suiteVersion, '2.0.0');
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

test('adopts a pre-existing unfenced team skill as the project-owned tail', () => {
  const repo = makeRepo({ ...SAMPLE_REPO, '.cursor/skills/ui-lab/SKILL.md': '# my edits\n' });
  try {
    const res = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const content = fs.readFileSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'), 'utf8');
    assert.match(content, /APEX:BEGIN managed/);
    assert.match(content, /# UI Lab — Foundation/);
    assert.match(content, /# my edits/);
    assert.ok(res.warnings.some((w) => /adopted.*project-owned/i.test(w)));
    const backups = fs.readdirSync(path.join(repo, '.apex/backups/ui-lab'));
    assert.ok(backups.some((file) => file.startsWith('SKILL.md.')));
  } finally {
    cleanup(repo);
  }
});

test('refuses malformed fence markers without changing team content', () => {
  const malformed =
    '# TEAM CONTENT\n<!-- APEX:END managed -->\n' +
    '<!-- APEX:BEGIN adapter -->\nTEAM ADAPTER\n<!-- APEX:END adapter -->\n';
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.cursor/skills/ui-lab/SKILL.md': malformed,
  });
  try {
    assert.throws(
      () => executeInstall(PKG_ROOT, repo, ['ui-lab']),
      /malformed APEX fence/i,
    );
    assert.equal(
      fs.readFileSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'), 'utf8'),
      malformed,
    );
    assert.equal(fs.existsSync(path.join(repo, 'apex-skills.lock.json')), false);
  } finally {
    cleanup(repo);
  }
});

test('refuses to overwrite a 1.1 single-fence skill whose adapter cannot be separated safely', () => {
  const legacySkill = `---
name: ui-lab
description: Legacy combined skill.
---
<!-- APEX:BEGIN managed (ui-lab @ 1.1.0) -->
# UI Lab — Foundation

LEGACY_FOUNDATION

# UI Lab — Project Design System Adapter

TEAM_ADAPTER_RULE
<!-- APEX:END managed -->

## Project notes

TEAM_PROJECT_NOTE
`;
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.cursor/skills/ui-lab/SKILL.md': legacySkill,
  });
  try {
    assert.throws(
      () => executeInstall(PKG_ROOT, repo, ['ui-lab']),
      /legacy single-fence.*cannot safely separate/i,
    );
    assert.equal(
      fs.readFileSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'), 'utf8'),
      legacySkill,
    );
    assert.equal(fs.existsSync(path.join(repo, 'apex-skills.lock.json')), false);
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
    assert.ok(res.warnings.some((w) => /Backed up drifted foundation fence/.test(w)));
    const after = fs.readFileSync(skillMd, 'utf8');
    assert.ok(!after.includes('HAND EDIT INSIDE FENCE'));
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

test('re-install replaces foundation frontmatter and preserves the complete project-owned tail', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const skillPath = path.join(repo, '.cursor/skills/ui-lab/SKILL.md');
    let text = fs.readFileSync(skillPath, 'utf8');
    text = text
      .replace(
        'description: Project-agnostic UI Lab generation skill.',
        'description: Team changed the foundation trigger.',
      )
      .replace('<!-- APEX:END adapter -->', 'TEAM_ADAPTER_RULE\n<!-- APEX:END adapter -->');
    fs.writeFileSync(skillPath, text, 'utf8');
    const beforeTail = text.slice(text.indexOf(END_MARKER) + END_MARKER.length);

    const result = executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const after = fs.readFileSync(skillPath, 'utf8');
    const afterTail = after.slice(after.indexOf(END_MARKER) + END_MARKER.length);

    assert.doesNotMatch(after, /Team changed the foundation trigger/);
    assert.match(after, /description: Project-agnostic UI Lab generation skill\./);
    assert.equal(afterTail, beforeTail);
    assert.match(after, /TEAM_ADAPTER_RULE/);
    assert.ok(result.warnings.some((warning) => /Backed up drifted foundation fence/.test(warning)));
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
    assert.match(fs.readFileSync(adapterPath, 'utf8'), /APEX:unfilled\(designTokens\)/);

    fs.mkdirSync(path.join(repo, 'src/styles'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'src/styles/theme.css'),
      ':root { --color-primary: #112233; }\n',
    );
    let beforeFill = fs.readFileSync(adapterPath, 'utf8');
    beforeFill = beforeFill.replace(
      '<!-- APEX:END adapter -->',
      'TEAM_FREEFORM_RULE\n<!-- APEX:END adapter -->',
    );
    fs.writeFileSync(adapterPath, beforeFill, 'utf8');

    const res = executeInstall(PKG_ROOT, repo, ['ui-lab'], { fill: true });
    const after = fs.readFileSync(adapterPath, 'utf8');
    assert.match(after, /--color-primary/);
    assert.doesNotMatch(after, /APEX:unfilled\(designTokens\)/);
    assert.match(after, /TEAM_FREEFORM_RULE/);
    assert.ok(res.warnings.some((w) => /refreshed/.test(w)));
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

test('v1 migration only migrates installed skills; leftover foundation folders are discarded', () => {
  const foundationText = fs.readFileSync(
    path.join(PKG_ROOT, 'foundation/ui-lab/SKILL.md'),
    'utf8',
  );
  const leftover = fs.readFileSync(
    path.join(PKG_ROOT, 'foundation/to-prd/SKILL.md'),
    'utf8',
  );
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.apex/foundation/ui-lab/SKILL.md': foundationText,
    // Leftover from an earlier full-catalog install — must NOT become .cursor/skills/to-prd
    '.apex/foundation/to-prd/SKILL.md': leftover,
    '.apex/foundation/to-prd/backlog-schema.json': '{}\n',
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
    assert.ok(res.warnings.some((w) => /Skipping migration for .* leftover/.test(w)));
    assert.equal(fs.existsSync(path.join(repo, '.apex/foundation')), false);
    assert.ok(fs.existsSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md')));
    assert.equal(fs.existsSync(path.join(repo, '.cursor/skills/to-prd')), false);
    const skillMd = fs.readFileSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'), 'utf8');
    assert.ok(hasFence(skillMd));
    assert.ok(skillMd.includes('APEX:BEGIN adapter'));
    const lock = readLockfile(repo);
    assert.equal(lock.lockfileVersion, LOCKFILE_VERSION);
    assert.ok(lock.skills['ui-lab'].managedRegionHash);
    assert.equal(lock.skills['ui-lab'].vendored, undefined);
    assert.equal(lock.skills['to-prd'], undefined);
  } finally {
    cleanup(repo);
  }
});

test('v1 migration combines a scaffolded unfenced adapter with its legacy foundation', () => {
  const foundationText = fs.readFileSync(
    path.join(PKG_ROOT, 'foundation/ui-lab/SKILL.md'),
    'utf8',
  );
  const scaffoldedAdapter = `---
name: ui-lab
description: Project adapter.
---

# Team UI Adapter

TEAM_ADAPTER_RULE
`;
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.apex/foundation/ui-lab/SKILL.md': foundationText,
    '.cursor/skills/ui-lab/SKILL.md': scaffoldedAdapter,
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
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const migrated = fs.readFileSync(
      path.join(repo, '.cursor/skills/ui-lab/SKILL.md'),
      'utf8',
    );

    assert.match(migrated, /# UI Lab — Foundation/);
    assert.match(migrated, /# Team UI Adapter/);
    assert.match(migrated, /TEAM_ADAPTER_RULE/);
    assert.match(migrated, /APEX:BEGIN adapter/);
    assert.equal(fs.existsSync(path.join(repo, '.apex/foundation')), false);
  } finally {
    cleanup(repo);
  }
});

test('v1 migration retains the legacy foundation when an unfenced adapter ownership is unknown', () => {
  const foundationText = fs.readFileSync(
    path.join(PKG_ROOT, 'foundation/ui-lab/SKILL.md'),
    'utf8',
  );
  const handWrittenAdapter = '# Hand-written team adapter\n\nDO_NOT_WRAP_AUTOMATICALLY\n';
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.apex/foundation/ui-lab/SKILL.md': foundationText,
    '.cursor/skills/ui-lab/SKILL.md': handWrittenAdapter,
    'apex-skills.lock.json': JSON.stringify({
      lockfileVersion: 1,
      suiteVersion: '0.2.0',
      package: '@apex/skills',
      skills: {
        'ui-lab': {
          contractRange: '>=0.1.0',
          vendored: { '.apex/foundation/ui-lab/SKILL.md': 'deadbeef' },
          adapterScaffolded: false,
        },
      },
    }, null, 2) + '\n',
  });

  try {
    assert.throws(
      () => executeInstall(PKG_ROOT, repo, ['ui-lab']),
      /not recorded as APEX-scaffolded/i,
    );
    assert.equal(
      fs.readFileSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'), 'utf8'),
      handWrittenAdapter,
    );
    assert.equal(
      fs.readFileSync(path.join(repo, '.apex/foundation/ui-lab/SKILL.md'), 'utf8'),
      foundationText,
    );
  } finally {
    cleanup(repo);
  }
});
