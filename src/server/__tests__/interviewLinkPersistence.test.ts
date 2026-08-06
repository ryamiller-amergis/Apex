/**
 * Persistence contract checks for typed Interview artifact links (TBI-001 / VT-09).
 * Asserts migration DDL and Drizzle schema shape (cascade, unique, audit columns).
 */

import fs from 'fs';
import path from 'path';
import {
  interviewAdrLinks,
  interviewDesignModuleLinks,
} from '../db/schema';

const MIGRATION = path.join(
  __dirname,
  '../../../migrations/20260806010000_typed_interview_artifact_links.sql',
);
const REPAIR_MIGRATION = path.join(
  __dirname,
  '../../../migrations/20260806144000_repair_typed_interview_artifact_links.sql',
);

describe('TBI-001 typed Interview artifact link persistence', () => {
  it('DoD-0: migration creates both tables with FKs, cascade, unique, indexes, audit columns', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');

    expect(sql).toMatch(/CREATE TABLE interview_adr_links/i);
    expect(sql).toMatch(/CREATE TABLE interview_design_module_links/i);

    expect(sql).toMatch(/REFERENCES interviews\(id\) ON DELETE CASCADE/i);
    expect(sql).toMatch(/REFERENCES adrs\(id\) ON DELETE CASCADE/i);
    expect(sql).toMatch(/REFERENCES design_modules\(id\) ON DELETE CASCADE/i);

    expect(sql).toMatch(/UNIQUE \(interview_id, adr_id\)/i);
    expect(sql).toMatch(/UNIQUE \(interview_id, design_module_id\)/i);

    expect(sql).toMatch(/linked_by\s+TEXT\s+NOT NULL/i);
    expect(sql).toMatch(/linked_at\s+TIMESTAMPTZ\s+NOT NULL/i);

    expect(sql).toMatch(/idx_interview_adr_links_interview_id/i);
    expect(sql).toMatch(/idx_interview_design_module_links_interview_id/i);

    // Reversible
    expect(sql).toMatch(/^-- Down Migration\s*$/m);
    expect(sql).not.toMatch(/^---- DOWN/m);
    expect(sql).toMatch(/DROP TABLE IF EXISTS interview_design_module_links/i);
    expect(sql).toMatch(/DROP TABLE IF EXISTS interview_adr_links/i);
  });

  it('DoD-0: repair migration restores tables for databases that recorded the malformed migration', () => {
    const sql = fs.readFileSync(REPAIR_MIGRATION, 'utf8');

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS interview_adr_links/i);
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS interview_design_module_links/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_interview_adr_links_interview_id/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_interview_design_module_links_interview_id/i,
    );
    expect(sql).toMatch(/^-- Down Migration\s*$/m);
  });

  it('DoD-1: Drizzle table definitions expose expected columns', () => {
    expect(interviewAdrLinks.interviewId).toBeDefined();
    expect(interviewAdrLinks.adrId).toBeDefined();
    expect(interviewAdrLinks.linkedBy).toBeDefined();
    expect(interviewAdrLinks.linkedAt).toBeDefined();

    expect(interviewDesignModuleLinks.interviewId).toBeDefined();
    expect(interviewDesignModuleLinks.designModuleId).toBeDefined();
    expect(interviewDesignModuleLinks.linkedBy).toBeDefined();
    expect(interviewDesignModuleLinks.linkedAt).toBeDefined();
  });

  it('VT-09: cascade deletion is declared on both artifact and interview FKs', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const cascadeCount = (sql.match(/ON DELETE CASCADE/gi) ?? []).length;
    // 2 FKs per table × 2 tables = 4
    expect(cascadeCount).toBeGreaterThanOrEqual(4);
  });
});
