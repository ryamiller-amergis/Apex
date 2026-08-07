import fs from 'fs';
import path from 'path';
import {
  DIAGRAM_DEFAULT_TITLE,
  DIAGRAM_MAX_SCENE_BYTES,
  DIAGRAM_MAX_THUMBNAIL_BYTES,
  DIAGRAM_SHARE_ACCESS_VALUES,
} from '../../shared/types/diagram';

const repoRoot = path.resolve(__dirname, '../../..');
const migrationPath = path.join(
  repoRoot,
  'migrations',
  '20260806030000_diagram-persistence-and-permissions.sql',
);

describe('FEAT-001 diagram foundations', () => {
  it('TBI-001 DoD-0/DoD-1/DoD-2 VT-01 defines reversible two-table persistence', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toMatch(/CREATE TABLE diagrams/i);
    expect(migration).toMatch(/CREATE TABLE diagram_shares/i);
    expect(migration).toMatch(/REFERENCES diagrams\(id\) ON DELETE CASCADE/i);
    expect(migration).toMatch(/UNIQUE\s*\(diagram_id,\s*grantee_id\)/i);
    expect(migration).toMatch(/CHECK\s*\(access IN \('view', 'edit'\)\)/i);
    expect(migration).toMatch(/-- Down Migration[\s\S]*DROP TABLE IF EXISTS diagram_shares/i);
    expect(migration).toMatch(/DROP TABLE IF EXISTS diagrams/i);
  });

  it('TBI-001 index NFR defines owner and grantee lookup indexes', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toMatch(
      /CREATE INDEX idx_diagrams_project_owner ON diagrams\s*\(project_id,\s*owner_id\)/i,
    );
    expect(migration).toMatch(
      /CREATE INDEX idx_diagram_shares_grantee ON diagram_shares\s*\(grantee_id,\s*diagram_id\)/i,
    );
  });

  it('resolved permission prerequisite seeds all keys with required role defaults', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    for (const key of [
      'diagram:view',
      'diagram:create',
      'diagram:edit',
      'diagram:delete',
      'diagram:share',
    ]) {
      expect(migration).toContain(`'${key}'`);
    }
    expect(migration).toMatch(/r\.name IN \('admin', 'member', 'viewer'\)[\s\S]*diagram:view/i);
    expect(migration).toMatch(
      /r\.name IN \('admin', 'member'\)[\s\S]*diagram:create[\s\S]*diagram:share/i,
    );
  });

  it('TBI-001 DoD-1 exports the adopted shared contract constants', () => {
    expect(DIAGRAM_DEFAULT_TITLE).toBe('Untitled diagram');
    expect(DIAGRAM_MAX_SCENE_BYTES).toBe(5 * 1024 * 1024);
    expect(DIAGRAM_MAX_THUMBNAIL_BYTES).toBe(512 * 1024);
    expect(DIAGRAM_SHARE_ACCESS_VALUES).toEqual(['view', 'edit']);
  });

  it('TBI-003 DoD-0/DoD-1/DoD-2 VT-10 documents the canonical term and distinctions', () => {
    const context = fs.readFileSync(path.join(repoRoot, 'context.md'), 'utf8');

    expect(context).toMatch(
      /\*\*Diagram\*\*.*freeform, human-drawn, saveable and shareable whiteboard canvas used for ideation/i,
    );
    expect(context).toMatch(/Use Diagram.*\/diagrams.*diagram:\*/i);
    expect(context).toMatch(/Design Prototype/i);
    expect(context).toMatch(/Mermaid diagram/i);
    expect(context).toMatch(/UI Lab mock/i);
    expect(context).toMatch(/not.*real-time collaboration/i);
  });
});
