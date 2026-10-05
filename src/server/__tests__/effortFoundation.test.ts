import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import {
  adrs,
  aiUsageEvents,
  designDocs,
  designPrototypes,
  interviews,
  prds,
  projectSkillSettings,
} from '../db/schema';
import { EFFORT_LEVELS, isEffortLevel, type EffortLevel } from '../../shared/types/effort';
import type {
  InterviewSkillOption,
  QuickMcpPillHttp,
  QuickMcpPillStdio,
  QuickSkillPill,
} from '../../shared/types/projectSettings';

const migrations = {
  projectSettings: path.resolve(
    process.cwd(),
    'migrations/20260908192024_f09a_project-skill-settings-effort-defaults.sql',
  ),
  artifacts: path.resolve(
    process.cwd(),
    'migrations/20260908192024_9f5e_artifact-effort-snapshot-columns.sql',
  ),
  usage: path.resolve(
    process.cwd(),
    'migrations/20260908192024_47d7_ai-usage-events-effort-column.sql',
  ),
};

const projectEffortColumns = [
  'interview_effort',
  'prd_effort',
  'adr_effort',
  'design_doc_effort',
  'design_doc_assistant_effort',
  'design_prototype_effort',
  'test_case_effort',
  'design_doc_validation_effort',
  'prd_assistant_effort',
  'prd_validation_effort',
  'development_effort',
  'standup_effort',
  'feature_request_effort',
  'technical_effort',
  'issue_effort',
  'calendar_assistant_effort',
  'load_test_generation_effort',
  'design_module_effort',
  'design_module_scoping_effort',
  'default_effort',
] as const;

const projectEffortProperties = [
  'interviewEffort',
  'prdEffort',
  'adrEffort',
  'designDocEffort',
  'designDocAssistantEffort',
  'designPrototypeEffort',
  'testCaseEffort',
  'designDocValidationEffort',
  'prdAssistantEffort',
  'prdValidationEffort',
  'developmentEffort',
  'standupEffort',
  'featureRequestEffort',
  'technicalEffort',
  'issueEffort',
  'calendarAssistantEffort',
  'loadTestGenerationEffort',
  'designModuleEffort',
  'designModuleScopingEffort',
  'defaultEffort',
] as const;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;

function splitMigration(filePath: string) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const [upSql = '', downSql = ''] = sql.split(/-- Down Migration/i);
  return { sql, upSql, downSql };
}

function addedColumns(sql: string, table: string): string[] {
  const statement = sql.match(new RegExp(`ALTER TABLE ${table}([\\s\\S]*?);`, 'i'))?.[1] ?? '';
  return [...statement.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+) TEXT/gi)].map(
    ([, column]) => column.toLowerCase(),
  );
}

function droppedColumns(sql: string, table: string): string[] {
  const statement = sql.match(new RegExp(`ALTER TABLE ${table}([\\s\\S]*?);`, 'i'))?.[1] ?? '';
  return [...statement.matchAll(/DROP COLUMN IF EXISTS ([a-z_]+)/gi)].map(
    ([, column]) => column.toLowerCase(),
  );
}

// TBI-001 DoD-3 compile-time contract for effort-bearing shared pill shapes.
const interviewOption: InterviewSkillOption = { path: 'skill.md', friendlyName: 'Skill', effort: 'low' };
const quickSkill: QuickSkillPill = { label: 'Skill', skillPath: 'skill.md', effort: null };
const quickHttp: QuickMcpPillHttp = {
  label: 'HTTP',
  mcpServerName: 'http',
  transport: 'http',
  url: 'https://example.test',
  effort: 'medium',
};
const quickStdio: QuickMcpPillStdio = {
  label: 'stdio',
  mcpServerName: 'stdio',
  transport: 'stdio',
  command: 'npx',
  effort: 'high',
};
// @ts-expect-error urgent is outside the closed effort contract
const invalidInterviewOption: InterviewSkillOption = { path: 'skill.md', friendlyName: 'Skill', effort: 'urgent' };
// @ts-expect-error urgent is outside the closed effort contract
const invalidQuickSkill: QuickSkillPill = { label: 'Skill', skillPath: 'skill.md', effort: 'urgent' };
// @ts-expect-error urgent is outside the closed effort contract
const invalidQuickHttp: QuickMcpPillHttp = { label: 'HTTP', mcpServerName: 'http', transport: 'http', url: 'https://example.test', effort: 'urgent' };
// @ts-expect-error urgent is outside the closed effort contract
const invalidQuickStdio: QuickMcpPillStdio = { label: 'stdio', mcpServerName: 'stdio', transport: 'stdio', command: 'npx', effort: 'urgent' };
void [
  interviewOption,
  quickSkill,
  quickHttp,
  quickStdio,
  invalidInterviewOption,
  invalidQuickSkill,
  invalidQuickHttp,
  invalidQuickStdio,
];

// TBI-001 DoD-1: every project setting effort column uses the shared nullable type.
type ProjectEffortProperty = (typeof projectEffortProperties)[number];
type ProjectEffortInsert = Pick<typeof projectSkillSettings.$inferInsert, ProjectEffortProperty>;
type ExpectedProjectEffortInsert = { [Key in ProjectEffortProperty]?: EffortLevel | null };
type ProjectEffortTypeContract = Assert<Equal<ProjectEffortInsert, ExpectedProjectEffortInsert>>;
const projectEffortTypeContract: ProjectEffortTypeContract = true;

