import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeInstall, planInstall } from '../lib/install.mjs';
import { loadCatalog, findSkill, listAdapterRuntimeFiles } from '../lib/catalog.mjs';
import { readLockfile, lockfileIntegrity, LOCKFILE_VERSION } from '../lib/lockfile.mjs';
import { hasFence, hashManaged, END_MARKER } from '../lib/managedRegion.mjs';
import { ensureAlwaysInstallSkills } from '../lib/alwaysInstall.mjs';
import { cmdBootstrap, cmdInstall } from '../lib/commands.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

function declaredAdapterRuntimeFiles(skill) {
  return (skill.adapterFiles ?? []).filter(
    (rel) =>
      rel === 'apex-skill.json'
      || (
        rel !== 'SKILL.md'
        && rel !== 'recipe.json'
        && skill.supportingOwners?.[rel] === 'adapter'
      ),
  );
}

function expectedManagedFiles(skill) {
  const foundationFiles = (skill.foundationFiles ?? [])
    .filter((rel) => rel !== 'SKILL.md')
    .map((rel) => `.cursor/skills/${skill.name}/${rel}`);
  const adapterFiles = listAdapterRuntimeFiles(skill)
    .map((rel) => `.cursor/skills/${skill.name}/${rel}`);
  return [...foundationFiles, ...adapterFiles].sort();
}

function assertManagedFilesInstalledAndTracked(repo, lock, skill) {
  for (const rel of expectedManagedFiles(skill)) {
    assert.ok(fs.existsSync(path.join(repo, rel)), `missing installed managed file ${rel}`);
    assert.ok(lock.skills[skill.name]?.managedFiles?.[rel], `lockfile did not track ${rel}`);
  }
  assert.equal(
    fs.existsSync(path.join(repo, '.cursor/skills', skill.name, 'recipe.json')),
    false,
    `recipe.json should stay package-internal for ${skill.name}`,
  );
}

function makeMaxViewCleanInstallFixture() {
  return {
    'package.json': JSON.stringify({ name: 'timeclock', private: true }, null, 2) + '\n',
    'AGENTS.md': `# MaxView

Workforce management platform for timekeeping, scheduling, credentialing, and staffing operations.

## Key Terminology

| Term | Meaning |
| --- | --- |
| **PBI** | Product Backlog Item |
| **TBI** | Technical Backlog Item |
| **RBAC** | Role-Based Access Control |
`,
    'CONTEXT-MAP.md': `# MaxView Context Map

Primary domain docs live here.
`,
    'docs/AGENTS.md': `# Nested Docs

## Key Terminology

| Term | Meaning |
| --- | --- |
| **MatterWorx** | Wrong project reference |
`,
    'docs/local-debug/CONTEXT.md': `# Local Debug Guide

## Key Terminology

| Term | Meaning |
| --- | --- |
| Docker Port | 5432 |
| MatterWorx | Another product |
`,
    'src/Maxim.TimeClock.Web/ClientApp/package.json': JSON.stringify(
      {
        name: 'clientapp',
        dependencies: {
          react: '^18.2.0',
          '@mui/material': '^5.15.0',
        },
        devDependencies: {
          webpack: '^5.0.0',
        },
      },
      null,
      2,
    ) + '\n',
    'src/Maxim.TimeClock.Web/ClientApp/src/styles/theme.css': [
      ':root {',
      '  --color-primary: #123456;',
      '  --text-primary: #222222;',
      '  --broken-token: { color: red };',
      '}',
      '',
    ].join('\n'),
    'src/Maxim.TimeClock.Web/ClientApp/wwwroot/css/site.css': ':root { --wwwroot-token: #ffffff; }\n',
    'docs/styles/tokens.css': ':root { --docs-token: #000000; }\n',
    'src/Maxim.TimeClock.Web/ClientApp/js/components/ShiftCard.tsx': 'export const ShiftCard = () => null;\n',
  };
}

