#!/usr/bin/env node
/**
 * Fast PRD/worker failure check (DEV).
 *
 * Usage:
 *   node diagnose-prd.js --env dev <prdId>
 *   node _tmp-watch-prd.js --env dev <prdId>   # poll every 15s until terminal
 */
const { spawnSync } = require('child_process');
const path = require('path');

const prdId = process.argv.filter((a) => !a.startsWith('-')).slice(-1)[0];
const envIdx = process.argv.indexOf('--env');
const env = envIdx >= 0 ? process.argv[envIdx + 1] : 'dev';
const watch = process.argv.includes('--watch');

if (!prdId || prdId.includes('watch') || prdId.includes('_tmp')) {
  console.error('Usage: node _tmp-watch-prd.js [--watch] --env dev <prdId>');
  process.exit(2);
}

function once() {
  const r = spawnSync(
    'node',
    [path.join(__dirname, 'diagnose-prd.js'), '--env', env, prdId],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // Print compact summary lines
  const lines = out.split(/\r?\n/);
  let dump = false;
  for (const line of lines) {
    if (line.startsWith('===')) dump = true;
    if (dump) console.log(line);
  }
  return out;
}

function isTerminal(out) {
  return (
    /"status": "(failed|completed|cancelled)"/.test(out)
    || /"status": "draft"/.test(out) && /"content_len": [1-9]/.test(out)
    || /Worker execution failed/.test(out)
    || /"status": "draft"/.test(out) && /AGENT RUNS[\s\S]*"status": "failed"/.test(out)
  );
}

(async () => {
  if (!watch) {
    once();
    return;
  }
  for (let i = 0; i < 40; i++) {
    console.log(`\n--- poll ${i + 1} ${new Date().toISOString()} ---`);
    const out = once();
    if (i > 0 && isTerminal(out)) {
      console.log('\nTerminal state reached — stop watching.');
      break;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