// TBI-002 DoD-2: every artifact snapshot effort is nullable and optional on insert.
type ExpectedSnapshotEffort = EffortLevel | null | undefined;
type InterviewEffortContract = Assert<Equal<typeof interviews.$inferInsert.effort, ExpectedSnapshotEffort>>;
type AdrEffortContract = Assert<Equal<typeof adrs.$inferInsert.effort, ExpectedSnapshotEffort>>;
type PrdEffortContract = Assert<Equal<typeof prds.$inferInsert.effort, ExpectedSnapshotEffort>>;
type DesignDocEffortContract = Assert<Equal<typeof designDocs.$inferInsert.effort, ExpectedSnapshotEffort>>;
type PrototypeEffortContract = Assert<Equal<typeof designPrototypes.$inferInsert.effort, ExpectedSnapshotEffort>>;
const artifactEffortTypeContracts: [
  InterviewEffortContract,
  AdrEffortContract,
  PrdEffortContract,
  DesignDocEffortContract,
  PrototypeEffortContract,
] = [true, true, true, true, true];
void [projectEffortTypeContract, artifactEffortTypeContracts];

// TBI-003 DoD-2: Drizzle insert inference accepts omitted, null, and valid effort.
type AiUsageInsert = typeof aiUsageEvents.$inferInsert;
const usageBase = { provider: 'cursor', modelId: 'model', feature: 'test', project: 'Apex' };
const usageWithoutEffort: AiUsageInsert = usageBase;
const usageWithNullEffort: AiUsageInsert = { ...usageBase, effort: null };
const usageWithEffort: AiUsageInsert = { ...usageBase, effort: 'high' };
// @ts-expect-error urgent is outside the closed effort contract
const usageWithInvalidEffort: AiUsageInsert = { ...usageBase, effort: 'urgent' };
void [usageWithoutEffort, usageWithNullEffort, usageWithEffort, usageWithInvalidEffort];

describe('TBI-001 effort shared contract', () => {
  it('DoD-2 / VT-02 exports the exact canonical effort allow-list', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high']);
    const level: EffortLevel = EFFORT_LEVELS[0];
    expect(level).toBe('low');
  });

  it('DoD-2 / VT-08 accepts only low, medium, and high', () => {
    for (const value of EFFORT_LEVELS) expect(isEffortLevel(value)).toBe(true);
    for (const value of [null, undefined, '', 'urgent', 'LOW', 1, {}, []]) {
      expect(isEffortLevel(value)).toBe(false);
    }
  });

  it('DoD-1 exposes exactly 20 nullable typed project settings effort columns', () => {
    const columns = getTableColumns(projectSkillSettings);
    for (const property of projectEffortProperties) {
      expect(columns[property].name).toBe(projectEffortColumns[projectEffortProperties.indexOf(property)]);
      expect(columns[property].dataType).toBe('string');
      expect(columns[property].notNull).toBe(false);
    }
  });
});

describe('TBI-001 DoD-0 project settings effort migration', () => {
  const { upSql, downSql } = splitMigration(migrations.projectSettings);

  it('adds and rolls back exactly the 19 module efforts plus default effort', () => {
    expect(addedColumns(upSql, 'project_skill_settings')).toEqual(projectEffortColumns);
    expect(droppedColumns(downSql, 'project_skill_settings')).toEqual(projectEffortColumns);
  });

  it('NFR keeps additions nullable and unconstrained with no defaults, backfill, or indexes', () => {
    expect(upSql).not.toMatch(/\bNOT NULL\b|\bDEFAULT\b|\bCHECK\b|CREATE\s+(?:UNIQUE\s+)?INDEX|\bUPDATE\b|\bINSERT\b/i);
  });
});

describe('TBI-002 artifact effort snapshots', () => {
  const artifactTables = ['interviews', 'adrs', 'prds', 'design_docs', 'design_prototypes'] as const;
  const { upSql, downSql } = splitMigration(migrations.artifacts);

  it('DoD-0/1 adds and rolls back nullable effort TEXT on all five artifact tables', () => {
    for (const table of artifactTables) {
      expect(addedColumns(upSql, table)).toEqual(['effort']);
      expect(droppedColumns(downSql, table)).toEqual(['effort']);
    }
  });

  it('NFR has no artifact backfill, default, NOT NULL, constraint, or effort index', () => {
    expect(upSql).not.toMatch(/\bNOT NULL\b|\bDEFAULT\b|\bCHECK\b|CREATE\s+(?:UNIQUE\s+)?INDEX|\bUPDATE\b|\bINSERT\b/i);
  });

  it('DoD-2 exposes nullable effort columns beside model in all five Drizzle tables', () => {
    for (const table of [interviews, adrs, prds, designDocs, designPrototypes]) {
      const columns = getTableColumns(table);
      expect(columns.effort.name).toBe('effort');
      expect(columns.effort.dataType).toBe('string');
      expect(columns.effort.notNull).toBe(false);
    }
  });
});

describe('TBI-003 AI usage effort', () => {
  const { upSql, downSql } = splitMigration(migrations.usage);

  it('DoD-0 adds one nullable effort TEXT column and rolls it back', () => {
    expect(addedColumns(upSql, 'ai_usage_events')).toEqual(['effort']);
    expect(droppedColumns(downSql, 'ai_usage_events')).toEqual(['effort']);
  });

  it('DoD-0 NFR adds no default, backfill, constraint, or index', () => {
    expect(upSql).not.toMatch(/\bNOT NULL\b|\bDEFAULT\b|\bCHECK\b|CREATE\s+(?:UNIQUE\s+)?INDEX|\bUPDATE\b|\bINSERT\b/i);
  });

  it('DoD-1 exposes nullable typed effort in the Drizzle schema', () => {
    const effort = getTableColumns(aiUsageEvents).effort;
    expect(effort.name).toBe('effort');
    expect(effort.dataType).toBe('string');
    expect(effort.notNull).toBe(false);
  });
});
