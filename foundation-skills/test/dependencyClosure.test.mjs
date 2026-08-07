import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as installCommand from '../lib/commands/install.mjs';
import * as updateCommand from '../lib/commands/update.mjs';
import { cmdInstall } from '../lib/commands.mjs';
import { loadCatalog, resolveSkillDependencyClosure } from '../lib/catalog.mjs';
import { readLockfile } from '../lib/lockfile.mjs';
import { ensureAlwaysInstallSkills } from '../lib/alwaysInstall.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

function copyPackageFixture(tmpRoot) {
  const dst = path.join(tmpRoot, 'pkg');
  fs.cpSync(PKG_ROOT, dst, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes(`${path.sep}test${path.sep}`),
  });
  return dst;
}

function updateCatalogDependsOn(pkgRoot, skillName, dependsOn, suiteVersion = null) {
  const catalogPath = path.join(pkgRoot, 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const skill = catalog.skills.find((entry) => entry.name === skillName);
  assert.ok(skill, `catalog is missing ${skillName}`);
  skill.dependsOn = dependsOn;
  if (suiteVersion) {
    catalog.suiteVersion = suiteVersion;
    const packageJsonPath = path.join(pkgRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    packageJson.version = suiteVersion;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  }
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  const contractPath = path.join(pkgRoot, 'adapters', skillName, 'apex-skill.json');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  contract.dependsOn = dependsOn;
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2) + '\n', 'utf8');
}

test('resolveSkillDependencyClosure fails deterministically with an actionable cycle path', () => {
  const cyclicCatalog = {
    suiteVersion: '2.0.2',
    skills: [
      {
        name: 'skill-a',
        summary: 'A',
        scanScope: 'targeted',
        foundationFiles: ['SKILL.md'],
        adapterFiles: ['SKILL.md', 'apex-skill.json', 'recipe.json'],
        dependsOn: ['skill-b'],
      },
      {
        name: 'skill-b',
        summary: 'B',
        scanScope: 'targeted',
        foundationFiles: ['SKILL.md'],
        adapterFiles: ['SKILL.md', 'apex-skill.json', 'recipe.json'],
        dependsOn: ['skill-a'],
      },
    ],
  };

  const getCycleMessage = () => {
    try {
      resolveSkillDependencyClosure(cyclicCatalog, ['skill-a']);
      assert.fail('expected a dependency cycle error');
    } catch (error) {
      return error.message;
    }
  };

  const first = getCycleMessage();
  const second = getCycleMessage();

  assert.equal(first, 'Skill dependency cycle detected: skill-a -> skill-b -> skill-a');
  assert.equal(second, first);
});

test('cmdInstall expands prd-spec-review to its full dependency closure', () => {
  const repo = makeRepo(SAMPLE_REPO);
  const logs = [];
  try {
    const code = cmdInstall(
      { _: ['prd-spec-review'], cwd: repo, package: PKG_ROOT, skipFeed: true },
      (message) => logs.push(message),
    );

    assert.equal(code, 0, `install failed:\n${logs.join('\n')}`);
    const lock = readLockfile(repo);
    assert.deepEqual(
      Object.keys(lock.skills).sort(),
      ['post-skill-bootstrap', 'prd-spec-review', 'to-prd'],
    );
  } finally {
    cleanup(repo);
  }
});

test('cmdInstall expands design-spec-review transitively and keeps dependencies before dependents', () => {
  const repo = makeRepo(SAMPLE_REPO);
  const logs = [];
  try {
    const catalog = loadCatalog(PKG_ROOT);
    const resolved = ensureAlwaysInstallSkills(
      resolveSkillDependencyClosure(catalog, ['design-spec-review']),
    );
    assert.ok(
      resolved.indexOf('to-prd') < resolved.indexOf('prd-design-spec'),
      `expected to-prd before prd-design-spec, got ${resolved.join(', ')}`,
    );
    assert.ok(
      resolved.indexOf('prd-design-spec') < resolved.indexOf('design-spec-review'),
      `expected prd-design-spec before design-spec-review, got ${resolved.join(', ')}`,
    );

    const code = cmdInstall(
      { _: ['design-spec-review'], cwd: repo, package: PKG_ROOT, skipFeed: true },
      (message) => logs.push(message),
    );

    assert.equal(code, 0, `install failed:\n${logs.join('\n')}`);
    const lock = readLockfile(repo);
    const orderedSkills = Object.keys(lock.skills);

    assert.deepEqual(
      [...orderedSkills].sort(),
      ['design-spec-review', 'post-skill-bootstrap', 'prd-design-spec', 'to-prd'],
    );
  } finally {
    cleanup(repo);
  }
});

test('install command selection rejects an expanded dependency absent from authorizedSkills', () => {
  assert.equal(typeof installCommand.resolveInstallSkills, 'function');
  const catalog = loadCatalog(PKG_ROOT);

  assert.throws(
    () => installCommand.resolveInstallSkills({
      catalog,
      skills: ['prd-spec-review'],
      all: false,
      authorizedSkills: ['prd-spec-review', 'post-skill-bootstrap'],
    }),
    /to-prd|dependency|released|authorized/i,
  );
});

test('update command selection rejects an expanded dependency absent from authorizedSkills', () => {
  assert.equal(typeof updateCommand.resolveUpdateSkills, 'function');
  const catalog = loadCatalog(PKG_ROOT);

  assert.throws(
    () => updateCommand.resolveUpdateSkills({
      catalog,
      skills: ['design-spec-review'],
      authorizedSkills: ['design-spec-review', 'prd-design-spec', 'post-skill-bootstrap'],
    }),
    /to-prd|dependency|released|authorized/i,
  );
});

test('scoped reinstall updates the lockfile to a newer suite only after adding newly required dependencies', () => {
  const repo = makeRepo(SAMPLE_REPO);
  const pkgScratch = makeRepo({});
  const logs = [];
  try {
    const oldPkgRoot = copyPackageFixture(pkgScratch);
    updateCatalogDependsOn(oldPkgRoot, 'prd-spec-review', [], '2.0.1');

    let code = cmdInstall(
      { _: ['prd-spec-review'], cwd: repo, package: oldPkgRoot, skipFeed: true },
      (message) => logs.push(message),
    );
    assert.equal(code, 0, `old install failed:\n${logs.join('\n')}`);

    let lock = readLockfile(repo);
    assert.equal(lock.suiteVersion, '2.0.1');
    assert.deepEqual(
      Object.keys(lock.skills).sort(),
      ['post-skill-bootstrap', 'prd-spec-review'],
    );

    code = cmdInstall(
      { _: ['prd-spec-review'], cwd: repo, package: PKG_ROOT, skipFeed: true },
      (message) => logs.push(message),
    );
    assert.equal(code, 0, `updated install failed:\n${logs.join('\n')}`);

    lock = readLockfile(repo);
    assert.equal(lock.suiteVersion, '2.0.2');
    assert.deepEqual(
      Object.keys(lock.skills).sort(),
      ['post-skill-bootstrap', 'prd-spec-review', 'to-prd'],
    );
  } finally {
    cleanup(repo);
    cleanup(pkgScratch);
  }
});
