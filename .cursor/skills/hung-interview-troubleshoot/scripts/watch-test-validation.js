#!/usr/bin/env node
/**
 * Poll diagnose-test-validation.js until test-cases + validation look terminal
 * (or max polls). Use while regenerating after deploy.
 *
 * Usage:
 *   node watch-test-validation.js --env dev <prdId>
 *   node watch-test-validation.js --env dev --interval 20 --max 60 <prdId>
 */
const { spawnSync } = require('child_process');
const path = require('path');

function parseArgs(argv) {
  let env = 'dev';
  let intervalSec = 20;
  let maxPolls = 45;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--env' || argv[i] === '-e') && argv[i + 1]) {
      env = argv[++i];
      continue;
    }
    if (argv[i] === '--interval' && argv[i + 1]) {
      intervalSec = Number(argv[++i]);
      continue;
    }
    if (argv[i] === '--max' && argv[i + 1]) {
      maxPolls = Number(argv[++i]);
      continue;
    }
    rest.push(argv[i]);
  }
  return { env, intervalSec, maxPolls, prdId: rest[0] };
}

function once(env, prdId) {
  const r = spawnSync(
    'node',
    [path.join(__dirname, 'diagnose-test-validation.js'), '--env', env, prdId],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const lines = out.split(/\r?\n/);
  let dump = false;
  for (const line of lines) {
    if (line.startsWith('===')) dump = true;
    if (dump) console.log(line);
  }
  return out;
}

function extractVerdict(out) {
  const m = out.match(/=== VERDICT ===\s*(\{[\s\S]*?\n\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function isTerminal(verdict, out) {
  if (!verdict) return false;
  const tc = verdict.test_cases_status;
  const prd = verdict.prd_status;
  if (tc === 'failed') return true;
  if (tc === 'ready' && verdict.test_cases_has_json) {
    // validation may still be starting
    if (verdict.validation_score != null || verdict.has_scorecard) return true;
    if (prd && !['validating', 'generating'].includes(prd) && verdict.validation_thread) {
      // validation kicked then finished or aborted
      if (verdict.validation_thread_status === 'idle' || /validation_score/.test(out)) {
        return verdict.validation_score != null || prd === 'pending_review' || prd === 'draft';
      }
    }
  }
  if (/Worker execution failed|workspace-preparation-failed|materialization-unavailable/.test(out)) {
    return true;
  }
  return false;
}

async function main() {
  const { env, intervalSec, maxPolls, prdId } = parseArgs(process.argv.slice(2));
  if (!prdId) {
    console.error(
      'Usage: watch-test-validation.js --env dev [--interval 20] [--max 45] <prdId>',
    );
    process.exit(2);
  }

  for (let i = 0; i < maxPolls; i++) {
    console.log(`\n--- poll ${i + 1}/${maxPolls} ${new Date().toISOString()} ---`);
    const out = once(env, prdId);
    const verdict = extractVerdict(out);
    if (verdict) {
      console.log('verdict snapshot:', JSON.stringify(verdict));
    }
    if (i > 0 && isTerminal(verdict, out)) {
      console.log('\nTerminal-ish state — stop watching. Re-run diagnose for full dump.');
      break;
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
