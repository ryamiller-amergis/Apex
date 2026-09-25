import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260923140000_durable-interactive-turns.sql'
);

describe('durable interactive turns migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  it('adds the durable turn columns, checks, and FIFO indexes', () => {
    expect(sql).toContain("'dapr-actor-v2'");
    expect(sql).toContain('interactive_class');
    expect(sql).toContain('client_turn_id');
    expect(sql).toContain('client_turn_hash');
    expect(sql).toContain('requested_by_user_id');
    expect(sql).toContain('spec_snapshot');
    expect(sql).toContain('uq_agent_runs_client_turn');
    expect(sql).toContain('uq_agent_runs_interactive_active_thread');
    expect(sql).toContain('idx_agent_runs_interactive_user_active');
    expect(sql).toContain('agent_runs_requested_by_user_id_check');
    expect(sql).toContain(
      'char_length(requested_by_user_id) BETWEEN 1 AND 256',
    );
    expect(sql).toContain('idx_ai_run_outbox_interactive_due');
    expect(sql).toContain('idx_ai_run_outbox_interactive_class_due');
    expect(sql).toContain(
      'Cannot create uq_agent_runs_interactive_active_thread'
    );
    expect(sql).toContain('Cannot remove durable interactive turn schema');
  });

  it('orders interactive dispatch indexes by accepted FIFO without model', () => {
    const [upSql = ''] = sql.split(/-- Down Migration/i);
    expect(upSql).toMatch(
      /idx_ai_run_outbox_interactive_due[\s\S]*ON ai_run_outbox \(created_at, id\)/i
    );
    expect(upSql).toMatch(
      /idx_ai_run_outbox_interactive_class_due[\s\S]*payload->>'interactiveClass'[\s\S]*created_at,\s*id/i
    );
    expect(upSql).not.toMatch(
      /idx_ai_run_outbox_interactive_(?:class_)?due[\s\S]{0,200}\bmodel\b/i
    );
    expect(upSql).not.toMatch(
      /idx_ai_run_outbox_interactive_(?:class_)?due[\s\S]{0,200}\bavailable_at\b/i
    );
  });

  it('guards down before dropping durable data support', () => {
    const [, downSql = ''] = sql.split(/-- Down Migration/i);
    expect(downSql).toMatch(
      /DO \$down_guard\$[\s\S]*transport_version = 'dapr-actor-v2'[\s\S]*kind = 'interactive_dispatch'[\s\S]*published_at IS NULL[\s\S]*RAISE EXCEPTION[\s\S]*Cannot remove durable interactive turn schema[\s\S]*END[\s\S]*\$down_guard\$;/i
    );
    expect(downSql.indexOf('DO $down_guard$')).toBeLessThan(
      downSql.indexOf('DROP INDEX')
    );
  });
});
