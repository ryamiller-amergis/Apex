import React, { useState } from 'react';
import {
  areAtsBoardV4AnswersAligned,
  defaultAtsBoardV4Answers,
  plainExceptionCategory,
  plainLeadershipCopy,
  parseAtsBoardSynopsis,
  type AtsBoardLeadershipAnswer,
  type AtsBoardLeadershipResolution,
  type AtsBoardSynopsis,
} from '../../shared/atsBoard';
import type {
  PlaybookRunDetail,
  PlaybookStepRun,
} from '../../shared/types/playbook';
import {
  PlaybookRunApiError,
  usePlaybookGate,
  usePlaybookGateDecision,
} from '../hooks/usePlaybookRuns';
import { AtsBoardDecisionReview } from './AtsBoardDecisionReview';
import styles from './PlaybookGateReviewPanel.module.css';

type DecisionMutation = ReturnType<typeof usePlaybookGateDecision>;

const GateDecisionButtons: React.FC<{
  decision: DecisionMutation;
  approveLabel?: string;
  rejectLabel?: string;
  answers?: AtsBoardLeadershipAnswer[];
  approveDisabled?: boolean;
  extraAction?: React.ReactNode;
}> = ({
  decision,
  approveLabel = 'Approve',
  rejectLabel = 'Reject',
  answers,
  approveDisabled = false,
  extraAction,
}) => {
  const [note, setNote] = useState('');
  const submit = (value: 'approved' | 'rejected') => {
    const comment = note.trim();
    decision.mutate({
      decision: value,
      ...(comment ? { comment } : {}),
      ...(value === 'approved' && answers?.length ? { answers } : {}),
    });
  };

  return (
    <>
      <label className={styles.note}>
        Note
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={2000}
          placeholder="Optional. Say what you are accepting, or why you are sending it back."
          {...{ 'data-testid': 'playbook-gate-comment' }}
        />
      </label>
      <div
        className={styles.actions}
        role="group"
        aria-label="Approval decision"
      >
        <button
          type="button"
          className={styles.approve}
          onClick={() => submit('approved')}
          disabled={decision.isPending || approveDisabled}
          {...{ 'data-testid': 'playbook-gate-approve' }}
        >
          {approveLabel}
        </button>
        <button
          type="button"
          className={styles.reject}
          onClick={() => submit('rejected')}
          disabled={decision.isPending}
          {...{ 'data-testid': 'playbook-gate-reject' }}
        >
          {rejectLabel}
        </button>
        {extraAction}
      </div>
      {decision.isError && (
        <p
          className={styles.error}
          role="alert"
          {...{ 'data-testid': 'playbook-gate-decision-error' }}
        >
          {decision.error.message}
        </p>
      )}
    </>
  );
};

