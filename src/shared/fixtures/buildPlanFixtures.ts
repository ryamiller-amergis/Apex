/**
 * Plan fixtures for the schema (this feature) and the validator (FEAT-007).
 * Validator-stage plans are shape-valid on purpose.
 */
import type { BuildPlanViolationCode } from '../buildPlanSchema';

const reuse = (path: string) => [{ path }];

export const validSmallPlan = {
  classification: 'small' as const,
  tasks: [
    {
      key: 'implement-widget',
      role: 'implementer' as const,
      blockers: [],
      ownedFiles: ['src/widget.ts'],
      reuse: [{ path: 'src/shared/types/widget.ts', symbol: 'Widget', reason: 'existing type' }],
      runMode: 'own_agent' as const,
      covers: ['AC-1'],
    },
  ],
  tests: [
    {
      subjectId: 'AC-1',
      testRef: { path: 'src/widget.test.ts', name: 'creates a widget' },
      tier: 'unit' as const,
    },
  ],
  riskConstraints: [],
  contextNotesPath: 'docs/context-notes.md',
};

export const validFullPlan = {
  classification: 'full' as const,
  tasks: [
    {
      key: 'api',
      role: 'implementer' as const,
      blockers: [],
      ownedFiles: ['src/server/routes/widget.ts'],
      reuse: reuse('src/server/routes/health.ts'),
      runMode: 'own_agent' as const,
      covers: ['AC-1'],
    },
    {
      key: 'ui',
      role: 'implementer' as const,
      blockers: [],
      ownedFiles: ['src/client/components/Widget.tsx'],
      reuse: reuse('src/client/App.tsx'),
      runMode: 'own_agent' as const,
      covers: ['AC-2'],
    },
    {
      key: 'chain-head',
      role: 'implementer' as const,
      blockers: ['api'],
      ownedFiles: ['src/server/services/widgetService.ts'],
      reuse: reuse('src/server/services/featureRequestService.ts'),
      runMode: 'chain' as const,
      covers: ['DOD-1'],
    },
    {
      key: 'chain-tail',
      role: 'implementer' as const,
      blockers: ['chain-head'],
      ownedFiles: ['src/server/services/widgetWriter.ts'],
      reuse: reuse('src/server/services/prdService.ts'),
      runMode: 'chain' as const,
      covers: ['DOD-2'],
    },
    {
      key: 'qa-pass',
      role: 'qa' as const,
      blockers: ['ui', 'chain-tail'],
      ownedFiles: ['tests/e2e/specs/widget.spec.ts'],
      reuse: reuse('tests/e2e/support/auth.ts'),
      runMode: 'own_agent' as const,
      covers: ['RD-1'],
    },
  ],
  tests: [
    { subjectId: 'AC-1', testRef: { path: 'src/widget.test.ts', name: 'api' }, tier: 'unit' as const },
    { subjectId: 'AC-2', testRef: { path: 'src/ui.test.ts', name: 'ui' }, tier: 'unit' as const },
    { subjectId: 'DOD-1', testRef: { path: 'src/chain.test.ts', name: 'head' }, tier: 'integration' as const },
    { subjectId: 'DOD-2', testRef: { path: 'src/chain.test.ts', name: 'tail' }, tier: 'integration' as const },
    { subjectId: 'RD-1', testRef: { path: 'tests/e2e/specs/widget.spec.ts', name: 'risk' }, tier: 'e2e' as const },
  ],
  riskConstraints: [{ riskDecisionId: 'RD-1', constraint: 'Do not delete stored rows' }],
  scaffoldManifest: [
    { path: 'src/shared/types/widget.ts', kind: 'shared_types' as const },
    { path: 'migrations/widget.sql', kind: 'migration' as const },
    { path: 'src/server/db/schema.ts', kind: 'schema' as const },
    { path: 'src/server/index.ts', kind: 'router_mount' as const },
    { path: 'src/server/routes/widget.ts', kind: 'route_entry' as const },
    { path: 'src/client/components/AppHeader.tsx', kind: 'navigation_entry' as const },
    { path: 'src/client/components/Widget.tsx', kind: 'empty_component' as const },
    { path: 'src/widget.test.ts', kind: 'empty_test' as const },
  ],
  contextNotesPath: 'docs/context-notes.md',
};

export const validDeltaPlan = {
  classification: 'small' as const,
  tasks: [
    {
      key: 'follow-up',
      role: 'implementer' as const,
      blockers: ['kept-task'],
      ownedFiles: ['src/follow-up.ts'],
      reuse: reuse('src/widget.ts'),
      runMode: 'own_agent' as const,
      covers: ['AC-3'],
    },
  ],
  tests: [
    {
      subjectId: 'AC-3',
      testRef: { path: 'src/follow-up.test.ts', name: 'follow up' },
      tier: 'unit' as const,
    },
  ],
  riskConstraints: [],
  contextNotesPath: 'docs/context-notes.md',
  delta: { baseRevisionNumber: 1, carriedOverTaskKeys: ['kept-task'] },
};

export const validJustifiedPlan = {
  classification: 'small' as const,
  tasks: [
    {
      key: 'new-widget',
      role: 'implementer' as const,
      blockers: [],
      ownedFiles: ['src/new-widget.ts'],
      reuse: [],
      reuseJustification: {
        searches: ['widget helper'],
        conclusion: 'Nothing reusable exists',
      },
      runMode: 'own_agent' as const,
      covers: ['AC-1'],
    },
  ],
  tests: validSmallPlan.tests,
  riskConstraints: [],
  contextNotesPath: 'docs/context-notes.md',
};

