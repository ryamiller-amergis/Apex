/**
 * TBI-001 — evaluation tables migration shape and Drizzle column parity.
 * Covers DoD-0, DoD-1, DoD-2, the index NFR, VT-01 and VT-14 (no project column).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import {
  workflowEvaluationDefinitions,
  workflowEvaluationEvents,
  workflowEvaluationJobs,
} from '../db/schema';

function migrationBySlug(slug: string): { file: string; sql: string; up: string; down: string } {
  const dir = path.resolve(process.cwd(), 'migrations');
  const matches = fs.readdirSync(dir).filter((name) => name.endsWith(`_${slug}.sql`));
  if (matches.length !== 1) {
    throw new Error(`Expected one migration ending in _${slug}.sql, found ${matches.length}`);
  }
  const file = path.join(dir, matches[0]);
  const sql = fs.readFileSync(file, 'utf8');
  const [up = '', down = ''] = sql.split(/-- Down Migration/i);
  return { file, sql, up, down };
}

const tables = migrationBySlug('workflow-evaluation-tables');

const DEFINITION_COLUMNS: Record<string, { name: string; notNull: boolean }> = {
  id: { name: 'id', notNull: true },
  processKey: { name: 'process_key', notNull: true },
  stageKey: { name: 'stage_key', notNull: true },
  evaluatorKey: { name: 'evaluator_key', notNull: true },
  benchmarkKey: { name: 'benchmark_key', notNull: true },
  version: { name: 'version', notNull: true },
  rubric: { name: 'rubric', notNull: true },
  promptfooSuiteRef: { name: 'promptfoo_suite_ref', notNull: true },
  judgeOutputSchema: { name: 'judge_output_schema', notNull: true },
  active: { name: 'active', notNull: true },
  createdAt: { name: 'created_at', notNull: true },
};

const EVENT_COLUMNS: Record<string, { name: string; notNull: boolean }> = {
  id: { name: 'id', notNull: true },
  project: { name: 'project', notNull: true },
  definitionId: { name: 'definition_id', notNull: true },
  subjectType: { name: 'subject_type', notNull: true },
  subjectId: { name: 'subject_id', notNull: true },
  stageKey: { name: 'stage_key', notNull: true },
  phaseIndex: { name: 'phase_index', notNull: false },
  reviewerUserId: { name: 'reviewer_user_id', notNull: true },
  reviewerRoleKey: { name: 'reviewer_role_key', notNull: true },
  reviewerRoleLabel: { name: 'reviewer_role_label', notNull: true },
  skillPath: { name: 'skill_path', notNull: false },
  skillVersion: { name: 'skill_version', notNull: false },
  model: { name: 'model', notNull: false },
  interviewId: { name: 'interview_id', notNull: false },
  prdId: { name: 'prd_id', notNull: false },
  artifactHash: { name: 'artifact_hash', notNull: true },
  criteriaScores: { name: 'criteria_scores', notNull: true },
  outcome: { name: 'outcome', notNull: true },
  reasonCodes: { name: 'reason_codes', notNull: true },
  comment: { name: 'comment', notNull: false },
  correctedArtifactText: { name: 'corrected_artifact_text', notNull: false },
  correctedArtifactBlobRef: { name: 'corrected_artifact_blob_ref', notNull: false },
  createdAt: { name: 'created_at', notNull: true },
};

const JOB_COLUMNS: Record<string, { name: string; notNull: boolean }> = {
  id: { name: 'id', notNull: true },
  eventId: { name: 'event_id', notNull: true },
  evaluatorKey: { name: 'evaluator_key', notNull: true },
  status: { name: 'status', notNull: true },
  runId: { name: 'run_id', notNull: false },
  specificationHash: { name: 'specification_hash', notNull: false },
  summary: { name: 'summary', notNull: false },
  resultBlobRefs: { name: 'result_blob_refs', notNull: false },
  errorDetail: { name: 'error_detail', notNull: false },
  createdAt: { name: 'created_at', notNull: true },
  updatedAt: { name: 'updated_at', notNull: true },
};

function expectColumns(
  actual: ReturnType<typeof getTableColumns>,
  expected: Record<string, { name: string; notNull: boolean }>,
): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const [key, spec] of Object.entries(expected)) {
    expect(actual[key]?.name).toBe(spec.name);
    expect(actual[key]?.notNull).toBe(spec.notNull);
  }
}

describe('TBI-001 / VT-01 — evaluation tables migration', () => {
  it('DoD-0 creates the three tables, the job unique constraint and both guard triggers', () => {
    expect(fs.existsSync(tables.file)).toBe(true);
    expect(tables.up).toMatch(/CREATE TABLE workflow_evaluation_definitions/i);
    expect(tables.up).toMatch(/CREATE TABLE workflow_evaluation_events/i);
    expect(tables.up).toMatch(/CREATE TABLE workflow_evaluation_jobs/i);
    expect(tables.up).toMatch(
      /uq_workflow_evaluation_jobs_event_evaluator UNIQUE \(event_id, evaluator_key\)/i,
    );
    expect(tables.up).toMatch(/CREATE TRIGGER workflow_evaluation_events_immutable/i);
    expect(tables.up).toMatch(/BEFORE UPDATE OR DELETE ON workflow_evaluation_events/i);
    expect(tables.up).toMatch(/CREATE TRIGGER workflow_evaluation_definitions_active_only/i);
    expect(tables.up).toMatch(/ERRCODE = 'integrity_constraint_violation'/);
  });

  it('NFR indexes cover project, subject, artifact hash and lineage', () => {
    for (const indexName of [
      'idx_workflow_evaluation_events_subject_history',
      'idx_workflow_evaluation_events_artifact',
      'idx_workflow_evaluation_events_project_created',
      'idx_workflow_evaluation_events_lineage',
      'idx_workflow_evaluation_events_model',
      'idx_workflow_evaluation_events_interview',
      'idx_workflow_evaluation_events_prd',
      'idx_workflow_evaluation_jobs_open',
      'uq_workflow_evaluation_definitions_one_active',
    ]) {
      expect(tables.up).toContain(indexName);
    }
    expect(tables.up).toMatch(
      /idx_workflow_evaluation_events_subject_history[\s\S]*\(project, subject_type, subject_id, created_at DESC\)/i,
    );
    expect(tables.up).toMatch(
      /idx_workflow_evaluation_events_artifact[\s\S]*\(project, subject_type, subject_id, artifact_hash\)/i,
    );
  });

  it('DoD-1 / VT-01 Drizzle column names and nullability match the migration', () => {
    expectColumns(getTableColumns(workflowEvaluationDefinitions), DEFINITION_COLUMNS);
    expectColumns(getTableColumns(workflowEvaluationEvents), EVENT_COLUMNS);
    expectColumns(getTableColumns(workflowEvaluationJobs), JOB_COLUMNS);
    expect(Object.keys(getTableColumns(workflowEvaluationDefinitions))).not.toContain('project');
  });

  it('DoD-2 / VT-14 does not alter prds or interviews', () => {
    expect(tables.sql).not.toMatch(/ALTER\s+TABLE\s+prds\b/i);
    expect(tables.sql).not.toMatch(/ALTER\s+TABLE\s+interviews\b/i);
  });

  it('VT-01 Down drops jobs, events and definitions and their guard functions', () => {
    const jobsAt = tables.down.search(/DROP TABLE IF EXISTS workflow_evaluation_jobs/i);
    const eventsAt = tables.down.search(/DROP TABLE IF EXISTS workflow_evaluation_events/i);
    const definitionsAt = tables.down.search(/DROP TABLE IF EXISTS workflow_evaluation_definitions/i);
    expect(jobsAt).toBeGreaterThanOrEqual(0);
    expect(eventsAt).toBeGreaterThan(jobsAt);
    expect(definitionsAt).toBeGreaterThan(eventsAt);
    expect(tables.down).toMatch(/DROP TRIGGER IF EXISTS workflow_evaluation_events_immutable/i);
    expect(tables.down).toMatch(/DROP FUNCTION IF EXISTS workflow_evaluation_events_immutable/i);
    expect(tables.down).toMatch(/DROP TRIGGER IF EXISTS workflow_evaluation_definitions_active_only/i);
    expect(tables.down).toMatch(/DROP FUNCTION IF EXISTS workflow_evaluation_definitions_active_only/i);
  });
});
