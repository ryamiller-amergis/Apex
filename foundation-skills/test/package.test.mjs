import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePackage } from '../lib/validatePackage.mjs';
import { loadCatalog } from '../lib/catalog.mjs';
import { checkRepo } from '../lib/check.mjs';
import { runDoctor, formatDoctor } from '../lib/doctor.mjs';
import { executeInstall } from '../lib/install.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

function copyPackageFixture(tmpRoot) {
  const dst = path.join(tmpRoot, 'pkg');
  fs.cpSync(PKG_ROOT, dst, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes(`${path.sep}test${path.sep}`),
  });
  return dst;
}

test('the shipped package validates cleanly', () => {
  const result = validatePackage(PKG_ROOT);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('catalog and duplicated contracts reflect corrected skill dependencies', () => {
  const catalog = loadCatalog(PKG_ROOT);
  const byName = Object.fromEntries(catalog.skills.map((entry) => [entry.name, entry]));
  const readContract = (skill) => JSON.parse(
    fs.readFileSync(path.join(PKG_ROOT, 'adapters', skill, 'apex-skill.json'), 'utf8'),
  );

  assert.deepEqual(byName['prd-spec-review'].dependsOn, ['to-prd']);
  assert.deepEqual(byName['design-spec-review'].dependsOn, ['prd-design-spec', 'to-prd']);
  assert.deepEqual(byName['dev-orchestrator'].dependsOn, ['to-prd']);
  assert.deepEqual(byName['azure-async-infra'].dependsOn, ['terraform-infra']);

  assert.deepEqual(byName['prd-design-spec'].dependsOn, ['to-prd']);
  assert.deepEqual(byName['create-test-case'].dependsOn, ['to-prd']);

  assert.deepEqual(readContract('prd-spec-review').dependsOn, ['to-prd']);
  assert.deepEqual(readContract('design-spec-review').dependsOn, ['prd-design-spec', 'to-prd']);
  assert.deepEqual(readContract('dev-orchestrator').dependsOn, ['to-prd']);
  assert.deepEqual(readContract('azure-async-infra').dependsOn, ['terraform-infra']);
  assert.deepEqual(readContract('prd-design-spec').dependsOn, ['to-prd']);
  assert.deepEqual(readContract('create-test-case').dependsOn, ['to-prd']);
});

test('adr-finalize metadata marks adr-template foundation-owned and managed by contract', () => {
  const catalog = loadCatalog(PKG_ROOT);
  const skill = catalog.skills.find((entry) => entry.name === 'adr-finalize');
  const contract = JSON.parse(
    fs.readFileSync(path.join(PKG_ROOT, 'adapters/adr-finalize/apex-skill.json'), 'utf8'),
  );

  assert.deepEqual(skill.foundationFiles, ['SKILL.md', 'adr-template.md']);
  assert.deepEqual(skill.adapterFiles, ['SKILL.md', 'apex-skill.json', 'recipe.json']);
  assert.equal(skill.supportingOwners['adr-template.md'], 'foundation');
  assert.ok(contract.managedFiles.includes('adr-template.md'));
});

test('no-project-context lint catches a foreign reference in a foundation', () => {
  // Copy package to temp, inject a MaxView reference into a foundation file.
  const tmp = makeRepo({});
  try {
    const dst = copyPackageFixture(tmp);
    const foundation = path.join(dst, 'foundation/ui-lab/SKILL.md');
    fs.appendFileSync(foundation, '\nUse the MaxView color palette.\n');
    const result = validatePackage(dst);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /foreign-project reference/.test(e)));
  } finally {
    cleanup(tmp);
  }
});

test('package validation catches contract dependsOn drift', () => {
  const tmp = makeRepo({});
  try {
    const dst = copyPackageFixture(tmp);
    const contractPath = path.join(dst, 'adapters/prd-spec-review/apex-skill.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    contract.dependsOn = [];
    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n', 'utf8');

    const result = validatePackage(dst);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /prd-spec-review.*contract dependsOn/i.test(e)));
  } finally {
    cleanup(tmp);
  }
});

test('package validation requires contract dependsOn when catalog dependencies exist', () => {
  const tmp = makeRepo({});
  try {
    const dst = copyPackageFixture(tmp);
    const contractPath = path.join(dst, 'adapters/prd-spec-review/apex-skill.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    delete contract.dependsOn;
    fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n', 'utf8');

    const result = validatePackage(dst);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /prd-spec-review.*must declare dependsOn/i.test(e)));
  } finally {
    cleanup(tmp);
  }
});

test('package validation catches undeclared hard cross-skill runtime references', () => {
  const tmp = makeRepo({});
  try {
    const dst = copyPackageFixture(tmp);
    const skillPath = path.join(dst, 'adapters/ui-lab/SKILL.md');
    fs.appendFileSync(
      skillPath,
      '\nHard dependency: `{{slot:skillsDir}}to-prd/backlog-schema.json`\n',
      'utf8',
    );

    const result = validatePackage(dst);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /ui-lab.*to-prd\/backlog-schema\.json.*dependsOn/i.test(e)));
  } finally {
    cleanup(tmp);
  }
});

