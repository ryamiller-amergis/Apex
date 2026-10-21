import React from 'react';
import type { PlaybookRunDetail, PlaybookStepRun } from '../../shared/types/playbook';
import {
  PlaybookRunApiError,
  usePlaybookGate,
  usePlaybookGateDecision,
} from '../hooks/usePlaybookRuns';

type DecisionMutation = ReturnType<typeof usePlaybookGateDecision>;

const GateDecisionButtons: React.FC<{ decision: DecisionMutation }> = ({ decision }) => (
  <>
    <div role="group" aria-label="Approval decision">
      <button
        type="button"
        onClick={() => decision.mutate({ decision: 'approved' })}
        disabled={decision.isPending}
        data-testid="playbook-gate-approve"
      >
        Approve
      </button>
      <button
        type="button"
        onClick={() => decision.mutate({ decision: 'rejected' })}
        disabled={decision.isPending}
        data-testid="playbook-gate-reject"
      >
        Reject
      </button>
    </div>
    {decision.isError && (
      <p role="alert" data-testid="playbook-gate-decision-error">
        {decision.error.message}
      </p>
    )}
  </>
);

/**
 * A gate with no resolved approver pool, decided by the run's initiator.
 *
 * Kept as its own branch because the schema-rendered gate needs `gatedStepId` and a pool to say
 * anything at all, and both are absent here. Routing these through that endpoint returns 404 with
 * the production-adapters flag off and a render error with it on, which reads as "you cannot view
 * this gate" for a gate the initiator is in fact allowed to decide.
 */
const UnpooledGateReview: React.FC<{
  gateStep: PlaybookStepRun;
  decision: DecisionMutation;
  testId: string;
}> = ({ gateStep, decision, testId }) => {
  const subject = typeof gateStep.inputInline?.subject === 'string'
    ? gateStep.inputInline.subject
    : `Review ${gateStep.stepId}`;

  return (
    <section aria-labelledby={`gate-title-${gateStep.id}`} data-testid={testId}>
      <h3 id={`gate-title-${gateStep.id}`}>{subject}</h3>
      <p data-testid="playbook-gate-mode">Decided by whoever started this run</p>
      {gateStep.expiresAt && (
        <p data-testid="playbook-gate-deadline">Deadline {gateStep.expiresAt}</p>
      )}
      <GateDecisionButtons decision={decision} />
    </section>
  );
};

export const PlaybookGateReviewPanel: React.FC<{
  project: string;
  run: PlaybookRunDetail;
  'data-testid'?: string;
}> = ({ project, run, ...rest }) => {
  const gateStep = run.steps.find(
    (step) => step.stepId === run.suspension?.stepId && step.status === 'suspended',
  );
  const isApprovalGate = run.suspension?.reason === 'approval_gate';
  // The pool is written at suspend time, so its presence is what distinguishes a gate the
  // schema-rendered endpoint can describe from one only the initiator decides.
  const isPooled = Boolean(gateStep?.gatePoolKey);
  const gate = usePlaybookGate(
    project,
    isApprovalGate && isPooled ? run.runId : null,
    isPooled ? gateStep?.id ?? null : null,
  );
  const decision = usePlaybookGateDecision(project, run.runId, gateStep?.id ?? '');
  if (!isApprovalGate || !gateStep) return null;

  const testId = rest['data-testid'] ?? 'playbook-gate-detail';

  if (!isPooled) {
    return <UnpooledGateReview gateStep={gateStep} decision={decision} testId={testId} />;
  }

  if (gate.isPending) {
    return <p data-testid="playbook-gate-loading">Loading approval details…</p>;
  }
  if (gate.isError) {
    const malformed = gate.error instanceof PlaybookRunApiError && gate.error.status === 409;
    return (
      <div role="alert" data-testid="playbook-gate-render-error">
        {malformed
          ? 'The resolved inputs could not be rendered. Approval is unavailable.'
          : 'You cannot view this approval gate.'}
      </div>
    );
  }
  if (!gate.data) return null;

  return (
    <section
      aria-labelledby={`gate-title-${gateStep.id}`}
      data-testid={testId}
    >
      <h3 id={`gate-title-${gateStep.id}`}>{gate.data.subject}</h3>
      <p data-testid="playbook-gate-mode">
        {gate.data.approvalMode === 'all_required' ? 'All approvers required' : 'Any one approver'}
      </p>
      <fieldset data-testid="playbook-gate-resolved-inputs">
        <legend>Resolved inputs</legend>
        {gate.data.hasInputFields ? (
          <dl>
            {gate.data.fields.map((field) => (
              <div key={field.path} data-testid={`playbook-gate-field-${field.path}`}>
                <dt>{field.label}</dt>
                <dd>{field.value || 'Empty'}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p data-testid="playbook-gate-empty-inputs">This step has no input fields.</p>
        )}
      </fieldset>
      {gate.data.canDecide ? (
        <GateDecisionButtons decision={decision} />
      ) : (
        <p data-testid="playbook-gate-decision-recorded">Your decision is recorded.</p>
      )}
    </section>
  );
};
