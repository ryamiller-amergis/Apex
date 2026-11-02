import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');
const read = (name: string) => fs.readFileSync(path.join(migrationsDir, name), 'utf8');

const tablesMigration = read('20261029111425_0425_brainstorm-tables.sql');
const permissionsMigration = read('20261029111557_34d5_add-brainstorm-permissions.sql');
const menuMigration = read('20261029111558_0f08_enable-brainstorm-project-menu.sql');
const flagMigration = read('20261029111559_55e3_seed-brainstorm-flag.sql');
const governance = fs.readFileSync(path.join(repoRoot, '.cursor', 'rules', 'rbac-governance.mdc'), 'utf8');

function upBlock(sql: string): string {
  return sql.split('-- Down Migration')[0];
}

function downBlock(sql: string): string {
  return sql.split('-- Down Migration')[1] ?? '';
}

function tableBody(sql: string, table: string): string {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(');', start));
}

const TABLES = [
  'brainstorm_sessions',
  'brainstorm_messages',
  'brainstorm_sources',
  'brainstorm_artifacts',
  'brainstorm_artifact_versions',
  'brainstorm_citations',
  'brainstorm_actions',
];

describe('FEAT-001 TBI-001 — Brainstorm tables migration', () => {
  const up = upBlock(tablesMigration);
  const down = downBlock(tablesMigration);

  it.each(TABLES)('creates %s with a project column', (table) => {
    expect(tableBody(up, table)).toMatch(/\n\s+project\s+text NOT NULL/);
  });

  it('limits session state to active, ended and failed', () => {
    expect(up).toContain("CHECK (state IN ('active', 'ended', 'failed'))");
  });

  it('indexes sessions by project and activity, project and creator, and one thread per session', () => {
    expect(up).toContain('ON brainstorm_sessions (project, last_activity_at DESC)');
    expect(up).toContain('ON brainstorm_sessions (project, creator_id)');
    expect(up).toMatch(/UNIQUE INDEX IF NOT EXISTS uq_brainstorm_sessions_chat_thread\s+ON brainstorm_sessions \(chat_thread_id\)/);
    expect(up).toMatch(/ON brainstorm_sessions \(last_activity_at\)\s+WHERE state = 'active'/);
  });

  it('allows one streaming assistant row per session and one row per turn and role', () => {
    expect(up).toMatch(/uq_brainstorm_messages_one_streaming\s+ON brainstorm_messages \(session_id\)\s+WHERE role = 'assistant' AND status = 'streaming'/);
    expect(up).toMatch(/ON brainstorm_messages \(session_id, turn_id, role\)\s+WHERE retry_of_message_id IS NULL/);
  });

  it('keeps an idempotency key on actions and version counters on sessions and artifacts', () => {
    expect(up).toContain('ON brainstorm_actions (idempotency_key)');
    expect(tableBody(up, 'brainstorm_sessions')).toContain('version          integer NOT NULL DEFAULT 1');
    expect(tableBody(up, 'brainstorm_artifacts')).toContain('version       integer NOT NULL DEFAULT 1');
  });

  it('stores no file content or credentials on brainstorm_sources', () => {
    const body = tableBody(up, 'brainstorm_sources');
    expect(body).not.toMatch(/\b(content|markdown|token|secret|password|credential)/i);
  });

  it('drops every table in the down migration, children first', () => {
    for (const table of TABLES) {
      expect(down).toContain(`DROP TABLE IF EXISTS ${table};`);
    }
    expect(down.indexOf('brainstorm_actions')).toBeLessThan(down.indexOf('brainstorm_sessions'));
  });
});

describe('FEAT-001 TBI-002 — Brainstorm permissions, menu and flag', () => {
  it('inserts both permissions in category brainstorm for admin, member and viewer', () => {
    const up = upBlock(permissionsMigration);
    expect(up).toContain("'brainstorm:view'");
    expect(up).toContain("'brainstorm:create'");
    expect(up).toContain('ON CONFLICT (key) DO NOTHING');
    expect(up).toMatch(/WHERE r\.name IN \('admin', 'member', 'viewer'\)/);
  });

  it('removes role links before keys on down', () => {
    const down = downBlock(permissionsMigration);
    expect(down.indexOf('DELETE FROM app_role_permissions')).toBeLessThan(
      down.search(/DELETE FROM app_permissions\s/),
    );
  });

  it('lists both keys in the rbac-governance catalog', () => {
    expect(governance).toContain('| `brainstorm:view` | brainstorm | admin, member, viewer |');
    expect(governance).toContain('| `brainstorm:create` | brainstorm | admin, member, viewer |');
  });

  it('backfills the menu key only where it is missing and removes it on down', () => {
    expect(upBlock(menuMigration)).toContain(`WHERE NOT enabled_views @> '["brainstorm"]'::jsonb`);
    expect(downBlock(menuMigration)).toContain("enabled_views - 'brainstorm'");
  });

  it('seeds the flag off, active, not cleanup-ready, with no rules', () => {
    const up = upBlock(flagMigration);
    expect(up).toMatch(/'brainstorm',\s+'[^']+',\s+false,\s+'active',\s+false,/);
    expect(up).not.toContain('feature_flag_rules');
    const down = downBlock(flagMigration);
    expect(down.indexOf('DELETE FROM feature_flag_rules')).toBeLessThan(down.search(/DELETE FROM feature_flags\s/));
  });

  it('sorts the access migrations after the tables migration', () => {
    const names = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    expect(names.indexOf('20261029111557_34d5_add-brainstorm-permissions.sql')).toBeGreaterThan(
      names.indexOf('20261029111425_0425_brainstorm-tables.sql'),
    );
  });
});