test('package validation still treats explicit skillsDir refs as hard dependencies near optional prose', () => {
  const tmp = makeRepo({});
  try {
    const dst = copyPackageFixture(tmp);
    const skillPath = path.join(dst, 'adapters/ui-lab/SKILL.md');
    fs.appendFileSync(
      skillPath,
      '\nOptional docs: `{{slot:skillsDir}}to-prd/backlog-schema.json` when available\n',
      'utf8',
    );

    const result = validatePackage(dst);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /ui-lab.*to-prd\/backlog-schema\.json.*dependsOn/i.test(e)));
  } finally {
    cleanup(tmp);
  }
});

test('package validation catches missing referenced sibling runtime assets', () => {
  const tmp = makeRepo({});
  try {
    const dst = copyPackageFixture(tmp);
    fs.rmSync(path.join(dst, 'adapters/prd-spec-review/scorecard-template.md'));

    const result = validatePackage(dst);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /prd-spec-review.*scorecard-template\.md.*missing/i.test(e)));
  } finally {
    cleanup(tmp);
  }
});

test('package validation suppresses optional bare runtime references and .ai-pilot outputs', () => {
  const tmp = makeRepo({});
  try {
    const dst = copyPackageFixture(tmp);
    const skillPath = path.join(dst, 'adapters/ui-lab/SKILL.md');
    fs.appendFileSync(
      skillPath,
      '\nOptional note: `to-prd/backlog-schema.json` (if present)\n'
      + 'Advisory note: `to-prd/backlog-schema.json` optional\n'
      + 'Workflow note: `to-prd/backlog-schema.json` when available beside `.ai-pilot/output/{slug}.backlog.json`\n',
      'utf8',
    );

    const result = validatePackage(dst);
    assert.equal(result.ok, true);
  } finally {
    cleanup(tmp);
  }
});

test('doctor passes hard runtime prerequisites when registry/feed checks are skipped', () => {
  const result = runDoctor({ requireRegistry: false, requireFeed: false });
  assert.equal(result.ok, true);
  assert.ok(result.checks.find((c) => c.id === 'node').ok);
  assert.equal(result.checks.find((c) => c.id === 'apex-registry'), undefined);
  assert.equal(result.checks.find((c) => c.id === 'feed'), undefined);
});

test('doctor hard-fails when project has no @apex:registry', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.cursor/rules/.gitkeep': '',
  });
  try {
    const result = runDoctor({
      repoRoot: repo,
      requireRegistry: true,
      requireFeed: false, // isolate registry gate from network
    });
    assert.equal(result.ok, false);
    const reg = result.checks.find((c) => c.id === 'apex-registry');
    assert.ok(reg);
    assert.equal(reg.ok, false);
    assert.equal(reg.hard, true);
    assert.match(reg.remediation, /@apex:registry=/);
    assert.match(reg.remediation, /init-registry/);
    assert.match(reg.remediation, /vsts-npm-auth/);
    assert.match(formatDoctor(result), /Hard prerequisites missing/);
  } finally {
    cleanup(repo);
  }
});

test('doctor mentions .npmrc.template when present but local .npmrc lacks @apex', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.npmrc.template':
      '@maxview:registry=https://pkgs.dev.azure.com/amergis/MaxView/_packaging/maxview-core/npm/registry/\n' +
      '@apex:registry=https://pkgs.dev.azure.com/amergis/_packaging/apex-skills/npm/registry/\n' +
      'always-auth=true\n',
  });
  try {
    const result = runDoctor({
      repoRoot: repo,
      requireRegistry: true,
      requireFeed: false,
    });
    assert.equal(result.ok, false);
    const reg = result.checks.find((c) => c.id === 'apex-registry');
    assert.match(reg.detail, /npmrc\.template/);
    assert.match(reg.remediation, /init-registry/);
  } finally {
    cleanup(repo);
  }
});

test('doctor passes apex-registry when .npmrc defines @apex:registry', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.npmrc':
      '@apex:registry=https://pkgs.dev.azure.com/example/_packaging/apex-skills/npm/registry/\n' +
      'always-auth=true\n',
  });
  try {
    const result = runDoctor({
      repoRoot: repo,
      requireRegistry: true,
      requireFeed: false,
    });
    const reg = result.checks.find((c) => c.id === 'apex-registry');
    assert.ok(reg?.ok);
    assert.match(reg.detail, /pkgs\.dev\.azure\.com\/example/);
    // Feed skipped — only registry was required
    assert.equal(result.ok, true);
  } finally {
    cleanup(repo);
  }
});

test('check reports installed vs available after install', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const res = checkRepo(PKG_ROOT, repo);
    assert.equal(res.installed, true);
    assert.equal(res.installedSuite, '2.0.2');
    assert.equal(res.skills[0].name, 'ui-lab');
    assert.equal(res.skills[0].compatible, true);
    assert.equal(res.skills[0].drift, false);
  } finally {
    cleanup(repo);
  }
});