function makeMatterWorxCleanInstallFixture() {
  return {
    'package.json': JSON.stringify(
      {
        name: 'matterworx',
        description: 'Stale package metadata that must be ignored.',
        private: true,
      },
      null,
      2,
    ) + '\n',
    'AGENTS.md': `# MatterWorx Monorepo

Vendor management system for healthcare staffing operations.

## Key Terminology

| Term | Meaning |
| --- | --- |
| **PBI** | Product Backlog Item |
| **TBI** | Technical Backlog Item |
`,
    'CONTEXT-MAP.md': `# MatterWorx Context Map

Primary domain docs live here.
`,
    'docs/AGENTS.md': `# Nested docs

Do not use this file for project identity.
`,
    'docs/local-debug/CONTEXT.md': `# Local Debug Guide

## Key Terminology

| Term | Meaning |
| --- | --- |
| Docker Port | 5432 |
| infra/shared-async.tf | Not part of MatterWorx mission context |
`,
    'frontend/package.json': JSON.stringify(
      {
        name: 'frontend',
        dependencies: {
          next: '^15.0.0',
          react: '^19.0.0',
        },
        devDependencies: {
          tailwindcss: '^4.0.0',
        },
      },
      null,
      2,
    ) + '\n',
  };
}

function installAndBootstrap(repo, requestedSkills) {
  const logs = [];
  const installExit = cmdInstall(
    {
      _: ensureAlwaysInstallSkills(requestedSkills),
      cwd: repo,
      package: PKG_ROOT,
      skipFeed: true,
    },
    (message) => logs.push(message),
  );
  assert.equal(installExit, 0, `install failed:\n${logs.join('\n')}`);

  const bootstrapExit = cmdBootstrap(
    { all: true, cwd: repo, package: PKG_ROOT },
    (message) => logs.push(message),
  );
  assert.equal(bootstrapExit, 0, `bootstrap failed:\n${logs.join('\n')}`);

  return { logs, lock: readLockfile(repo) };
}

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
    assert.equal(lock.suiteVersion, '2.0.2');
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

test('install writes review scorecards and adr template from adapter-owned runtime companions', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['prd-spec-review', 'design-spec-review', 'adr-finalize']);

    const expectedFiles = [
      '.cursor/skills/prd-spec-review/rubric.md',
      '.cursor/skills/prd-spec-review/scorecard-template.md',
      '.cursor/skills/design-spec-review/rubric.md',
      '.cursor/skills/design-spec-review/scorecard-template.md',
      '.cursor/skills/adr-finalize/adr-template.md',
    ];

    for (const rel of expectedFiles) {
      assert.ok(fs.existsSync(path.join(repo, rel)), `missing installed runtime companion ${rel}`);
    }

    assert.equal(fs.existsSync(path.join(repo, '.cursor/skills/prd-spec-review/recipe.json')), false);
    assert.equal(fs.existsSync(path.join(repo, '.cursor/skills/design-spec-review/recipe.json')), false);
    assert.equal(fs.existsSync(path.join(repo, '.cursor/skills/adr-finalize/recipe.json')), false);

    const lock = readLockfile(repo);
    for (const rel of expectedFiles) {
      const [, , skill] = rel.split('/');
      assert.ok(
        lock.skills[skill].managedFiles[rel],
        `lockfile did not track ${rel}`,
      );
      assert.ok(
        lock.skills[skill].managedFiles[rel].length > 0,
        `lockfile hash missing for ${rel}`,
      );
    }
  } finally {
    cleanup(repo);
  }
});

test('install iterates every shippable catalog skill in isolation, tracks managed companions, and preserves always-install scope', () => {
  const catalog = loadCatalog(PKG_ROOT);
  const shippableSkills = catalog.skills.filter((skill) => skill.tier !== 'apex-only');

  for (const skill of shippableSkills) {
    const repo = makeRepo(SAMPLE_REPO);
    try {
      executeInstall(PKG_ROOT, repo, ensureAlwaysInstallSkills([skill.name]));

      const lock = readLockfile(repo);
      const expectedScope = ensureAlwaysInstallSkills([skill.name]).sort();
      assert.deepEqual(Object.keys(lock.skills).sort(), expectedScope);

      for (const installedSkillName of expectedScope) {
        const installedSkill = findSkill(catalog, installedSkillName);
        assert.ok(installedSkill, `catalog missing expected skill ${installedSkillName}`);
        assertManagedFilesInstalledAndTracked(repo, lock, installedSkill);
      }
    } finally {
      cleanup(repo);
    }
  }
});

