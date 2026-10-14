import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { playbookSpendPolicies } from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260922165410_add-playbook-spend-policies.sql'
);

describe('FEAT-015 playbook spend policy migration', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('creates one project-keyed policy with crossing and complete override audit fields', () => {
    expect(upSql).toMatch(/CREATE TABLE playbook_spend_policies/i);
    expect(upSql).toMatch(/project text PRIMARY KEY/i);
    expect(upSql).toMatch(/baseline_cost_usd numeric\(18,\s*6\)/i);
    expect(upSql).toMatch(/warning_generation integer/i);
    expect(upSql).toMatch(/warning_recipient_user_ids jsonb/i);
    expect(upSql).toMatch(
      /override_by_user_id[\s\S]*override_to_usd[\s\S]*override_at[\s\S]*override_reason/i
    );
  });

  it('seeds configuration-backed no-history and latest-report inputs outside skill settings', () => {
    expect(upSql).toMatch(/playbooks\.spend\.default_no_history_cap_usd/i);
    expect(upSql).toMatch(/playbooks\.spend\.latest_undercount_report/i);
    expect(upSql).not.toMatch(/project_skill_settings/i);
  });

  it('has a reversible down and a matching Drizzle mirror', () => {
    expect(downSql).toMatch(/DROP TABLE playbook_spend_policies/i);
    const columns = getTableColumns(playbookSpendPolicies);
    expect(columns.project.name).toBe('project');
    expect(columns.capUsd.name).toBe('cap_usd');
    expect(columns.warningGeneration.name).toBe('warning_generation');
    expect(columns.overrideReason.name).toBe('override_reason');
  });
});
