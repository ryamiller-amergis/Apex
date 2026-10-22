import type {
  ListWorkflowEvaluationEventsResponse,
  WorkflowEvaluationEvent,
} from '../../../shared/types/workflowEvaluation';
import { hasCurrentOwnerFeedback } from '../prdOwnerFeedback';

const CURRENT = 'a'.repeat(64);
const OLDER = 'b'.repeat(64);

function event(overrides: Partial<WorkflowEvaluationEvent>): WorkflowEvaluationEvent {
  return {
    id: 'evt',
    projectId: 'Apex',
    processKey: 'orchestrated_workflow',
    stageKey: 'prd_human_review',
    definitionId: 'def',
    definitionVersion: 1,
    subjectType: 'prd',
    subjectId: 'prd-1',
    phaseIndex: null,
    reviewerUserId: 'owner-1',
    reviewerName: 'Owner',
    reviewerRoleKey: 'prd_owner',
    reviewerRoleLabel: 'PRD owner',
    lineage: { skillPath: null, skillVersion: null, model: null, interviewId: null, prdId: 'prd-1' },
    artifactContentHash: CURRENT,
    criteria: {
      intent_alignment: 4,
      requirements_coverage: 4,
      scope_alignment: 4,
      acceptance_criteria: 4,
      readiness: 4,
    },
    outcome: 'accept_unchanged',
    reasonCodes: [],
    comment: null,
    hasCorrectedArtifact: false,
    createdAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

function response(
  events: WorkflowEvaluationEvent[],
  currentArtifactHash: string | null = CURRENT,
): ListWorkflowEvaluationEventsResponse {
  return { events, truncated: false, currentArtifactHash };
}

describe('hasCurrentOwnerFeedback', () => {
  it('is true for this user as PRD owner on the current version', () => {
    expect(hasCurrentOwnerFeedback(response([event({})]), 'owner-1')).toBe(true);
  });

  it('ignores another user, another role and an older version', () => {
    expect(hasCurrentOwnerFeedback(response([event({ reviewerUserId: 'someone-else' })]), 'owner-1')).toBe(false);
    expect(hasCurrentOwnerFeedback(response([event({ reviewerRoleKey: 'qa' })]), 'owner-1')).toBe(false);
    expect(hasCurrentOwnerFeedback(response([event({ artifactContentHash: OLDER })]), 'owner-1')).toBe(false);
  });

  it('accepts any owner feedback when the current version has no fingerprint', () => {
    expect(hasCurrentOwnerFeedback(response([event({ artifactContentHash: OLDER })], null), 'owner-1')).toBe(true);
  });

  it('is false while loading or without a user', () => {
    expect(hasCurrentOwnerFeedback(undefined, 'owner-1')).toBe(false);
    expect(hasCurrentOwnerFeedback(response([event({})]), null)).toBe(false);
  });
});
