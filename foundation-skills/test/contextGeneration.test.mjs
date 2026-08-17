import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapSkill, loadRecipe } from '../lib/bootstrap.mjs';
import { collectEvidence } from '../lib/evidence.mjs';
import { PKG_ROOT, makeRepo, cleanup } from './helpers.mjs';

function makeMaxViewFixture(overrides = {}) {
  return {
    'package.json': JSON.stringify(
      {
        name: 'timeclock',
        private: true,
      },
      null,
      2,
    ) + '\n',
    'AGENTS.md': `# MaxView

Workforce management platform for timekeeping, scheduling, credentialing, and staffing operations.

## Directory Structure

| Path | Purpose |
| --- | --- |
| src/ | Application code |
| docs/ | Supporting documentation |

## Key Terminology

| Term | Meaning |
| --- | --- |
| **PBI** | Product Backlog Item |
| **TBI** | Technical Backlog Item |
| **RBAC** | Role-Based Access Control |
`,
    'CONTEXT-MAP.md': `# MaxView Context Map

## Contexts

- TimeClock
- MaxHub
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
    ...overrides,
  };
}

function makeMatterWorxFixture(overrides = {}) {
  return {
    'package.json': JSON.stringify(
      {
        name: 'matterworx',
        private: true,
      },
      null,
      2,
    ) + '\n',
    'AGENTS.md': `# MatterWorx Monorepo

Vendor management system for healthcare staffing operations.
`,
    'CONTEXT-MAP.md': `# MatterWorx Context Map

Primary domain docs live here.
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
    ...overrides,
  };
}

function makeApexFixture(overrides = {}) {
  return {
    'package.json': JSON.stringify(
      {
        name: 'apex-skills-test',
        description: 'Stale package metadata that must never be used as mission evidence.',
        private: true,
      },
      null,
      2,
    ) + '\n',
    'CONTEXT.md': `# Apex — Product Context Guide

## Application Summary

Apex is an internal product-building and project-management platform.
`,
    'AGENTS.md': `# AGENTS.md — Apex Agent Quick Reference

## Key Terminology

| Term | Meaning |
| --- | --- |
| **PRD** | Product Requirements Document |
`,
    ...overrides,
  };
}

function collectForRecipe(repo, recipe) {
  return collectEvidence(repo, recipe).entries;
}

function findEntry(entries, detector, key) {
  return entries.find((entry) => entry.detector === detector && entry.key === key) ?? null;
}

function assertNoMatch(entries, predicate, message) {
  assert.equal(entries.some(predicate), false, message);
}

test('stack detector prefers primary context H1 before AGENTS fallback and package name', () => {
  const repo = makeRepo(makeApexFixture());
  try {
    const entries = collectForRecipe(repo, {
      skill: 'stack-primary-context',
      scanScope: 'targeted',
      targetedGlobs: ['package.json', 'CONTEXT.md', 'AGENTS.md'],
      detectors: ['stack'],
    });

    const projectName = findEntry(entries, 'stack', 'projectName');
    assert.ok(projectName);
    assert.equal(projectName.value, 'Apex');
    assert.equal(projectName.source.file, 'CONTEXT.md');
  } finally {
    cleanup(repo);
  }
});

test('stack detector falls back to root AGENTS title when no primary context doc exists', () => {
  const repo = makeRepo(makeMaxViewFixture());
  try {
    const entries = collectForRecipe(repo, {
      skill: 'stack-only',
      scanScope: 'targeted',
      targetedGlobs: ['package.json', 'AGENTS.md'],
      detectors: ['stack'],
    });

    const projectName = findEntry(entries, 'stack', 'projectName');
    assert.ok(projectName);
    assert.equal(projectName.value, 'MaxView');
    assert.equal(projectName.source.file, 'AGENTS.md');
  } finally {
    cleanup(repo);
  }
});

test('stack detector normalizes root title and merges nested package framework signals', () => {
  const repo = makeRepo(makeMatterWorxFixture());
  try {
    const entries = collectForRecipe(repo, {
      skill: 'stack-monorepo',
      scanScope: 'targeted',
      targetedGlobs: ['package.json', 'AGENTS.md', 'frontend/package.json'],
      detectors: ['stack'],
    });

    const projectName = findEntry(entries, 'stack', 'projectName');
    assert.ok(projectName);
    assert.equal(projectName.value, 'MatterWorx');
    assert.equal(projectName.source.file, 'AGENTS.md');

    assert.ok(entries.some((entry) => entry.key === 'dep:next' && entry.source.file === 'frontend/package.json'));
    assert.ok(entries.some((entry) => entry.key === 'dep:react' && entry.source.file === 'frontend/package.json'));
    assert.ok(entries.some((entry) => entry.key === 'dep:tailwindcss' && entry.source.file === 'frontend/package.json'));
    assertNoMatch(entries, (entry) => entry.key === 'dep:webpack', 'unknown framework noise should stay out');
  } finally {
    cleanup(repo);
  }
});

