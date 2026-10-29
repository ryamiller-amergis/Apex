/**
 * Build-plan shape check. Meaning (cycles, coverage, file overlap) belongs to FEAT-007.
 */
import { toJSONSchema, z } from 'zod';
import {
  BUILD_CLASSIFICATIONS,
  BUILD_PLAN_TASK_ROLES,
  BUILD_REQUIREMENT_ID_PATTERN,
  BUILD_RISK_DECISION_ID_PATTERN,
  BUILD_SCAFFOLD_KINDS,
  BUILD_TASK_KEY_PATTERN,
  BUILD_TASK_RUN_MODES,
  BUILD_TEST_TIERS,
} from './types/build';

export const BUILD_PLAN_VIOLATION_CODES = [
  'unknown_property',
  'missing_field',
  'invalid_value',
  'empty_reuse',
  'cycle',
  'duplicate_task_key',
  'unknown_blocker',
  'overlapping_owned_file',
  'uncovered_requirement',
  'uncovered_risk_decision',
] as const;

export type BuildPlanViolationCode = (typeof BUILD_PLAN_VIOLATION_CODES)[number];

export type BuildPlanSchemaViolationCode = Extract<
  BuildPlanViolationCode,
  'unknown_property' | 'missing_field' | 'invalid_value' | 'empty_reuse'
>;

const taskKeySchema = z.string().regex(BUILD_TASK_KEY_PATTERN);
const subjectIdSchema = z.string().regex(
  new RegExp(`${BUILD_REQUIREMENT_ID_PATTERN.source}|${BUILD_RISK_DECISION_ID_PATTERN.source}`),
);
const singleLineSchema = z.string().min(1).max(200).refine(
  (value) => !/[\r\n]/.test(value),
  { message: 'single line' },
);

const relativePathSchema = singleLineSchema.refine(
  (value) => !value.startsWith('/') && !value.split('/').includes('..'),
  { message: 'repository-relative path' },
);

const reuseEntrySchema = z.strictObject({
  path: relativePathSchema,
  symbol: singleLineSchema.optional(),
  reason: singleLineSchema.optional(),
});

const reuseJustificationSchema = z.strictObject({
  searches: z.array(singleLineSchema).min(1),
  conclusion: singleLineSchema,
});

const taskSchema = z.strictObject({
  key: taskKeySchema,
  role: z.enum(BUILD_PLAN_TASK_ROLES),
  blockers: z.array(taskKeySchema),
  ownedFiles: z.array(relativePathSchema),
  reuse: z.array(reuseEntrySchema),
  reuseJustification: reuseJustificationSchema.optional(),
  runMode: z.enum(BUILD_TASK_RUN_MODES),
  covers: z.array(subjectIdSchema).min(1),
}).superRefine((task, ctx) => {
  if (task.reuse.length === 0 && task.reuseJustification == null) {
    ctx.addIssue({
      code: 'custom',
      path: ['reuse'],
      message: 'empty reuse',
    });
  }
});

const testRefSchema = z.strictObject({
  path: relativePathSchema,
  name: z.string().min(1),
});

const testSchema = z.strictObject({
  subjectId: subjectIdSchema,
  testRef: testRefSchema,
  tier: z.enum(BUILD_TEST_TIERS),
});

const riskConstraintSchema = z.strictObject({
  riskDecisionId: z.string().regex(BUILD_RISK_DECISION_ID_PATTERN),
  constraint: z.string().min(1),
});

const scaffoldEntrySchema = z.strictObject({
  path: relativePathSchema,
  kind: z.enum(BUILD_SCAFFOLD_KINDS),
});

const deltaSchema = z.strictObject({
  baseRevisionNumber: z.number().int().positive(),
  carriedOverTaskKeys: z.array(taskKeySchema),
});

const planFields = {
  tasks: z.array(taskSchema).min(1),
  tests: z.array(testSchema),
  riskConstraints: z.array(riskConstraintSchema),
  contextNotesPath: relativePathSchema,
  delta: deltaSchema.optional(),
};

const smallPlanSchema = z.strictObject({
  classification: z.literal(BUILD_CLASSIFICATIONS[0]),
  ...planFields,
});

const fullPlanSchema = z.strictObject({
  classification: z.literal(BUILD_CLASSIFICATIONS[1]),
  ...planFields,
  scaffoldManifest: z.array(scaffoldEntrySchema).min(1),
});

export const buildPlanSchema = z.discriminatedUnion('classification', [
  smallPlanSchema,
  fullPlanSchema,
]);

export type BuildPlan = z.infer<typeof buildPlanSchema>;

export const BUILD_PLAN_JSON_SCHEMA: Record<string, unknown> = toJSONSchema(buildPlanSchema) as Record<string, unknown>;

export type BuildPlanParseResult =
  | { success: true; data: BuildPlan }
  | { success: false; code: BuildPlanSchemaViolationCode };

export function buildPlanIssueCode(issue: z.ZodError['issues'][number]): BuildPlanSchemaViolationCode | null {
  if (issue.code === 'unrecognized_keys') return 'unknown_property';
  const last = issue.path[issue.path.length - 1];
  if (last === 'reuse' && (issue.code === 'too_small' || issue.code === 'custom')) return 'empty_reuse';
  if (issue.code === 'invalid_type' && issue.message.includes('received undefined')) {
    return 'missing_field';
  }
  return null;
}

export function buildPlanViolationCode(error: z.ZodError): BuildPlanSchemaViolationCode {
  for (const issue of error.issues) {
    const code = buildPlanIssueCode(issue);
    if (code === 'unknown_property' || code === 'empty_reuse' || code === 'missing_field') {
      return code;
    }
  }
  return 'invalid_value';
}

export function parseBuildPlan(input: unknown): BuildPlanParseResult {
  const parsed = buildPlanSchema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };
  return { success: false, code: buildPlanViolationCode(parsed.error) };
}

export interface PlanViolation {
  code: BuildPlanViolationCode;
  message: string;
  taskKeys?: string[];
  requirementId?: string;
  riskDecisionId?: string;
  path?: string;
}

export type PlanValidationResult =
  | { ok: true }
  | { ok: false; violations: PlanViolation[] };
