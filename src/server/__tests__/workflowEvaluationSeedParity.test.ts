/**
 * TBI-002 — seeded definitions stay in step with the shared constants.
 * Covers DoD-0 through DoD-3, the idempotent-version NFR, VT-13 and VT-14.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toJSONSchema } from 'zod';
import {
  WORKFLOW_EVALUATION_BENCHMARK_KEY,
  WORKFLOW_EVALUATION_CRITERIA_KEYS,
  WORKFLOW_EVALUATION_DEFINITION_EVALUATOR_KEY,
  WORKFLOW_EVALUATION_INTERVIEW_PHASE_RUBRIC,
  WORKFLOW_EVALUATION_OUTCOMES,
  WORKFLOW_EVALUATION_PRD_RUBRIC,
  WORKFLOW_EVALUATION_PROCESS_KEY,
  WORKFLOW_EVALUATION_REASON_CODES,
  WORKFLOW_EVALUATION_REVIEWER_ROLE_KEYS,
  WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS,
  workflowEvaluationJudgeOutputSchema,
  workflowEvaluationPromptfooSuiteRef,
  type WorkflowEvaluationRubric,
} from '../../shared/types/workflowEvaluation';

function seedMigration(): { up: string; down: string } {
  const dir = path.resolve(process.cwd(), 'migrations');
  const matches = fs.readdirSync(dir).filter((name) => name.endsWith('_workflow-evaluation-seeds.sql'));
  if (matches.length !== 1) {
    throw new Error(`Expected one seed migration, found ${matches.length}`);
  }
  const sql = fs.readFileSync(path.join(dir, matches[0]), 'utf8');
  const [up = '', down = ''] = sql.split(/-- Down Migration/i);
  return { up, down };
}

function dollarBlocks(sql: string, tag: string): string[] {
  const pattern = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`, 'g');
  const blocks: string[] = [];
  let match = pattern.exec(sql);
  while (match) {
    blocks.push(match[1]);
    match = pattern.exec(sql);
  }
  return blocks;
}

function stripComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}

describe('TBI-002 / VT-13 / VT-14 — evaluation definition seed', () => {
  const seed = seedMigration();
  const rubrics = dollarBlocks(seed.up, 'rubric').map(
    (block) => JSON.parse(block) as WorkflowEvaluationRubric,
  );
  const judgeSchemas = dollarBlocks(seed.up, 'judge').map(
    (block) => JSON.parse(block) as Record<string, unknown>,
  );

  it('DoD-0 seeds the four orchestrated_workflow stages once', () => {
    expect(seed.up).toContain(`'${WORKFLOW_EVALUATION_PROCESS_KEY}'`);
    expect(seed.up).toContain(`'${WORKFLOW_EVALUATION_DEFINITION_EVALUATOR_KEY}'`);
    expect(seed.up).toContain(`'${WORKFLOW_EVALUATION_BENCHMARK_KEY}'`);
    for (const stageKey of WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS) {
      expect(seed.up).toContain(`'${stageKey}'`);
    }
    expect(rubrics).toHaveLength(4);
  });

  it('DoD-1 / VT-13 criteria, reason codes, outcomes and roles match the shared constants in order', () => {
    const expected = [
      WORKFLOW_EVALUATION_PRD_RUBRIC,
      WORKFLOW_EVALUATION_INTERVIEW_PHASE_RUBRIC,
      WORKFLOW_EVALUATION_INTERVIEW_PHASE_RUBRIC,
      WORKFLOW_EVALUATION_INTERVIEW_PHASE_RUBRIC,
    ];
    expect(rubrics).toEqual(expected);
    for (const rubric of rubrics) {
      expect(rubric.criteria.map((criterion) => criterion.key)).toEqual([
        ...WORKFLOW_EVALUATION_CRITERIA_KEYS,
      ]);
      expect(rubric.reasonCodes.map((reason) => reason.key)).toEqual([
        ...WORKFLOW_EVALUATION_REASON_CODES,
      ]);
      expect(rubric.outcomes.map((outcome) => outcome.key)).toEqual([
        ...WORKFLOW_EVALUATION_OUTCOMES,
      ]);
      expect(rubric.allowedReviewerRoles.map((role) => role.key)).toEqual([
        ...WORKFLOW_EVALUATION_REVIEWER_ROLE_KEYS,
      ]);
    }
  });

  it('DoD-2 / VT-13 every row has a non-blank Promptfoo suite reference and a judge schema', () => {
    for (const stageKey of WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS) {
      const suiteRef = workflowEvaluationPromptfooSuiteRef(stageKey);
      expect(suiteRef.trim().length).toBeGreaterThan(0);
      expect(seed.up).toContain(`'${suiteRef}'`);
    }
    expect(judgeSchemas).toHaveLength(4);
    const expectedSchema = toJSONSchema(workflowEvaluationJudgeOutputSchema);
    for (const schema of judgeSchemas) {
      expect(schema).toEqual(expectedSchema);
    }
  });

  it('DoD-3 re-running the seed is ON CONFLICT DO NOTHING', () => {
    expect(seed.up).toMatch(
      /ON\s+CONFLICT\s*\(\s*process_key\s*,\s*stage_key\s*,\s*evaluator_key\s*,\s*benchmark_key\s*,\s*version\s*\)\s+DO\s+NOTHING/i,
    );
  });

  it('VT-14 the seed does not UPDATE an existing rubric, and definitions have no project column', () => {
    expect(stripComments(seed.up)).not.toMatch(/\bUPDATE\b/i);
    expect(stripComments(seed.down)).not.toMatch(/\bUPDATE\b/i);
    const truncateAt = seed.down.search(
      /TRUNCATE\s+workflow_evaluation_jobs\s*,\s*workflow_evaluation_events/i,
    );
    const deleteAt = seed.down.search(/DELETE\s+FROM\s+workflow_evaluation_definitions/i);
    expect(truncateAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(truncateAt);
    const tablesDir = path.resolve(process.cwd(), 'migrations');
    const tablesFile = fs
      .readdirSync(tablesDir)
      .find((name) => name.endsWith('_workflow-evaluation-tables.sql'));
    expect(tablesFile).toBeDefined();
    const tablesSql = fs.readFileSync(path.join(tablesDir, tablesFile as string), 'utf8');
    const createDefs = tablesSql.match(
      /CREATE TABLE workflow_evaluation_definitions \([\s\S]*?\);/i,
    );
    expect(createDefs?.[0] ?? '').not.toMatch(/\bproject\b/i);
  });
});