test('repo-docs detector prefers root CONTEXT-MAP and root AGENTS over nested docs', () => {
  const repo = makeRepo(makeMaxViewFixture());
  try {
    const entries = collectForRecipe(repo, {
      skill: 'repo-docs',
      scanScope: 'targeted',
      targetedGlobs: ['AGENTS.md', 'CONTEXT-MAP.md', 'docs/AGENTS.md', 'docs/local-debug/CONTEXT.md'],
      detectors: ['repo-docs'],
    });

    const contextFile = findEntry(entries, 'repo-docs', 'contextFile');
    const agentsFile = findEntry(entries, 'repo-docs', 'agentsFile');

    assert.ok(contextFile);
    assert.equal(contextFile.value, 'CONTEXT-MAP.md');
    assert.equal(contextFile.source.file, 'CONTEXT-MAP.md');

    assert.ok(agentsFile);
    assert.equal(agentsFile.value, 'AGENTS.md');
    assert.equal(agentsFile.source.file, 'AGENTS.md');
  } finally {
    cleanup(repo);
  }
});

test('glossary detector only keeps explicit terminology rows and excludes nested local-debug docs', () => {
  const repo = makeRepo(makeMaxViewFixture());
  try {
    const recipe = loadRecipe(PKG_ROOT, 'grill-with-docs');
    const entries = collectForRecipe(repo, recipe);

    assert.ok(entries.some((entry) => entry.detector === 'glossary' && entry.key === 'PBI'));
    assert.ok(entries.some((entry) => entry.detector === 'glossary' && entry.key === 'TBI'));
    assertNoMatch(entries, (entry) => entry.detector === 'glossary' && entry.key === 'Term', 'table headers must be excluded');
    assertNoMatch(entries, (entry) => entry.detector === 'glossary' && entry.key === 'Path', 'non-terminology tables must be excluded');
    assertNoMatch(entries, (entry) => entry.detector === 'glossary' && /Docker Port/i.test(entry.key), 'local-debug rows must be excluded');
    assertNoMatch(
      entries,
      (entry) => entry.detector === 'glossary' && /MatterWorx/i.test(`${entry.key} ${entry.value}`),
      'cross-project terms must not leak into the glossary',
    );
  } finally {
    cleanup(repo);
  }
});

test('css variable detector filters noisy values and prefers canonical theme files', () => {
  const repo = makeRepo({
    'package.json': JSON.stringify({ name: 'theme-repo' }, null, 2) + '\n',
    'src/components/Button.module.css': ':root { --color-primary: hotpink; }\n',
    'src/styles/theme.css': [
      ':root {',
      '  --color-primary: #123456;',
      '  --text-primary: #222222;',
      '  --broken-token: { color: red };',
      `  --too-long: ${'x'.repeat(260)};`,
      '}',
      '',
    ].join('\n'),
    'wwwroot/css/site.css': ':root { --wwwroot-token: #ffffff; }\n',
    'docs/styles/tokens.css': ':root { --docs-token: #000000; }\n',
  });
  try {
    const recipe = loadRecipe(PKG_ROOT, 'ui-lab');
    const entries = collectForRecipe(repo, recipe);
    const colorPrimary = findEntry(entries, 'css-variables', '--color-primary');

    assert.ok(colorPrimary);
    assert.equal(colorPrimary.value, '#123456');
    assert.equal(colorPrimary.source.file, 'src/styles/theme.css');
    assertNoMatch(entries, (entry) => entry.detector === 'css-variables' && entry.key === '--broken-token', 'brace fragments must be rejected');
    assertNoMatch(entries, (entry) => entry.detector === 'css-variables' && entry.key === '--too-long', 'unreasonably long values must be rejected');
    assertNoMatch(entries, (entry) => entry.detector === 'css-variables' && entry.key === '--wwwroot-token', 'wwwroot files must be excluded');
    assertNoMatch(entries, (entry) => entry.detector === 'css-variables' && entry.key === '--docs-token', 'docs files must be excluded');
  } finally {
    cleanup(repo);
  }
});

test('review recipes discover root docs during bounded bootstrap scans', () => {
  const repo = makeRepo(makeMaxViewFixture());
  try {
    for (const skill of ['prd-spec-review', 'design-spec-review']) {
      const boot = bootstrapSkill(PKG_ROOT, repo, skill);
      const skillText = boot.files['SKILL.md'];

      assert.match(skillText, /MaxView/);
      assert.match(skillText, /CONTEXT-MAP\.md/);
      assert.match(skillText, /AGENTS\.md/);
      assert.doesNotMatch(skillText, /APEX:unfilled\(contextFile\)/);
      assert.doesNotMatch(skillText, /APEX:unfilled\(agentsFile\)/);
    }
  } finally {
    cleanup(repo);
  }
});