test('MaxView-shaped install + bootstrap keeps scope exact and generates clean project-specific adapters', () => {
  const repo = makeRepo(makeMaxViewCleanInstallFixture());
  try {
    const { lock } = installAndBootstrap(repo, ['ui-lab', 'to-prd', 'grill-with-docs']);
    const expectedScope = ['grill-with-docs', 'post-skill-bootstrap', 'to-prd', 'ui-lab', 'update-changelog'];
    assert.deepEqual(Object.keys(lock.skills).sort(), expectedScope);
    assert.deepEqual(
      fs.readdirSync(path.join(repo, '.cursor/skills')).sort(),
      expectedScope,
    );

    const catalog = loadCatalog(PKG_ROOT);
    for (const skillName of expectedScope) {
      assertManagedFilesInstalledAndTracked(repo, lock, findSkill(catalog, skillName));
    }

    const uiLabText = fs.readFileSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'), 'utf8');
    const toPrdText = fs.readFileSync(path.join(repo, '.cursor/skills/to-prd/SKILL.md'), 'utf8');
    const grillText = fs.readFileSync(path.join(repo, '.cursor/skills/grill-with-docs/SKILL.md'), 'utf8');
    const bootstrapText = fs.readFileSync(path.join(repo, '.cursor/skills/post-skill-bootstrap/SKILL.md'), 'utf8');
    const changelogText = fs.readFileSync(path.join(repo, '.cursor/skills/update-changelog/SKILL.md'), 'utf8');
    const combined = [uiLabText, toPrdText, grillText, bootstrapText, changelogText].join('\n');

    assert.match(combined, /MaxView/);
    assert.doesNotMatch(combined, /MatterWorx/);

    assert.match(uiLabText, /--color-primary/);
    assert.match(uiLabText, /#123456/);
    assert.doesNotMatch(uiLabText, /--broken-token/);
    assert.doesNotMatch(uiLabText, /\{ color: red \}/);
    assert.doesNotMatch(uiLabText, /--docs-token/);
    assert.doesNotMatch(uiLabText, /--wwwroot-token/);

    assert.match(toPrdText, /MaxView/);
    assert.match(grillText, /PBI/);
    assert.match(grillText, /TBI/);
    assert.match(bootstrapText, /CONTEXT-MAP\.md/);
    assert.match(bootstrapText, /AGENTS\.md/);
  } finally {
    cleanup(repo);
  }
});

test('MatterWorx-shaped install + bootstrap keeps review dependencies clean and rooted in top-level docs', () => {
  const repo = makeRepo(makeMatterWorxCleanInstallFixture());
  try {
    const requested = [
      'prd-spec-review',
      'design-spec-review',
      'to-prd',
      'prd-design-spec',
    ];
    const { lock } = installAndBootstrap(repo, requested);
    const expectedScope = [...ensureAlwaysInstallSkills(requested)].sort();

    assert.deepEqual(Object.keys(lock.skills).sort(), expectedScope);
    assert.deepEqual(
      fs.readdirSync(path.join(repo, '.cursor/skills')).sort(),
      expectedScope,
    );

    const catalog = loadCatalog(PKG_ROOT);
    for (const skillName of expectedScope) {
      assertManagedFilesInstalledAndTracked(repo, lock, findSkill(catalog, skillName));
    }

    const reviewCompanions = [
      '.cursor/skills/prd-spec-review/rubric.md',
      '.cursor/skills/prd-spec-review/scorecard-template.md',
      '.cursor/skills/design-spec-review/rubric.md',
      '.cursor/skills/design-spec-review/scorecard-template.md',
    ];
    for (const rel of reviewCompanions) {
      assert.ok(fs.existsSync(path.join(repo, rel)), `missing review companion ${rel}`);
      const [, , skillName] = rel.split('/');
      assert.ok(lock.skills[skillName].managedFiles[rel], `lockfile missing hash for ${rel}`);
    }

    const skillTexts = expectedScope.map((skillName) =>
      fs.readFileSync(path.join(repo, '.cursor/skills', skillName, 'SKILL.md'), 'utf8')
    );
    const combined = skillTexts.join('\n');
    const nonInstructionalUnfilledSlots = [...combined.matchAll(/APEX:unfilled\(([^)]+)\)/g)]
      .map((match) => match[1])
      .filter((slot) => slot !== 'slotName');

    assert.match(combined, /MatterWorx/);
    assert.match(combined, /CONTEXT-MAP\.md/);
    assert.match(combined, /AGENTS\.md/);
    assert.doesNotMatch(combined, /Docker Port/);
    assert.doesNotMatch(combined, /\b5432\b/);
    assert.doesNotMatch(combined, /infra\/shared-async\.tf/);

    assert.deepEqual(nonInstructionalUnfilledSlots.sort(), ['changelogFile']);
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
