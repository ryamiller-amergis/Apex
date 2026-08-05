import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260805150000_seed-phase2-interactive-worker-tier.sql',
);

describe('seed Phase 2 interactive worker tier migration', () => {
  it('skips cleanly when the target PRD is absent (CI fresh DB)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/IF v_bj IS NULL THEN/i);
    expect(sql).toMatch(/skipping Phase 2 seed/i);
    expect(sql).not.toMatch(/aborting Phase 2 seed/i);
    expect(sql).toMatch(/RETURN;\s*\n\s*END IF;/i);
  });
});
