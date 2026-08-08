import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

test('consumer regression runner validates an isolated git clone end to end', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=APEX Test',
        '-c',
        'user.email=apex-test@example.com',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
      { cwd: repo },
    );

    const output = execFileSync(
      process.execPath,
      [
        path.join(PKG_ROOT, 'scripts', 'consumer-regression.mjs'),
        repo,
      ],
      { cwd: PKG_ROOT, encoding: 'utf8' },
    );
    const result = JSON.parse(output);

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].ownershipPreserved, true);
    assert.equal(result.results[0].missingCompanionDetected, true);
    assert.equal(result.results[0].finalCheckClean, true);
  } finally {
    cleanup(repo);
  }
});
