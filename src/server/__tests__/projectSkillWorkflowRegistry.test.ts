import { getTableColumns } from 'drizzle-orm';
import { projectSkillSettings } from '../db/schema';
import {
  PROJECT_SKILL_WORKFLOWS,
  PROJECT_SKILL_WORKFLOW_FIELDS,
} from '../../shared/constants/projectSkillWorkflows';

const legacyColumns = getTableColumns(projectSkillSettings);

/** SQL names of every per-workflow column on project_skill_settings. */
const workflowColumnPattern =
  /(_skill_path|_model|_effort|_bedrock_[a-z_]+|_score_threshold)$/;
const projectWideColumns = new Set(['default_model', 'default_effort']);

function schemaWorkflowColumnNames(): string[] {
  return Object.values(legacyColumns)
    .map((column) => column.name)
    .filter(
      (name) => workflowColumnPattern.test(name) && !projectWideColumns.has(name),
    )
    .sort();
}

describe('project skill workflow registry', () => {
  it('uses unique snake_case workflow keys', () => {
    const keys = PROJECT_SKILL_WORKFLOWS.map((workflow) => workflow.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('does not store workflow fields as columns on project_skill_settings', () => {
    for (const workflow of PROJECT_SKILL_WORKFLOWS) {
      for (const [field, legacyField] of Object.entries(workflow.legacy)) {
        expect(PROJECT_SKILL_WORKFLOW_FIELDS).toContain(field);
        expect(legacyColumns).not.toHaveProperty(legacyField as string);
      }
    }
    expect(schemaWorkflowColumnNames()).toEqual([]);
  });

  it('gives each legacy column to one workflow, except the shared ADR model and effort', () => {
    const owners = new Map<string, string[]>();
    for (const workflow of PROJECT_SKILL_WORKFLOWS) {
      for (const legacyField of Object.values(workflow.legacy)) {
        owners.set(legacyField as string, [
          ...(owners.get(legacyField as string) ?? []),
          workflow.key,
        ]);
      }
    }
    const shared = [...owners.entries()].filter(([, keys]) => keys.length > 1);
    expect(Object.fromEntries(shared)).toEqual({
      adrModel: ['adr_interview', 'adr_finalize', 'adr_assistant'],
      adrEffort: ['adr_interview', 'adr_finalize', 'adr_assistant'],
    });
  });

  it('keeps the plan workflow names for the examples it lists', () => {
    const keys = PROJECT_SKILL_WORKFLOWS.map((workflow) => workflow.key);
    expect(keys).toEqual(
      expect.arrayContaining(['interview', 'prd', 'adr_finalize', 'ui_lab', 'standup']),
    );
  });
});
