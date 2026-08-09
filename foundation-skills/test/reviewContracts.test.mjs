import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeInstall } from '../lib/install.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

function extractCrossCuttingIds(markdown) {
  return [...markdown.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((match) => match[1]);
}

function extractJsonCrossCuttingIds(markdown) {
  const objectMatch = markdown.match(
    /"cross_cutting_checks":\s*\{([\s\S]*?)\n\s*\},\n\s*"accepted_gaps"/m,
  );
  assert.ok(objectMatch, 'scorecard template must define cross_cutting_checks');
  return [...objectMatch[1].matchAll(/^\s+"([a-z0-9_]+)":\s*\{/gm)].map((match) => match[1]);
}

function assertProjectAgnostic(text, label) {
  assert.doesNotMatch(text, /\bApex\b/i, `${label} should not mention Apex`);
  assert.doesNotMatch(text, /\bMaxView\b/i, `${label} should not mention MaxView`);
  assert.doesNotMatch(text, /\bMatterWorx\b/i, `${label} should not mention MatterWorx`);
  assert.doesNotMatch(text, /\bgroups enum\b/i, `${label} should not mention product-specific group enums`);
}

test('installed PRD review companions stay project-agnostic and keep rubric/template cross-cutting contracts aligned', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['prd-spec-review']);

    const rubricPath = path.join(repo, '.cursor/skills/prd-spec-review/rubric.md');
    const templatePath = path.join(repo, '.cursor/skills/prd-spec-review/scorecard-template.md');
    const rubric = fs.readFileSync(rubricPath, 'utf8');
    const template = fs.readFileSync(templatePath, 'utf8');

    assertProjectAgnostic(rubric, 'PRD rubric');
    assertProjectAgnostic(template, 'PRD scorecard template');

    const rubricIds = extractCrossCuttingIds(rubric);
    const humanTemplateIds = extractCrossCuttingIds(template);
    const jsonTemplateIds = extractJsonCrossCuttingIds(template);

    assert.deepEqual(humanTemplateIds, rubricIds);
    assert.deepEqual(jsonTemplateIds, rubricIds);
    assert.ok(rubricIds.includes('feature_pbi_persona_alignment'));
    assert.ok(rubricIds.includes('dependency_locality'));
    assert.ok(rubricIds.includes('implementation_phase_coverage'));
  } finally {
    cleanup(repo);
  }
});

test('installed design review companions stay project-agnostic and keep rubric/template cross-cutting contracts aligned', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['design-spec-review']);

    const rubricPath = path.join(repo, '.cursor/skills/design-spec-review/rubric.md');
    const templatePath = path.join(repo, '.cursor/skills/design-spec-review/scorecard-template.md');
    const rubric = fs.readFileSync(rubricPath, 'utf8');
    const template = fs.readFileSync(templatePath, 'utf8');

    assertProjectAgnostic(rubric, 'Design rubric');
    assertProjectAgnostic(template, 'Design scorecard template');

    const rubricIds = extractCrossCuttingIds(rubric);
    const humanTemplateIds = extractCrossCuttingIds(template);
    const jsonTemplateIds = extractJsonCrossCuttingIds(template);

    assert.deepEqual(humanTemplateIds, rubricIds);
    assert.deepEqual(jsonTemplateIds, rubricIds);
    assert.ok(rubricIds.includes('work_item_coverage'));
    assert.ok(rubricIds.includes('ac_scenario_coverage'));
    assert.ok(rubricIds.includes('warning_consolidation'));
  } finally {
    cleanup(repo);
  }
});
