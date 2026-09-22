import React from 'react';
import type { PlaybookRunDetail } from '../../shared/types/playbook';
import {
  PlaybookRunApiError,
  usePlaybookGate,
  usePlaybookGateDecision,
} from '../hooks/usePlaybookRuns';

export const PlaybookGateReviewPanel: React.FC<{
  project: string;
  run: PlaybookRunDetail;
  'data-testid'?: string;
}> = ({ project, run, ...rest }) => {
  const gateStep = run.steps.find(
    (step) => step.stepId === run.suspension?.stepId && step.status === 'suspended',
  );
  const gate = usePlaybookGate(
    project,
    run.suspension?.reason === 'approval_gate' ? run.runId : null,
    gateStep?.id ?? null,
  );
  const decision = usePlaybookGateDecision(project, run.runId, gateStep?.id ?? '');
  if (run.suspension?.reason !== 'approval_gate' || !gateStep) return null;

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
      data-testid={rest['data-testid'] ?? 'playbook-gate-detail'}
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
      ) : (
        <p data-testid="playbook-gate-decision-recorded">Your decision is recorded.</p>
      )}
    </section>
  );
};
