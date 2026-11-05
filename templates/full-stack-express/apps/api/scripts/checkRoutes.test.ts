import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { apiRoot, baseEnv } from '../test/support/apiProcess.ts';

describe('routes:check (VT-28)', () => {
  it('VT-28 TBI-015 DoD-0 TBI-014 exits 0 when the registered routes match the contracts', () => {
    const result = spawnSync(process.execPath, ['scripts/checkRoutes.ts'], {
      cwd: apiRoot,
      env: baseEnv(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'routes:check: the 4 registered routes match the contracts'
    );
  });
});
