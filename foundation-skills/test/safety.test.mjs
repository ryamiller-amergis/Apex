import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeInstall, planInstall } from '../lib/install.mjs';
import { checkRepo } from '../lib/check.mjs';
import { cmdCheck } from '../lib/commands.mjs';
import { assertWithin } from '../lib/util.mjs';
import { serializeLockfile } from '../lib/lockfile.mjs';
import { PKG_ROOT, makeRepo, cleanup, SAMPLE_REPO } from './helpers.mjs';

test('install transaction restores managed paths after a failure', async () => {
  const { withInstallTransaction } =
    await import('../lib/installTransaction.mjs');
  const repo = makeRepo({
    '.cursor/skills/ui-lab/SKILL.md': 'ORIGINAL_SKILL\n',
    'apex-skills.lock.json': 'ORIGINAL_LOCK\n',
  });
  try {
    assert.throws(
      () =>
        withInstallTransaction(repo, ['ui-lab'], () => {
          fs.writeFileSync(
            path.join(repo, '.cursor/skills/ui-lab/SKILL.md'),
            'PARTIAL_SKILL\n'
          );
          fs.writeFileSync(
            path.join(repo, 'apex-skills.lock.json'),
            'PARTIAL_LOCK\n'
          );
          fs.writeFileSync(
            path.join(repo, '.cursor/skills/ui-lab/partial.json'),
            '{}\n'
          );
          throw new Error('injected write failure');
        }),
      /injected write failure/
    );

    assert.equal(
      fs.readFileSync(
        path.join(repo, '.cursor/skills/ui-lab/SKILL.md'),
        'utf8'
      ),
      'ORIGINAL_SKILL\n'
    );
    assert.equal(
      fs.readFileSync(path.join(repo, 'apex-skills.lock.json'), 'utf8'),
      'ORIGINAL_LOCK\n'
    );
    assert.equal(
      fs.existsSync(path.join(repo, '.cursor/skills/ui-lab/partial.json')),
      false
    );
  } finally {
    cleanup(repo);
  }
});

test('rollback continues restoring critical files after one target fails', async () => {
  const { withInstallTransaction } =
    await import('../lib/installTransaction.mjs');
  const repo = makeRepo({
    '.cursor/skills/ui-lab/SKILL.md': 'ORIGINAL_SKILL\n',
    '.apex/backups/ui-lab/original.md': 'ORIGINAL_BACKUP\n',
    'apex-skills.lock.json': 'ORIGINAL_LOCK\n',
  });
  const originalCpSync = fs.cpSync;
  let failure;
  try {
    try {
      withInstallTransaction(repo, ['ui-lab'], () => {
        fs.writeFileSync(
          path.join(repo, '.cursor/skills/ui-lab/SKILL.md'),
          'PARTIAL_SKILL\n'
        );
        fs.writeFileSync(
          path.join(repo, 'apex-skills.lock.json'),
          'PARTIAL_LOCK\n'
        );
        fs.writeFileSync(
          path.join(repo, '.apex/backups/ui-lab/original.md'),
          'PARTIAL_BACKUP\n'
        );
        fs.cpSync = (source, destination, options) => {
          if (
            String(destination).includes(
              path.join('.apex', 'backups', 'ui-lab')
            )
          ) {
            throw new Error('injected backup restore failure');
          }
          return originalCpSync(source, destination, options);
        };
        throw new Error('injected install failure');
      });
    } catch (error) {
      failure = error;
    }
  } finally {
    fs.cpSync = originalCpSync;
  }

  try {
    assert.ok(failure);
    assert.match(failure.message, /Rollback also failed/);
    assert.ok(failure.recoverySnapshot);
    assert.equal(fs.existsSync(failure.recoverySnapshot), true);
    assert.equal(
      fs.readFileSync(
        path.join(repo, '.cursor/skills/ui-lab/SKILL.md'),
        'utf8'
      ),
      'ORIGINAL_SKILL\n'
    );
    assert.equal(
      fs.readFileSync(path.join(repo, 'apex-skills.lock.json'), 'utf8'),
      'ORIGINAL_LOCK\n'
    );
  } finally {
    if (failure?.recoverySnapshot) cleanup(failure.recoverySnapshot);
    cleanup(repo);
  }
});

