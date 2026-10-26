/**
 * TBI-001 DoD-1 / VT-08 — Drizzle check and index names match the migrations,
 * and each vocabulary value appears in its SQL check.
 */
import fs from 'fs';
import path from 'path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  BUILD_CORRELATION_KINDS,
  BUILD_DEPLOYMENT_STATUSES,
  BUILD_EVENT_SEVERITIES,
  BUILD_RUN_SLOT_STATUSES,
  BUILD_RUN_STATUSES,
  BUILD_SUSPEND_REASONS,
  BUILD_TASK_ROLES,
  BUILD_TASK_RUN_MODES,
  BUILD_TASK_STATUSES,
  BUILD_TEST_TIERS,
  BUILD_VERIFICATION_KINDS,
  BUILD_VERIFICATION_STATUSES,
} from '../../shared/types/build';
import * as schema from '../db/schema';

const TABLES_SQL = fs.readFileSync(
  path.resolve(process.cwd(), 'migrations/20261023143900_a1a4_build-from-prompt-tables.sql'),
  'utf8',
);
const AGENT_SQL = fs.readFileSync(
  path.resolve(process.cwd(), 'migrations/20261023144000_c3d8_build-from-prompt-agent-runs.sql'),
  'utf8',
);

const BUILD_TABLES: PgTable[] = [
  schema.buildRuns,
  schema.buildRevisions,
  schema.buildTasks,
  schema.buildVerificationRows,
  schema.buildPreviewLeases,
  schema.buildEvents,
];

function sqlNames(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

describe('VT-08 Drizzle matches the build migrations', () => {
  it('VT-08 / DoD-1 check and index names agree in both directions', () => {
    const drizzleChecks = BUILD_TABLES.flatMap((table) => getTableConfig(table).checks.map((entry) => entry.name));
    const drizzleIndexes = BUILD_TABLES.flatMap((table) => getTableConfig(table).indexes.map((entry) => entry.config.name));
    const sqlChecks = sqlNames(TABLES_SQL, /CONSTRAINT\s+(\w+)\s+CHECK/gi);
    const sqlIndexes = sqlNames(TABLES_SQL, /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)/gi);

    expect(drizzleChecks.sort()).toEqual(sqlChecks.sort());
    expect(drizzleIndexes.sort()).toEqual(sqlIndexes.sort());

    const agent = getTableConfig(schema.agentRuns);
    for (const name of ['agent_runs_workflow_class_check', 'agent_runs_build_task_class_check']) {
      expect(agent.checks.map((entry) => entry.name)).toContain(name);
      expect(AGENT_SQL).toContain(name);
    }
    for (const name of ['uq_agent_runs_one_live_per_build_task', 'idx_agent_runs_build_task']) {
      expect(agent.indexes.map((entry) => entry.config.name)).toContain(name);
      expect(AGENT_SQL).toContain(name);
    }
  });

  it('VT-08 each vocabulary value appears in its SQL check list', () => {
    const quoted = (values: readonly string[]) => {
      for (const value of values) expect(TABLES_SQL).toContain(`'${value}'`);
    };
    quoted(BUILD_RUN_STATUSES);
    quoted(BUILD_SUSPEND_REASONS);
    quoted(BUILD_RUN_SLOT_STATUSES);
    quoted(BUILD_TASK_STATUSES);
    quoted(BUILD_TASK_ROLES);
    quoted(BUILD_TASK_RUN_MODES);
    quoted(BUILD_VERIFICATION_KINDS);
    quoted(BUILD_VERIFICATION_STATUSES);
    quoted(BUILD_TEST_TIERS);
    quoted(BUILD_DEPLOYMENT_STATUSES);
    quoted(BUILD_EVENT_SEVERITIES);
    quoted(BUILD_CORRELATION_KINDS);
    expect(AGENT_SQL).toContain(`'build-task'`);
  });
});
