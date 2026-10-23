/**
 * TBI-002 DoD-2 / VT-09 / VT-13 — final vocabularies, transitions, ids, branch names.
 */
import {
  BUILD_CLASSIFICATIONS,
  BUILD_CORRELATION_KINDS,
  BUILD_DEPLOYMENT_STATUSES,
  BUILD_EVENT_SEVERITIES,
  BUILD_EVENT_TYPES,
  BUILD_EVENT_TYPE_PATTERN,
  BUILD_PLAN_TASK_ROLES,
  BUILD_PROFILE_ROLES,
  BUILD_REQUIREMENT_ID_PATTERN,
  BUILD_REQUIREMENT_KINDS,
  BUILD_RISK_CATEGORIES,
  BUILD_RISK_DECISION_ID_PATTERN,
  BUILD_RISK_RATINGS,
  BUILD_RUN_SLOT_STATUSES,
  BUILD_RUN_STAGE_STATUSES,
  BUILD_RUN_STATUSES,
  BUILD_RUN_TERMINAL_STATUSES,
  BUILD_SCAFFOLD_KINDS,
  BUILD_SUSPEND_REASONS,
  BUILD_TASK_KEY_PATTERN,
  BUILD_TASK_ROLES,
  BUILD_TASK_RUN_MODES,
  BUILD_TASK_STATUSES,
  BUILD_TEST_TIERS,
  BUILD_VERIFICATION_KINDS,
  BUILD_VERIFICATION_STATUSES,
  integrationBranchName,
  isLegalBuildDeploymentTransition,
  isLegalBuildRunTransition,
  isLegalBuildTaskTransition,
  taskBranchName,
} from '../../shared/types/build';

describe('VT-09 final build vocabularies', () => {
  it('VT-09 pins each vocabulary in order', () => {
    expect([...BUILD_RUN_STATUSES]).toEqual([
      'queued', 'intake', 'planning', 'building', 'checking', 'deploying',
      'preview_ready', 'suspended', 'deployment_failed', 'needs_developer',
      'accepted', 'cancelled', 'failed',
    ]);
    expect([...BUILD_SUSPEND_REASONS]).toEqual([
      'cost_cap', 'elapsed_cap', 'repair_cap', 'flag_disabled',
      'permission_revoked', 'configuration', 'plan_invalid',
    ]);
    expect([...BUILD_TASK_STATUSES]).toEqual(['pending', 'ready', 'running', 'merged', 'failed', 'omitted']);
    expect([...BUILD_TASK_ROLES]).toEqual(['planner', 'implementer', 'qa', 'check', 'sync']);
    expect([...BUILD_PLAN_TASK_ROLES]).toEqual(['implementer', 'qa']);
    expect([...BUILD_TASK_RUN_MODES]).toEqual(['own_agent', 'chain']);
    expect([...BUILD_VERIFICATION_KINDS]).toEqual(['ac', 'dod', 'br', 'nfr', 'risk_decision']);
    expect([...BUILD_VERIFICATION_STATUSES]).toEqual(['pending', 'pass', 'fail', 'deferred', 'retired']);
    expect([...BUILD_DEPLOYMENT_STATUSES]).toEqual(['not_started', 'queued', 'deploying', 'succeeded', 'failed']);
    expect([...BUILD_CLASSIFICATIONS]).toEqual(['small', 'full']);
    expect([...BUILD_RISK_RATINGS]).toEqual(['low', 'medium', 'high']);
    expect([...BUILD_RISK_CATEGORIES]).toEqual(['data', 'access', 'integration', 'destructive']);
    expect([...BUILD_REQUIREMENT_KINDS]).toEqual(['ac', 'dod', 'br', 'nfr']);
    expect([...BUILD_TEST_TIERS]).toEqual(['unit', 'integration', 'e2e']);
    expect([...BUILD_EVENT_SEVERITIES]).toEqual(['info', 'warn', 'error']);
    expect([...BUILD_CORRELATION_KINDS]).toEqual(['agent_run', 'pipeline_run', 'pull_request', 'commit']);
    expect([...BUILD_PROFILE_ROLES]).toEqual(['intake', 'planner', 'implementer', 'qa', 'check']);
    expect([...BUILD_SCAFFOLD_KINDS]).toEqual([
      'shared_types', 'migration', 'schema', 'router_mount', 'route_entry',
      'navigation_entry', 'empty_component', 'empty_test',
    ]);
    expect([...BUILD_EVENT_TYPES]).toEqual([
      'build.queued', 'build.started', 'intake.brief_approved', 'plan.validated', 'plan.invalid',
      'task.launched', 'task.completed', 'task.merged', 'task.failed', 'check.passed',
      'deploy.queued', 'deploy.started', 'deploy.succeeded', 'deploy.failed',
      'revision.requested', 'pull_request.opened', 'run.suspended', 'run.resumed',
      'run.cap_extended', 'run.cancelled', 'run.failed',
    ]);
  });

  it('VT-09 pins terminal and slot sets', () => {
    expect([...BUILD_RUN_TERMINAL_STATUSES]).toEqual(['accepted', 'cancelled', 'failed']);
    expect([...BUILD_RUN_SLOT_STATUSES]).toEqual(['intake', 'planning', 'building', 'checking', 'deploying']);
    expect([...BUILD_RUN_STAGE_STATUSES]).toEqual([...BUILD_RUN_SLOT_STATUSES]);
  });

  it('VT-09 allows the legal run edges and rejects the illegal ones', () => {
    expect(isLegalBuildRunTransition('queued', 'intake')).toBe(true);
    expect(isLegalBuildRunTransition('queued', 'cancelled')).toBe(true);
    expect(isLegalBuildRunTransition('queued', 'building')).toBe(false);
    expect(isLegalBuildRunTransition('intake', 'planning')).toBe(true);
    expect(isLegalBuildRunTransition('intake', 'building')).toBe(true);
    expect(isLegalBuildRunTransition('building', 'checking')).toBe(true);
    expect(isLegalBuildRunTransition('building', 'deploying')).toBe(true);
    expect(isLegalBuildRunTransition('checking', 'building')).toBe(true);
    expect(isLegalBuildRunTransition('deploying', 'preview_ready')).toBe(true);
    expect(isLegalBuildRunTransition('deploying', 'deployment_failed')).toBe(true);
    expect(isLegalBuildRunTransition('preview_ready', 'accepted')).toBe(true);
    expect(isLegalBuildRunTransition('preview_ready', 'needs_developer')).toBe(true);
    expect(isLegalBuildRunTransition('deployment_failed', 'deploying')).toBe(true);
    expect(isLegalBuildRunTransition('needs_developer', 'cancelled')).toBe(true);
    expect(isLegalBuildRunTransition('needs_developer', 'intake')).toBe(false);
    expect(isLegalBuildRunTransition('accepted', 'cancelled')).toBe(false);
    expect(isLegalBuildRunTransition('suspended', 'planning', 'planning')).toBe(true);
    expect(isLegalBuildRunTransition('suspended', 'building', 'planning')).toBe(false);
    expect(isLegalBuildRunTransition('suspended', 'cancelled', 'planning')).toBe(true);
    expect(isLegalBuildRunTransition('suspended', 'failed')).toBe(true);
  });

  it('VT-09 allows the legal task and deployment edges', () => {
    expect(isLegalBuildTaskTransition('pending', 'ready')).toBe(true);
    expect(isLegalBuildTaskTransition('pending', 'omitted')).toBe(true);
    expect(isLegalBuildTaskTransition('ready', 'running')).toBe(true);
    expect(isLegalBuildTaskTransition('running', 'merged')).toBe(true);
    expect(isLegalBuildTaskTransition('running', 'failed')).toBe(true);
    expect(isLegalBuildTaskTransition('running', 'ready')).toBe(true);
    expect(isLegalBuildTaskTransition('failed', 'ready')).toBe(true);
    expect(isLegalBuildTaskTransition('merged', 'ready')).toBe(false);
    expect(isLegalBuildTaskTransition('omitted', 'ready')).toBe(false);
    expect(isLegalBuildDeploymentTransition('not_started', 'queued')).toBe(true);
    expect(isLegalBuildDeploymentTransition('queued', 'deploying')).toBe(true);
    expect(isLegalBuildDeploymentTransition('deploying', 'succeeded')).toBe(true);
    expect(isLegalBuildDeploymentTransition('deploying', 'failed')).toBe(true);
    expect(isLegalBuildDeploymentTransition('failed', 'queued')).toBe(true);
    expect(isLegalBuildDeploymentTransition('succeeded', 'queued')).toBe(false);
  });
});