export const validBuildPlans = [
  { id: 'valid-small', plan: validSmallPlan },
  { id: 'valid-full', plan: validFullPlan },
  { id: 'valid-delta', plan: validDeltaPlan },
  { id: 'valid-justified', plan: validJustifiedPlan },
] as const;

export interface BuildPlanInvalidFixture {
  id: string;
  stage: 'schema' | 'validator';
  expectedCode: BuildPlanViolationCode;
  reason: string;
  plan: unknown;
  requirements: Array<{ id: string; kind: string; text: string; retired: boolean }>;
  riskDecisions: Array<{ id: string; category: string; rating: string; decision: string; rationale: string }>;
}

const coveredRequirements = [
  { id: 'AC-1', kind: 'ac', text: 'API', retired: false },
  { id: 'AC-2', kind: 'ac', text: 'UI', retired: false },
  { id: 'DOD-1', kind: 'dod', text: 'Head', retired: false },
  { id: 'DOD-2', kind: 'dod', text: 'Tail', retired: false },
];

const coveredRisks = [
  { id: 'RD-1', category: 'data', rating: 'low', decision: 'keep', rationale: 'audit' },
];

function validatorFixture(
  id: string,
  expectedCode: BuildPlanViolationCode,
  reason: string,
  plan: unknown,
  requirements = coveredRequirements,
  riskDecisions = coveredRisks,
): BuildPlanInvalidFixture {
  return { id, stage: 'validator', expectedCode, reason, plan, requirements, riskDecisions };
}

const missingCovers = {
  ...validSmallPlan,
  tasks: [{ ...validSmallPlan.tasks[0], covers: undefined }],
};

const emptyReuse = {
  ...validSmallPlan,
  tasks: [{ ...validSmallPlan.tasks[0], reuse: [] }],
};

const unknownTask = {
  ...validSmallPlan,
  tasks: [{ ...validSmallPlan.tasks[0], extra: true }],
};

export const invalidBuildPlans: BuildPlanInvalidFixture[] = [
  {
    id: 'unknown-root-property',
    stage: 'schema',
    expectedCode: 'unknown_property',
    reason: 'A property the schema does not name is rejected at the root.',
    plan: { ...validSmallPlan, extra: true },
    requirements: [],
    riskDecisions: [],
  },
  {
    id: 'unknown-task-property',
    stage: 'schema',
    expectedCode: 'unknown_property',
    reason: 'A property the schema does not name is rejected on a task.',
    plan: unknownTask,
    requirements: [],
    riskDecisions: [],
  },
  {
    id: 'missing-covers',
    stage: 'schema',
    expectedCode: 'missing_field',
    reason: 'A task must name at least one requirement or risk decision.',
    plan: missingCovers,
    requirements: [],
    riskDecisions: [],
  },
  {
    id: 'empty-reuse',
    stage: 'schema',
    expectedCode: 'empty_reuse',
    reason: 'A task with an empty reuse list is rejected.',
    plan: emptyReuse,
    requirements: [],
    riskDecisions: [],
  },
  {
    id: 'full-without-scaffold',
    stage: 'schema',
    expectedCode: 'missing_field',
    reason: 'A full plan must include a scaffold manifest.',
    plan: { ...validFullPlan, scaffoldManifest: undefined },
    requirements: [],
    riskDecisions: [],
  },
  {
    id: 'small-with-scaffold',
    stage: 'schema',
    expectedCode: 'unknown_property',
    reason: 'A small plan must not include a scaffold manifest.',
    plan: { ...validSmallPlan, scaffoldManifest: validFullPlan.scaffoldManifest },
    requirements: [],
    riskDecisions: [],
  },
  validatorFixture(
    'task-cycle',
    'cycle',
    'Two tasks that block each other are a cycle.',
    {
      ...validSmallPlan,
      tasks: [
        { ...validSmallPlan.tasks[0], key: 'left', blockers: ['right'], covers: ['AC-1'] },
        {
          ...validSmallPlan.tasks[0],
          key: 'right',
          blockers: ['left'],
          ownedFiles: ['src/right.ts'],
          covers: ['AC-2'],
        },
      ],
    },
  ),
  validatorFixture(
    'duplicate-task-key',
    'duplicate_task_key',
    'Two tasks share a key.',
    {
      ...validSmallPlan,
      tasks: [
        validSmallPlan.tasks[0],
        { ...validSmallPlan.tasks[0], ownedFiles: ['src/other.ts'], covers: ['AC-2'] },
      ],
    },
  ),
  validatorFixture(
    'unknown-blocker',
    'unknown_blocker',
    'A blocker names a task that is not in the plan or the carry-over list.',
    {
      ...validSmallPlan,
      tasks: [{ ...validSmallPlan.tasks[0], blockers: ['missing-task'] }],
    },
  ),
  validatorFixture(
    'overlapping-owned-file',
    'overlapping_owned_file',
    'Two tasks own the same file.',
    {
      ...validSmallPlan,
      tasks: [
        validSmallPlan.tasks[0],
        {
          ...validSmallPlan.tasks[0],
          key: 'other',
          covers: ['AC-2'],
        },
      ],
    },
  ),
  validatorFixture(
    'uncovered-requirement',
    'uncovered_requirement',
    'A requirement on the revision is missing from every task.',
    validFullPlan,
    [...coveredRequirements, { id: 'AC-9', kind: 'ac', text: 'Missing', retired: false }],
  ),
  validatorFixture(
    'uncovered-risk-decision',
    'uncovered_risk_decision',
    'A risk decision on the revision is missing from every task.',
    validFullPlan,
    coveredRequirements,
    [...coveredRisks, { id: 'RD-9', category: 'access', rating: 'high', decision: 'review', rationale: 'open' }],
  ),
];
