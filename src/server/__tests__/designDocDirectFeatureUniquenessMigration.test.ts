import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260805100000_design-doc-direct-feature-uniqueness.sql',
);

describe('direct design-doc feature uniqueness migration', () => {
  it('deduplicates existing rows before adding the partial unique index', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER/i);
    expect(sql).toMatch(/DELETE\s+FROM\s+design_docs/i);
    expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+uq_design_docs_prd_direct_feature/i);
    expect(sql).toMatch(/ON\s+design_docs\s*\(\s*prd_id\s*,\s*feature_index\s*\)/i);
    expect(sql).toMatch(/design_prototype_id\s+IS\s+NULL/i);
    expect(sql).toMatch(/feature_index\s+IS\s+NOT\s+NULL/i);
  });
});