describe('VT-13 branch names and id patterns', () => {
  it('VT-13 builds branch names that are not prefix paths of each other', () => {
    const runId = '6f1e2d3c-4b5a-6978-90ab-cdef12345678';
    const integration = integrationBranchName(runId);
    const task = taskBranchName(runId, 'implement-widget');
    expect(integration).toBe(`apex/build/${runId}`);
    expect(task).toBe(`apex/build-task/${runId}/implement-widget`);
    expect(task.startsWith(`${integration}/`)).toBe(false);
    expect(integration.startsWith(`${task}/`)).toBe(false);
  });

  it('VT-13 accepts positive requirement and risk ids and rejects the rest', () => {
    expect(BUILD_REQUIREMENT_ID_PATTERN.test('AC-1')).toBe(true);
    expect(BUILD_REQUIREMENT_ID_PATTERN.test('DOD-12')).toBe(true);
    expect(BUILD_REQUIREMENT_ID_PATTERN.test('BR-3')).toBe(true);
    expect(BUILD_REQUIREMENT_ID_PATTERN.test('NFR-4')).toBe(true);
    expect(BUILD_REQUIREMENT_ID_PATTERN.test('AC-0')).toBe(false);
    expect(BUILD_REQUIREMENT_ID_PATTERN.test('AC-01')).toBe(false);
    expect(BUILD_REQUIREMENT_ID_PATTERN.test('ac-1')).toBe(false);
    expect(BUILD_RISK_DECISION_ID_PATTERN.test('RD-2')).toBe(true);
    expect(BUILD_RISK_DECISION_ID_PATTERN.test('RD-0')).toBe(false);
    expect(BUILD_TASK_KEY_PATTERN.test('implement-widget')).toBe(true);
    expect(BUILD_TASK_KEY_PATTERN.test('A')).toBe(false);
    expect(BUILD_TASK_KEY_PATTERN.test('1task')).toBe(false);
    expect(BUILD_TASK_KEY_PATTERN.test('a'.repeat(41))).toBe(false);
    expect(BUILD_TASK_KEY_PATTERN.test('a'.repeat(40))).toBe(true);
    expect(BUILD_EVENT_TYPE_PATTERN.test('run.cap_extended')).toBe(true);
    expect(BUILD_EVENT_TYPE_PATTERN.test('Run.Started')).toBe(false);
  });
});