test('concurrent installs are rejected by the repository install lock', async () => {
  const { withInstallTransaction } =
    await import('../lib/installTransaction.mjs');
  const repo = makeRepo(SAMPLE_REPO);
  try {
    withInstallTransaction(repo, ['ui-lab'], () => {
      assert.throws(
        () => withInstallTransaction(repo, ['ui-lab'], () => undefined),
        /install already in progress/i
      );
    });
  } finally {
    cleanup(repo);
  }
});

test('executeInstall honors an existing repository install lock', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.apex/install.lock': '{"pid":1234}\n',
  });
  try {
    assert.throws(
      () => executeInstall(PKG_ROOT, repo, ['ui-lab']),
      /install already in progress/i
    );
    assert.equal(
      fs.existsSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md')),
      false
    );
  } finally {
    cleanup(repo);
  }
});

test('assertWithin rejects a symlinked destination path', (t) => {
  const repo = makeRepo(SAMPLE_REPO);
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'apex-skills-outside-')
  );
  try {
    fs.mkdirSync(path.join(repo, '.cursor/skills'), { recursive: true });
    try {
      fs.symlinkSync(
        outside,
        path.join(repo, '.cursor/skills/ui-lab'),
        'junction'
      );
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip(
          'symlink creation requires elevated privileges on this Windows host'
        );
        return;
      }
      throw error;
    }

    assert.throws(
      () => assertWithin(repo, '.cursor/skills/ui-lab/SKILL.md'),
      /symbolic link|symlink/i
    );
  } finally {
    cleanup(repo);
    cleanup(outside);
  }
});

test('assertWithin rejects a dangling symlink component', (t) => {
  const repo = makeRepo(SAMPLE_REPO);
  const missingTarget = path.join(
    os.tmpdir(),
    `missing-apex-target-${Date.now()}`
  );
  try {
    fs.mkdirSync(path.join(repo, '.cursor/skills'), { recursive: true });
    try {
      fs.symlinkSync(
        missingTarget,
        path.join(repo, '.cursor/skills/ui-lab'),
        'junction'
      );
    } catch (error) {
      if (error?.code === 'EPERM') {
        t.skip(
          'symlink creation requires elevated privileges on this Windows host'
        );
        return;
      }
      throw error;
    }

    assert.throws(
      () => assertWithin(repo, '.cursor/skills/ui-lab/SKILL.md'),
      /symbolic link|symlink/i
    );
  } finally {
    cleanup(repo);
  }
});

test('lockfile v3 is current; v2 remains readable; newer versions fail closed', async () => {
  const {
    emptyLockfile,
    verifyLockfileIntegrity,
    serializeLockfile,
    LOCKFILE_VERSION,
    LOCKFILE_VERSION_V2,
  } = await import('../lib/lockfile.mjs');

  assert.equal(LOCKFILE_VERSION, 3);
  assert.equal(LOCKFILE_VERSION_V2, 2);

  const legacy = JSON.parse(
    serializeLockfile(emptyLockfile('2.1.0', '@apex/skills'))
  );
  assert.equal(legacy.lockfileVersion, 2);
  assert.equal(legacy.skillRoot, undefined);
  assert.deepEqual(verifyLockfileIntegrity(legacy), {
    valid: true,
    error: null,
  });

  const current = JSON.parse(
    serializeLockfile(emptyLockfile('2.1.0', '@apex/skills', '.agents/skills'))
  );
  assert.equal(current.lockfileVersion, 3);
  assert.equal(current.skillRoot, '.agents/skills');
  assert.deepEqual(verifyLockfileIntegrity(current), {
    valid: true,
    error: null,
  });

  const v2 = JSON.parse(
    serializeLockfile({
      lockfileVersion: 2,
      suiteVersion: '2.0.0',
      package: '@apex/skills',
      skills: {},
    })
  );
  assert.deepEqual(verifyLockfileIntegrity(v2), { valid: true, error: null });

  const hashed = JSON.parse(
    serializeLockfile({
      lockfileVersion: 4,
      suiteVersion: '2.1.0',
      package: '@apex/skills',
      skillRoot: '.cursor/skills',
      skills: {},
    })
  );
  const rejected = verifyLockfileIntegrity(hashed);
  assert.equal(rejected.valid, false);
  assert.match(rejected.error, /Unsupported lockfile version: 4/);

  const v2WithRoot = verifyLockfileIntegrity({
    lockfileVersion: 2,
    suiteVersion: '2.0.3',
    package: '@apex/skills',
    skillRoot: '.agents/skills',
    integrity: 'not-checked',
    skills: {},
  });
  assert.equal(v2WithRoot.valid, false);
  assert.match(v2WithRoot.error, /must omit skillRoot/);

  const v3WithoutRoot = verifyLockfileIntegrity({
    lockfileVersion: 3,
    suiteVersion: '2.1.0',
    package: '@apex/skills',
    integrity: 'not-checked',
    skills: {},
  });
  assert.equal(v3WithoutRoot.valid, false);
  assert.match(v3WithoutRoot.error, /must include skillRoot/);

  const v3LegacyRoot = verifyLockfileIntegrity({
    lockfileVersion: 3,
    suiteVersion: '2.1.0',
    package: '@apex/skills',
    skillRoot: '.cursor/skills',
    integrity: 'not-checked',
    skills: {},
  });
  assert.equal(v3LegacyRoot.valid, false);
  assert.match(v3LegacyRoot.error, /legacy/);
});