const FocusedV4RatificationReview: React.FC<{
  synopsis: AtsBoardSynopsis;
  decision: DecisionMutation;
}> = ({ synopsis, decision }) => {
  const exceptions = synopsis.leadershipBrief?.materialExceptions ?? [];
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [answers, setAnswers] = useState<AtsBoardLeadershipAnswer[]>(() =>
    defaultAtsBoardV4Answers(synopsis)
  );

  const updateAnswer = (
    decisionId: string,
    patch: Partial<Pick<AtsBoardLeadershipAnswer, 'resolution' | 'response'>>
  ) => {
    setAnswers((current) =>
      current.map((entry) =>
        entry.decisionId === decisionId ? { ...entry, ...patch } : entry
      )
    );
  };

  return (
    <>
      <p
        className={styles.v4Summary}
        {...{ 'data-testid': 'ats-board-v4-gate-summary' }}
      >
        {exceptions.length === 0
          ? 'The AI board resolved all Phase 1 product, workflow, and schema choices within the charter. Approve the AI plan or send it back with direction.'
          : `The AI board resolved reversible Phase 1 choices and prefilled recommended resolutions for ${exceptions.length} material exception${
              exceptions.length === 1 ? '' : 's'
            }. Approve the AI plan as recommended, override an exception, or send it back.`}
      </p>
      {overrideOpen && exceptions.length > 0 ? (
        <div
          className={styles.overridePanel}
          {...{ 'data-testid': 'ats-board-v4-override-editor' }}
        >
          {exceptions.map((exception) => {
            const answer = answers.find(
              (entry) => entry.decisionId === exception.id
            ) ?? {
              decisionId: exception.id,
              resolution: 'accept_recommendation' as const,
              response: exception.recommendedResolution,
            };
            return (
              <fieldset
                key={exception.id}
                className={styles.overrideItem}
                {...{
                  'data-testid': `ats-board-v4-override-${exception.id}`,
                }}
              >
                <legend className={styles.overrideLegend}>
                  <span>
                    {plainLeadershipCopy(exception.title, exceptions)}
                  </span>
                  <span className={styles.overrideCategory}>
                    {plainExceptionCategory(exception.category)}
                  </span>
                </legend>
                <p className={styles.overrideQuestion}>
                  {plainLeadershipCopy(exception.question, exceptions)}
                </p>
                <div className={styles.overrideRow}>
                  <label className={styles.overrideLabel}>
                    Action
                    <select
                      value={answer.resolution}
                      onChange={(event) => {
                        const resolution = event.target
                          .value as AtsBoardLeadershipResolution;
                        updateAnswer(exception.id, {
                          resolution,
                          response:
                            resolution === 'accept_recommendation'
                              ? exception.recommendedResolution
                              : resolution === 'defer' &&
                                  answer.response ===
                                    exception.recommendedResolution
                                ? 'Deferred to a later phase.'
                                : answer.response,
                        });
                      }}
                      {...{
                        'data-testid': `ats-board-v4-override-resolution-${exception.id}`,
                      }}
                    >
                      <option value="accept_recommendation">
                        Accept AI recommendation
                      </option>
                      <option value="direct">Set leadership direction</option>
                      <option value="defer">Defer past Phase 1</option>
                    </select>
                  </label>
                  <label className={styles.overrideLabel}>
                    What you want instead
                    <textarea
                      value={answer.response}
                      maxLength={2000}
                      onChange={(event) => {
                        const response = event.target.value;
                        updateAnswer(exception.id, {
                          resolution:
                            answer.resolution === 'accept_recommendation' &&
                            response !== exception.recommendedResolution
                              ? 'direct'
                              : answer.resolution,
                          response,
                        });
                      }}
                      {...{
                        'data-testid': `ats-board-v4-override-response-${exception.id}`,
                      }}
                    />
                  </label>
                </div>
              </fieldset>
            );
          })}
        </div>
      ) : null}
      <GateDecisionButtons
        decision={decision}
        approveLabel="Approve AI plan"
        rejectLabel="Send back"
        answers={answers}
        approveDisabled={!areAtsBoardV4AnswersAligned(synopsis, answers)}
        extraAction={
          exceptions.length > 0 ? (
            <button
              type="button"
              className={styles.overrideToggle}
              onClick={() => setOverrideOpen((open) => !open)}
              disabled={decision.isPending}
              {...{ 'data-testid': 'ats-board-v4-override-toggle' }}
            >
              {overrideOpen ? 'Hide overrides' : 'Override'}
            </button>
          ) : null
        }
      />
    </>
  );
};

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
  synopsis: AtsBoardSynopsis | null;
  testId: string;
}> = ({ gateStep, decision, synopsis, testId }) => {
  const [answers, setAnswers] = useState<AtsBoardLeadershipAnswer[]>([]);
  const subject =
    typeof gateStep.inputInline?.subject === 'string'
      ? gateStep.inputInline.subject
      : `Review ${gateStep.stepId}`;
  const isRatification = gateStep.stepId === 'ratify';
  const isFocusedV4 =
    isRatification &&
    synopsis?.schemaVersion === 4 &&
    Boolean(synopsis.leadershipBrief);
  const questions = isRatification ? (synopsis?.decisionRequests ?? []) : [];

  return (
    <section
      className={styles.gate}
      aria-labelledby={`gate-title-${gateStep.id}`}
      {...{ 'data-testid': testId }}
    >
      <h3 className={styles.title} id={`gate-title-${gateStep.id}`}>
        {subject}
      </h3>
      <p className={styles.mode} {...{ 'data-testid': 'playbook-gate-mode' }}>
        Decided by whoever started this run
      </p>
      {gateStep.expiresAt && (
        <p
          className={styles.deadline}
          {...{ 'data-testid': 'playbook-gate-deadline' }}
        >
          Deadline {gateStep.expiresAt}
        </p>
      )}
      {isFocusedV4 && synopsis ? (
        <FocusedV4RatificationReview synopsis={synopsis} decision={decision} />
      ) : (
        <>
          {isRatification && synopsis && questions.length > 0 ? (
            <AtsBoardDecisionReview
              synopsis={synopsis}
              onChange={setAnswers}
              data-testid="ats-board-decision-review"
            />
          ) : null}
          <GateDecisionButtons
            decision={decision}
            approveLabel={isRatification ? 'Ratify' : 'Approve'}
            answers={answers}
            approveDisabled={
              questions.length > 0 && answers.length < questions.length
            }
          />
        </>
      )}
    </section>
  );
};

