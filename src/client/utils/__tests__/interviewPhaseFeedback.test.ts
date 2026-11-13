import type {
  ListWorkflowEvaluationEventsResponse,
  WorkflowEvaluationEvent,
} from '../../../shared/types/workflowEvaluation';
import { interviewFeedbackGate, type InterviewFeedbackGateInput } from '../interviewPhaseFeedback';
import { startedInterviewPhases } from '../interviewPhaseProgress';

const HASH = 'a'.repeat(64);

function events(...reviewers: string[]): ListWorkflowEvaluationEventsResponse {
  return {
    events: reviewers.map((reviewerUserId, index) => ({
      id: `evt-${index}`,
      reviewerUserId,
      artifactContentHash: HASH,
    }) as unknown as WorkflowEvaluationEvent),
    truncated: false,
    currentArtifactHash: HASH,
  };
}

function input(overrides: Partial<InterviewFeedbackGateInput> = {}): InterviewFeedbackGateInput {
  return {
    startedPhases: new Set(['discovery', 'delivery']),
    deliveryComplete: true,
    baUserId: 'ba',
    technicalUserId: 'tech',
    feedback: { 1: events(), 2: events(), 3: events() },
    ...overrides,
  };
}

describe('startedInterviewPhases', () => {
  it('reads opened phases from markers and ignores a skipped Technical phase', () => {
    const started = startedInterviewPhases([
      '[[interview-phase:discovery:1]] Q1',
      '[[interview-phase:discovery:done]] [[interview-phase:delivery:1]] Q',
      '[[interview-phase:delivery:done]]',
      '[[interview-phase:technical:skipped]]',
    ]);
    expect([...started].sort()).toEqual(['delivery', 'discovery']);
  });

  it('is empty before the first marker', () => {
    expect(startedInterviewPhases(['Hello', '']).size).toBe(0);
  });
});

describe('interviewFeedbackGate', () => {
  it('locks the chat once Delivery is done until the BA rates both phases', () => {
    const gate = interviewFeedbackGate(input());
    expect(gate.baPhasesMissing).toEqual([1, 2]);
    expect(gate.chatLockedForBa).toBe(true);
    expect(gate.completeBlocked).toBe(true);
  });

  it('only counts feedback from the BA on the current version', () => {
    const stale = { ...events('ba'), currentArtifactHash: 'b'.repeat(64) };
    const gate = interviewFeedbackGate(input({ feedback: { 1: events('someone-else'), 2: stale, 3: events() } }));
    expect(gate.baPhasesMissing).toEqual([1, 2]);
  });

  it('unlocks once the BA has rated Discovery and Delivery', () => {
    const gate = interviewFeedbackGate(input({ feedback: { 1: events('ba'), 2: events('ba'), 3: events() } }));
    expect(gate.chatLockedForBa).toBe(false);
    expect(gate.completeBlocked).toBe(false);
  });

  it('does not lock the chat while Delivery is still running, but still blocks completion', () => {
    const gate = interviewFeedbackGate(input({ deliveryComplete: false, feedback: { 1: events('ba'), 2: events(), 3: events() } }));
    expect(gate.chatLockedForBa).toBe(false);
    expect(gate.baPhasesMissing).toEqual([2]);
    expect(gate.completeBlocked).toBe(true);
  });

  it('requires Technical feedback from the technical reviewer only when Technical ran', () => {
    const rated = { 1: events('ba'), 2: events('ba') };
    const skipped = interviewFeedbackGate(input({ feedback: { ...rated, 3: events() } }));
    expect(skipped.technicalMissing).toBe(false);

    const ran = interviewFeedbackGate(input({
      startedPhases: new Set(['discovery', 'delivery', 'technical']),
      feedback: { ...rated, 3: events('ba') },
    }));
    expect(ran.technicalMissing).toBe(true);
    expect(ran.chatLockedForBa).toBe(false);
    expect(ran.completeBlocked).toBe(true);

    const done = interviewFeedbackGate(input({
      startedPhases: new Set(['discovery', 'delivery', 'technical']),
      feedback: { ...rated, 3: events('tech') },
    }));
    expect(done.completeBlocked).toBe(false);
  });

  it('does not block on a phase whose lookup has not loaded or failed', () => {
    const gate = interviewFeedbackGate(input({ feedback: { 1: undefined, 2: undefined, 3: undefined } }));
    expect(gate.chatLockedForBa).toBe(false);
    expect(gate.completeBlocked).toBe(false);
  });

  it('needs nothing before any phase has started', () => {
    const gate = interviewFeedbackGate(input({ startedPhases: new Set(), deliveryComplete: false }));
    expect(gate.completeBlocked).toBe(false);
  });
});
