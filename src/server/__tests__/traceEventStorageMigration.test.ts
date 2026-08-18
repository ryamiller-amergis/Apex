import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { traceEvents, tracePathRollups } from '../db/schema';

const migrationPath = path.resolve(
  process.cwd(),
  'migrations/20260817163953_9b62_add-trace-event-storage.sql',
);

describe('TBI-001 Create Trace Event persistence model', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const [upSql = '', downSql = ''] = migration.split(/-- Down Migration/i);

  it('DoD-0 / VT-01 creates trace_events and trace_path_rollups with required constraints and indexes', () => {
    expect(upSql).toMatch(/CREATE TABLE trace_events/i);
    expect(upSql).toMatch(/CREATE TABLE trace_path_rollups/i);
    expect(upSql).toMatch(/event_type IN \('api_request', 'error', 'ui_action', 'agent_event'\)/);
    expect(upSql).toMatch(/trace_id ~ '\^\[0-9a-f\]\{32\}\$'/);
    expect(upSql).toMatch(/REFERENCES app_users\(oid\) ON DELETE SET NULL/);
    expect(upSql).toMatch(/jsonb_typeof\(details\) = 'object'/);
    expect(upSql).toMatch(/idx_trace_events_actor_occurred[\s\S]*actor_user_id, occurred_at DESC, id/);
    expect(upSql).toMatch(/idx_trace_events_trace_occurred[\s\S]*trace_id, occurred_at/);
    expect(upSql).toMatch(/idx_trace_events_session_occurred[\s\S]*WHERE session_id IS NOT NULL/);
    expect(upSql).toMatch(/idx_trace_events_route_occurred[\s\S]*route_template, occurred_at/);
    expect(upSql).toMatch(/idx_trace_events_occurred[\s\S]*occurred_at DESC/);
    expect(upSql).toMatch(/UNIQUE \(from_route, to_route, day\)/);
    expect(upSql).not.toMatch(/actor_user_id TEXT NOT NULL/);
  });

  it('DoD-1 / VT-03 typed schema exposes both tables and event discriminators', () => {
    expect(getTableName(traceEvents)).toBe('trace_events');
    expect(getTableName(tracePathRollups)).toBe('trace_path_rollups');
    expect(Object.keys(getTableColumns(traceEvents))).toEqual(
      expect.arrayContaining([
        'id',
        'eventType',
        'occurredAt',
        'actorUserId',
        'projectId',
        'traceId',
        'sessionId',
        'routeTemplate',
        'httpMethod',
        'statusCode',
        'durationMs',
        'severity',
        'details',
        'createdAt',
      ]),
    );
    expect(Object.keys(getTableColumns(tracePathRollups))).toEqual(
      expect.arrayContaining([
        'fromRoute',
        'toRoute',
        'day',
        'transitionCount',
        'distinctActorCount',
      ]),
    );
    expect(upSql).toMatch(/details JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    expect(upSql).toMatch(/occurred_at TIMESTAMPTZ NOT NULL/);
  });

  it('DoD-2 / VT-02 down removes only the new tables and seeded capture flag', () => {
    expect(downSql).toMatch(/DROP TABLE IF EXISTS trace_path_rollups/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS trace_events/);
    expect(downSql).toMatch(/DELETE FROM feature_flags[\s\S]*observability-capture/);
    expect(downSql).not.toMatch(/DROP TABLE IF EXISTS app_users/);
    expect(downSql).not.toMatch(/ALTER TABLE app_users/);
  });

  it('DoD-2 NFR / VT-04 documents representative query-path indexes for 30-day scans', () => {
    const queryPlans = [
      /idx_trace_events_actor_occurred/,
      /idx_trace_events_trace_occurred/,
      /idx_trace_events_session_occurred/,
      /idx_trace_events_route_occurred/,
      /idx_trace_events_occurred/,
    ];

    for (const pattern of queryPlans) {
      expect(upSql).toMatch(pattern);
    }
  });
});
