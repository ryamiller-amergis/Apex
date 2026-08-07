#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'apex-skills.mjs');
const repoPaths = process.argv.slice(2).map((repo) => path.resolve(repo));

if (repoPaths.length === 0) {
  console.error(
    'Usage: node foundation-skills/scripts/consumer-regression.mjs <repo> [repo...]',
  );
  process.exit(1);
}

const results = [];
for (const sourceRepo of repoPaths) {
  results.push(runConsumerRegression(sourceRepo));
}
console.log(JSON.stringify({ ok: true, results }, null, 2));

function runConsumerRegression(sourceRepo) {
  if (!fs.existsSync(path.join(sourceRepo, '.git'))) {
    throw new Error(`Not a git repository: ${sourceRepo}`);
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-consumer-pilot-'));
  const clone = path.join(tempRoot, path.basename(sourceRepo));
  const skills = ['ui-lab', 'to-prd', 'post-skill-bootstrap'];

  try {
    execFileSync(
      'git',
      [
        '-c',
        'core.longpaths=true',
        'clone',
        '--quiet',
        '--no-hardlinks',
        sourceRepo,
        clone,
      ],
      { stdio: 'pipe' },
    );
    const hadNpmrc = fs.existsSync(path.join(clone, '.npmrc'));

    runCli(clone, ['install', ...skills, '--skip-feed', '--skip-apex-check']);
    assertClean(clone);

    const uiLab = path.join(clone, '.cursor', 'skills', 'ui-lab', 'SKILL.md');
    let text = fs.readFileSync(uiLab, 'utf8');
    text = text
      .replace(
        /^description:.*$/m,
        'description: TEAM ATTEMPTED FOUNDATION OVERRIDE',
      )
      .replace(
        '<!-- APEX:END adapter -->',
        'TEAM_PROJECT_RULE\n<!-- APEX:END adapter -->',
      );
    fs.writeFileSync(uiLab, text, 'utf8');

    runCli(clone, ['install', ...skills, '--skip-feed', '--skip-apex-check']);
    const updated = fs.readFileSync(uiLab, 'utf8');
    assert(
      !updated.includes('TEAM ATTEMPTED FOUNDATION OVERRIDE'),
      'foundation frontmatter was not restored',
    );
    assert(
      updated.includes('TEAM_PROJECT_RULE'),
      'project-owned adapter content was overwritten',
    );
    assertClean(clone);

    const companion = path.join(
      clone,
      '.cursor',
      'skills',
      'to-prd',
      'backlog-schema.json',
    );
    fs.rmSync(companion);
    const drift = runCliStatus(clone, ['check']);
    assert(drift.status !== 0, 'check did not fail after deleting a managed companion');

    runCli(clone, ['install', ...skills, '--skip-feed', '--skip-apex-check']);
    assertClean(clone);
    assert(
      fs.existsSync(path.join(clone, '.npmrc')) === hadNpmrc,
      'regression flow changed .npmrc presence',
    );

    return {
      repository: path.basename(sourceRepo),
      installedSkills: skills,
      ownershipPreserved: true,
      missingCompanionDetected: true,
      finalCheckClean: true,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runCli(cwd, args) {
  execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

function runCliStatus(cwd, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
}

function assertClean(cwd) {
  const result = runCliStatus(cwd, ['check']);
  assert(
    result.status === 0,
    `check failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