test('lockfile integrity verification detects tampering', async () => {
  const { verifyLockfileIntegrity, serializeLockfile } =
    await import('../lib/lockfile.mjs');
  assert.equal(typeof verifyLockfileIntegrity, 'function');

  const valid = JSON.parse(
    serializeLockfile({
      lockfileVersion: 2,
      suiteVersion: '2.0.0',
      package: '@apex/skills',
      skills: {},
    })
  );
  assert.deepEqual(verifyLockfileIntegrity(valid), {
    valid: true,
    error: null,
  });

  valid.suiteVersion = '9.9.9';
  const tampered = verifyLockfileIntegrity(valid);
  assert.equal(tampered.valid, false);
  assert.match(tampered.error, /integrity mismatch/i);
});

test('an explicit v2 lock cannot masquerade as v1 to bypass integrity', async () => {
  const { verifyLockfileIntegrity } = await import('../lib/lockfile.mjs');
  const disguised = {
    lockfileVersion: 2,
    suiteVersion: '2.0.0',
    package: '@apex/skills',
    skills: {
      'ui-lab': {
        vendored: { '.apex/foundation/ui-lab/SKILL.md': 'deadbeef' },
      },
    },
  };

  const result = verifyLockfileIntegrity(disguised);
  assert.equal(result.valid, false);
  assert.match(result.error, /integrity is missing/i);
});

test('install validates lock integrity after acquiring the repository lock', () => {
  const repo = makeRepo(SAMPLE_REPO);
  const originalOpenSync = fs.openSync;
  const originalCpSync = fs.cpSync;
  let copyCalls = 0;
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const lockPath = path.join(repo, 'apex-skills.lock.json');
    let injected = false;
    fs.openSync = (target, flags, ...rest) => {
      if (
        !injected &&
        String(target).endsWith(path.join('.apex', 'install.lock'))
      ) {
        injected = true;
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        lock.suiteVersion = '9.9.9';
        fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
      }
      return originalOpenSync(target, flags, ...rest);
    };
    fs.cpSync = (...args) => {
      copyCalls += 1;
      return originalCpSync(...args);
    };

    assert.throws(
      () => executeInstall(PKG_ROOT, repo, ['ui-lab']),
      /lockfile integrity mismatch/i
    );
    assert.equal(
      copyCalls,
      0,
      'invalid integrity must fail before transaction snapshots'
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.cpSync = originalCpSync;
    cleanup(repo);
  }
});

test('transaction initialization failure does not leave a stale lock', async () => {
  const { withInstallTransaction, INSTALL_LOCK_REL } =
    await import('../lib/installTransaction.mjs');
  const repo = makeRepo(SAMPLE_REPO);
  const originalWriteFileSync = fs.writeFileSync;
  let openedFd = null;
  try {
    fs.writeFileSync = (target, ...args) => {
      if (typeof target === 'number') {
        openedFd = target;
        throw new Error('injected lock metadata failure');
      }
      return originalWriteFileSync(target, ...args);
    };
    assert.throws(
      () => withInstallTransaction(repo, ['ui-lab'], () => undefined),
      /injected lock metadata failure/
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    if (openedFd !== null) {
      try {
        fs.closeSync(openedFd);
      } catch {
        // Fixed implementation already closes it.
      }
    }
  }

  try {
    assert.equal(fs.existsSync(path.join(repo, INSTALL_LOCK_REL)), false);
  } finally {
    if (fs.existsSync(path.join(repo, INSTALL_LOCK_REL))) {
      fs.rmSync(path.join(repo, INSTALL_LOCK_REL), { force: true });
    }
    cleanup(repo);
  }
});

test('v1 lockfile paths cannot escape the repository', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.apex/foundation/ui-lab/SKILL.md': 'LEGACY_FOUNDATION\n',
    'apex-skills.lock.json':
      JSON.stringify(
        {
          lockfileVersion: 1,
          suiteVersion: '0.2.0',
          package: '@apex/skills',
          skills: {
            'ui-lab': {
              vendored: { '../outside-secret.txt': 'deadbeef' },
              adapterScaffolded: true,
            },
          },
        },
        null,
        2
      ) + '\n',
  });
  try {
    assert.throws(
      () => executeInstall(PKG_ROOT, repo, ['ui-lab']),
      /escapes root|outside the legacy foundation directory/i
    );
  } finally {
    cleanup(repo);
  }
});