export const PlaybookGateReviewPanel: React.FC<{
  project: string;
  run: PlaybookRunDetail;
  'data-testid'?: string;
}> = ({ project, run, ...rest }) => {
  const gateStep = run.steps.find(
    (step) =>
      step.stepId === run.suspension?.stepId && step.status === 'suspended'
  );
  const isApprovalGate = run.suspension?.reason === 'approval_gate';
  // The pool is written at suspend time, so its presence is what distinguishes a gate the
  // schema-rendered endpoint can describe from one only the initiator decides.
  const isPooled = Boolean(gateStep?.gatePoolKey);
  const gate = usePlaybookGate(
    project,
    isApprovalGate && isPooled ? run.runId : null,
    isPooled ? (gateStep?.id ?? null) : null
  );
  const decision = usePlaybookGateDecision(
    project,
    run.runId,
    gateStep?.id ?? ''
  );
  if (!isApprovalGate || !gateStep) return null;

  const testId = rest['data-testid'] ?? 'playbook-gate-detail';
  const chair = run.steps.find((step) => step.stepId === 'chair');
  const synopsis = parseAtsBoardSynopsis(chair?.outputInline ?? null);

  if (!isPooled) {
    return (
      <UnpooledGateReview
        gateStep={gateStep}
        decision={decision}
        synopsis={synopsis}
        testId={testId}
      />
    );
  }

  if (gate.isPending) {
    return (
      <p {...{ 'data-testid': 'playbook-gate-loading' }}>
        Loading approval details…
      </p>
    );
  }
  if (gate.isError) {
    const malformed =
      gate.error instanceof PlaybookRunApiError && gate.error.status === 409;
    return (
      <div role="alert" {...{ 'data-testid': 'playbook-gate-render-error' }}>
        {malformed
          ? 'The resolved inputs could not be rendered. Approval is unavailable.'
          : 'You cannot view this approval gate.'}
      </div>
    );
  }
  if (!gate.data) return null;

  return (
    <section
      className={styles.gate}
      aria-labelledby={`gate-title-${gateStep.id}`}
      {...{ 'data-testid': testId }}
    >
      <h3 className={styles.title} id={`gate-title-${gateStep.id}`}>
        {gate.data.subject}
      </h3>
      <p className={styles.mode} {...{ 'data-testid': 'playbook-gate-mode' }}>
        {gate.data.approvalMode === 'all_required'
          ? 'All approvers required'
          : 'Any one approver'}
      </p>
      <fieldset {...{ 'data-testid': 'playbook-gate-resolved-inputs' }}>
        <legend>Resolved inputs</legend>
        {gate.data.hasInputFields ? (
          <dl>
            {gate.data.fields.map((field) => (
              <div
                key={field.path}
                {...{ 'data-testid': `playbook-gate-field-${field.path}` }}
              >
                <dt>{field.label}</dt>
                <dd>{field.value || 'Empty'}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p {...{ 'data-testid': 'playbook-gate-empty-inputs' }}>
            This step has no input fields.
          </p>
        )}
      </fieldset>
      {gate.data.canDecide ? (
        <GateDecisionButtons decision={decision} />
      ) : (
        <p {...{ 'data-testid': 'playbook-gate-decision-recorded' }}>
          Your decision is recorded.
        </p>
      )}
    </section>
  );
};
