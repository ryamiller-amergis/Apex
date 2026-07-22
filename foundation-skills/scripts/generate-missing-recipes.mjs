#!/usr/bin/env node
/**
 * generate-missing-recipes.mjs
 *
 * Creates missing bootstrap-recipe.json and adapter-template.md files
 * for all skills in the catalog. Safe to re-run (skips existing files).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FOUNDATION_DIR = join(__dirname, '..', 'foundation');
const CATALOG_PATH   = join(__dirname, '..', 'catalog.json');

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
let created = 0;
let skipped = 0;

for (const entry of catalog.skills) {
  const name     = entry.name;
  const scope    = entry.scanScope ?? 'targeted';
  const skillDir = join(FOUNDATION_DIR, name);

  // bootstrap-recipe.json
  const recipePath = join(skillDir, 'bootstrap-recipe.json');
  if (!existsSync(recipePath)) {
    const detectors = scope === 'full-repo'
      ? ['stack', 'conventions', 'routes', 'terminology']
      : ['stack', 'conventions'];
    writeFileSync(recipePath, JSON.stringify({
      scanScope: scope,
      description: `Detect signals for the ${name} skill adapter`,
      detectors,
    }, null, 2) + '\n', 'utf-8');
    console.log(`  + ${name}/bootstrap-recipe.json`);
    created++;
  } else {
    skipped++;
  }

  // adapter-template.md
  const templatePath = join(skillDir, 'adapter-template.md');
  if (!existsSync(templatePath)) {
    const content = `---
name: ${name}
description: ${name} adapter for {{PROJECT_NAME:project name}}.
foundation: ${name}
foundationVersion: ">=1.0.0"
---

# ${name} — Project Adapter

Load the foundation:

\`\`\`
Read: .apex/foundation/${name}/SKILL.md
\`\`\`

## Project-specific context

TODO: Add project-specific context, conventions, file paths, and rules for this skill.
`;
    writeFileSync(templatePath, content, 'utf-8');
    console.log(`  + ${name}/adapter-template.md`);
    created++;
  } else {
    skipped++;
  }
}

console.log(`\nDone: ${created} file(s) created, ${skipped} skipped.\n`);