test('planInstall rejects rehashed v2 managed paths outside the skill directory', () => {
  const repo = makeRepo({
    ...SAMPLE_REPO,
    '.cursor/skills/ui-lab/SKILL.md':
      '<!-- APEX:BEGIN managed -->\n# Foundation\n<!-- APEX:END managed -->\n',
  });
  try {
    const malicious = JSON.parse(
      serializeLockfile({
        lockfileVersion: 2,
        suiteVersion: '2.0.0',
        package: '@apex/skills',
        skills: {
          'ui-lab': {
            contractRange: '>=0.1.0',
            managedRegionHash: 'deadbeef',
            managedFiles: {
              '../../outside-secret.txt': 'deadbeef',
            },
            adapterScaffolded: true,
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(repo, 'apex-skills.lock.json'),
      JSON.stringify(malicious, null, 2) + '\n'
    );

    const plan = planInstall(PKG_ROOT, repo, ['ui-lab']);
    assert.ok(
      plan.errors.some((error) => /outside.*ui-lab|escapes root/i.test(error)),
      plan.errors.join('\n')
    );
  } finally {
    cleanup(repo);
  }
});

test('install refuses a tampered v2 lockfile', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    const lockPath = path.join(repo, 'apex-skills.lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.suiteVersion = '9.9.9';
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

    assert.throws(
      () => executeInstall(PKG_ROOT, repo, ['ui-lab']),
      /lockfile integrity mismatch/i
    );
  } finally {
    cleanup(repo);
  }
});

test('check rejects invalid integrity without trusting lockfile paths', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['to-prd']);
    const lockPath = path.join(repo, 'apex-skills.lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.suiteVersion = '9.9.9';
    lock.skills['to-prd'].managedFiles = {
      '../../outside-directory': 'deadbeef',
    };
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

    const result = checkRepo(PKG_ROOT, repo);
    const skill = result.skills.find((entry) => entry.name === 'to-prd');

    assert.equal(result.lockfileIntegrityValid, false);
    assert.match(result.lockfileIntegrityError, /integrity mismatch/i);
    assert.equal(skill.drift, true);
  } finally {
    cleanup(repo);
  }
});

test('check reports missing managed files as drift for a valid lock', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['to-prd']);
    fs.rmSync(path.join(repo, '.cursor/skills/to-prd/SKILL.md'));
    fs.rmSync(path.join(repo, '.cursor/skills/to-prd/backlog-schema.json'));

    const result = checkRepo(PKG_ROOT, repo);
    const skill = result.skills.find((entry) => entry.name === 'to-prd');

    assert.equal(result.lockfileIntegrityValid, true);
    assert.equal(skill.drift, true);
    assert.equal(skill.missingFence, true);
    assert.equal(skill.companionDrift, true);
  } finally {
    cleanup(repo);
  }
});

test('check command exits nonzero for integrity or managed-file drift', () => {
  const repo = makeRepo(SAMPLE_REPO);
  try {
    executeInstall(PKG_ROOT, repo, ['ui-lab']);
    fs.rmSync(path.join(repo, '.cursor/skills/ui-lab/SKILL.md'));

    const logs = [];
    const exitCode = cmdCheck({ package: PKG_ROOT, cwd: repo }, (message) =>
      logs.push(message)
    );

    assert.equal(exitCode, 1);
    assert.ok(logs.some((line) => /MISSING-FENCE/.test(line)));
  } finally {
    cleanup(repo);
  }
});
