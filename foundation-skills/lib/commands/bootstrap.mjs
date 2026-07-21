/**
 * bootstrap command — re-run adapter pre-fill for named skills (or all installed)
 */

import { bootstrapAll } from '../bootstrapper.mjs';
import { readLockfile }  from '../lockfile.mjs';
import { allSkillIds }   from '../catalog-loader.mjs';
import { existsSync }    from 'node:fs';
import { join }          from 'node:path';
import { ADAPTER_DEST, repoPath } from '../paths.mjs';

export async function bootstrap({ skills = null, explain = false, enrich = false, repoRoot = process.cwd() } = {}) {
  const lock    = readLockfile(repoRoot);
  const installed = lock?.selectedSkills ?? [];
  const toRun   = skills ?? (installed.length ? installed : allSkillIds());

  if (!toRun.length) {
    console.log('\nNo skills to bootstrap. Pass skill ids or run install first.\n');
    return;
  }

  console.log(`\nBootstrapping ${toRun.length} adapter(s)...\n`);

  const results = await bootstrapAll(toRun, repoRoot, {
    dryRun: false,
    explain,
    enrich,
    onProgress: (evt) => {
      if (evt.status === 'start') process.stdout.write(`  ${evt.skill}: scanning...`);
      if (evt.status === 'done') {
        const todos = evt.todoCount > 0 ? ` (${evt.todoCount} TODO placeholders)` : '';
        process.stdout.write(`\r  ${evt.skill}: done${todos}        \n`);
      }
    },
  });

  if (explain) {
    console.log('\n--- Explain output ---');
    for (const r of results) {
      if (!r.explains?.length) continue;
      console.log(`\n${r.skillId}:`);
      for (const e of r.explains) {
        console.log(`  {{${e.slot}}}: "${e.value.slice(0, 80)}…"`);
        console.log(`    sources: ${e.sources.join(', ')}`);
      }
    }
    console.log('');
  }

  const total   = results.length;
  const withTodo = results.filter(r => r.todoCount > 0).length;
  console.log(`\nBootstrap complete: ${total} adapter(s). ${withTodo} have TODO placeholders to fill.\n`);
}
