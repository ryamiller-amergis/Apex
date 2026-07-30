import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrapSkill } from '../lib/bootstrap.mjs';
import { collectEvidence, gatherFiles, globToRegExp } from '../lib/evidence.mjs';
import { cmdBootstrap } from '../lib/commands.mjs';
import { executeInstall } from '../lib/install.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

test('globToRegExp handles **, *, and {a,b}', () => {
  assert.equal(globToRegExp('**/*.css').test('src/a/b/theme.css'), true);
  assert.equal(globToRegExp('src/**/components/**/*.{tsx,jsx}').test('src/client/components/x/Y.tsx'), true);
  assert.equal(globToRegExp('package.json').test('package.json'), true);
  assert.equal(globToRegExp('**/*.css').test('src/theme.scss'), false);
});

test('bootstrap fills slots from real evidence with sources', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const boot = bootstrapSkill(PKG_ROOT, repo, 'ui-lab');
    const skill = boot.files['SKILL.md'];
    assert.match(skill, /project-blue/);
    assert.match(skill, /--color-primary/);
    assert.match(skill, /ShiftCard/);
    // Every filled slot has evidence with a source file.
    for (const explain of Object.values(boot.explain)) {
      for (const info of Object.values(explain)) {
        if (info.filled) {
          assert.ok(info.evidence.length > 0);
          assert.ok(info.evidence.every((e) => e.source && e.source.file));
        }
      }
    }
  } finally {
    cleanup(repo);
  }
});

test('missing signals render TODO placeholders, not blanks', () => {
  const repo = makeRepo({ 'package.json': JSON.stringify({ name: 'bare' }) });
  try {
    const boot = bootstrapSkill(PKG_ROOT, repo, 'ui-lab');
    const skill = boot.files['SKILL.md'];
    assert.match(skill, /TODO\(designTokens\)/);
    assert.match(skill, /TODO\(components\)/);
    // projectName is present though.
    assert.match(skill, /bare/);
  } finally {
    cleanup(repo);
  }
});

test('deterministic: two runs produce identical output', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const a = bootstrapSkill(PKG_ROOT, repo, 'ui-lab').files['SKILL.md'];
    const b = bootstrapSkill(PKG_ROOT, repo, 'ui-lab').files['SKILL.md'];
    assert.equal(a, b);
  } finally {
    cleanup(repo);
  }
});

test('enrich is off by default and does not fabricate', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const boot = bootstrapSkill(PKG_ROOT, repo, 'ui-lab', { enrich: false });
    assert.equal(boot.meta.enriched, false);
  } finally {
    cleanup(repo);
  }
});

test('apex-skill.json contract is copied verbatim (no slots processed)', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const boot = bootstrapSkill(PKG_ROOT, repo, 'ui-lab');
    const contract = JSON.parse(boot.files['apex-skill.json']);
    assert.equal(contract.skill, 'ui-lab');
    assert.equal(contract.apiVersion, 1);
  } finally {
    cleanup(repo);
  }
});

test('file-count cap degrades gracefully with capHit flag', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    const recipe = { skill: 'x', scanScope: 'full-repo', detectors: ['stack'], capFiles: 1 };
    const { capHit } = gatherFiles(repo, recipe);
    assert.equal(capHit, true);
    const res = collectEvidence(repo, recipe);
    assert.equal(res.meta.capHit, true);
  } finally {
    cleanup(repo);
  }
});

test('bootstrap command writes filled adapter content to disk', () => {
  const repo = makeRepo({ 'package.json': JSON.stringify({ name: 'bare' }) });
  const logs = [];
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const adapterPath = path.join(repo, '.cursor/skills/ui-lab/SKILL.md');
    assert.match(fs.readFileSync(adapterPath, 'utf8'), /TODO\(designTokens\)/);

    fs.mkdirSync(path.join(repo, 'src/client/components'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'src/client/App.css'),
      ':root { --color-primary: #0b5fff; --bg-primary: #ffffff; }\n',
    );
    fs.writeFileSync(
      path.join(repo, 'src/client/components/Button.tsx'),
      'export const Button = () => null;\n',
    );

    const code = cmdBootstrap({ _: ['ui-lab'], explain: true, package: PKG_ROOT, cwd: repo }, (m) => logs.push(m));
    assert.equal(code, 0);

    const after = fs.readFileSync(adapterPath, 'utf8');
    assert.match(after, /--color-primary/);
    assert.match(after, /Button/);
    assert.doesNotMatch(after, /TODO\(designTokens\)/);
    assert.doesNotMatch(after, /TODO\(components\)/);
    assert.ok(logs.some((l) => /wrote \d+ file/.test(l)));
  } finally {
    cleanup(repo);
  }
});
