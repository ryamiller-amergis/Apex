import React, { useEffect, useState } from 'react';
import {
  effectiveRfpVerdict,
  isClarificationAvailable,
  RFP_AI_INTENT_LABELS,
  RFP_AI_USAGE_LABELS,
  RFP_APP_TYPE_LABELS,
  RFP_CLOUD_RESOURCE_LABELS,
  RFP_DEPLOYMENT_REGION_LABELS,
  RFP_EXPECTED_USER_SCALE_LABELS,
  RFP_SIZING_PROFILE_LABELS,
  RFP_UPTIME_PATTERN_LABELS,
  rfpDraftKindForVerdict,
  rfpProposalUnlocked,
  rfpReviewSubmitLabel,
  rfpWizardInitialStep,
  type RfpArchitecture,
  type RfpArchitectureInput,
  type RfpRequestDetail,
  type RfpTriageDetail,
  type RfpWizardStep,
} from '../../shared/types/rfpIntake';
import { formatRfpStatusSubtitle } from '../../shared/utils/rfpEvaluationDisplay';
import { useRfpRequestDetail } from '../hooks/useRfpIntake';
import { useRfpTriageDetail, useSubmitRfpReview } from '../hooks/useRfpTriage';
import { RfpArchitectureForm } from './RfpArchitectureForm';
import { RfpClarificationForm } from './RfpClarificationForm';
import { RfpEvaluationCard } from './RfpEvaluationCard';
import { RfpEvaluationChat } from './RfpEvaluationChat';
import { RfpProposalStep } from './RfpProposalStep';
import { formatLabel, RfpStatusControl } from './RfpStatusControl';
import { RfpWizardDiscussion } from './RfpWizardDiscussion';
import landing from './RfpIntakeLanding.module.css';
import styles from './RfpRequestWizard.module.css';

export type RfpWizardMode = 'requester' | 'triage';

interface RfpRequestWizardProps {
  mode: RfpWizardMode;
  requestId: string;
  canManage: boolean;
  onClose: () => void;
}

const STEPS: { step: RfpWizardStep; label: string }[] = [
  { step: 1, label: 'Request' },
  { step: 2, label: 'Review' },
  { step: 3, label: 'Proposal' },
];

const ARCHITECTURE_FORM_ID = 'rfp-wizard-architecture-form';

/** Request is complete once it is submitted. Proposal opens for admins after the review is submitted, and for everyone once published. */
function unlockedThrough(detail: RfpRequestDetail | undefined, canManage: boolean): RfpWizardStep {
  if (!detail) return 1;
  return rfpProposalUnlocked(detail, canManage) ? 3 : 2;
}

function answered(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'Not answered';
}

const IntakeDetails: React.FC<{ detail: RfpRequestDetail }> = ({ detail }) => {
  const attachmentNames = detail.attachments.map((attachment) => attachment.filename).join(', ');
  const rows: [string, string][] = [
    ['Title', detail.title],
    ['Sponsoring team', answered(detail.stakeholder)],
    ['Expected users', detail.expectedUsers ? RFP_EXPECTED_USER_SCALE_LABELS[detail.expectedUsers] : 'Not answered'],
    ['AI in the application', detail.aiInApp ? RFP_AI_INTENT_LABELS[detail.aiInApp] : 'Not answered'],
    ['Request', answered(detail.request)],
    ['Problem', answered(detail.problem)],
    ['Audience', formatLabel(detail.audience)],
    ['Data sensitivity', formatLabel(detail.dataSensitivity)],
    ['Existing solution', answered(detail.existingSolution)],
    ['Advantage', answered(detail.advantage)],
    ['Constraints', answered(detail.constraints)],
    ['Request type', detail.requestType ? formatLabel(detail.requestType) : 'Not answered'],
    ['Existing system stack', answered(detail.existingSystemStack)],
    ['Attachments', attachmentNames || 'Not answered'],
  ];
  return (
    <section className={landing.block}>
      <h3 className={landing.blockTitle}>Intake</h3>
      <dl className={styles.intakeGrid} {...{ 'data-testid': 'rfp-wizard-intake' }}>
        {rows.map(([term, value]) => (
          <React.Fragment key={term}>
            <dt className={styles.intakeTerm}>{term}</dt>
            <dd className={styles.intakeValue}>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  );
};

const ArchitectureSummary: React.FC<{ architecture: RfpArchitecture | null }> = ({ architecture }) => {
  if (!architecture) {
    return <p className={landing.subtitle}>Apex has not chosen an architecture yet.</p>;
  }
  const resources = architecture.resources.map((resource) => RFP_CLOUD_RESOURCE_LABELS[resource]).join(', ');
  return (
    <section className={landing.block}>
      <h3 className={landing.blockTitle}>Architecture</h3>
      <dl className={styles.intakeGrid} {...{ 'data-testid': 'rfp-architecture-summary' }}>
        <dt className={styles.intakeTerm}>App type</dt>
        <dd className={styles.intakeValue}>{RFP_APP_TYPE_LABELS[architecture.appType]}</dd>
        <dt className={styles.intakeTerm}>Cloud resources</dt>
        <dd className={styles.intakeValue}>{resources || 'None'}</dd>
        <dt className={styles.intakeTerm}>Requires AI</dt>
        <dd className={styles.intakeValue}>{architecture.requiresAi ? 'Yes' : 'No'}</dd>
        {architecture.domainName && (
          <>
            <dt className={styles.intakeTerm}>Domain name</dt>
            <dd className={styles.intakeValue}>{architecture.domainName}</dd>
          </>
        )}
        {architecture.sizing && (
          <>
            <dt className={styles.intakeTerm}>Region</dt>
            <dd className={styles.intakeValue}>{RFP_DEPLOYMENT_REGION_LABELS[architecture.sizing.region]}</dd>
            <dt className={styles.intakeTerm}>Size</dt>
            <dd className={styles.intakeValue}>{RFP_SIZING_PROFILE_LABELS[architecture.sizing.sizingProfile]}</dd>
            <dt className={styles.intakeTerm}>Environments</dt>
            <dd className={styles.intakeValue}>{architecture.sizing.environmentCount}</dd>
            <dt className={styles.intakeTerm}>Uptime</dt>
            <dd className={styles.intakeValue}>{RFP_UPTIME_PATTERN_LABELS[architecture.sizing.uptimePattern]}</dd>
            <dt className={styles.intakeTerm}>Database storage</dt>
            <dd className={styles.intakeValue}>{architecture.sizing.storageGb} GB</dd>
            {architecture.sizing.aiUsage && (
              <>
                <dt className={styles.intakeTerm}>AI usage</dt>
                <dd className={styles.intakeValue}>{RFP_AI_USAGE_LABELS[architecture.sizing.aiUsage]}</dd>
              </>
            )}
          </>
        )}
      </dl>
    </section>
  );
};

export const RfpRequestWizard: React.FC<RfpRequestWizardProps> = ({ mode, requestId, canManage, onClose }) => {
  const isTriage = mode === 'triage';
  const requesterQuery = useRfpRequestDetail(requestId, !isTriage);
  const triageQuery = useRfpTriageDetail(requestId, isTriage);
  const query = isTriage ? triageQuery : requesterQuery;
  const detail: RfpRequestDetail | undefined = query.data;
  const manage = isTriage && canManage;
  const [chosenStep, setChosenStep] = useState<RfpWizardStep | null>(null);
  const [reviewSaved, setReviewSaved] = useState(false);
  const submitReview = useSubmitRfpReview();
  const unlocked = unlockedThrough(detail, manage);
  const preferred: RfpWizardStep = chosenStep ?? (detail ? rfpWizardInitialStep(detail) : 1);
  const step: RfpWizardStep = preferred > unlocked ? unlocked : preferred;
  const verdict = detail ? effectiveRfpVerdict(detail) : null;
  const reviewKind = verdict ? rfpDraftKindForVerdict(verdict) : null;
  const canSubmitReview = Boolean(
    manage && detail && !detail.approval && verdict && detail.aiStatus !== 'evaluating',
  );

  const handleReview = async (architecture: RfpArchitectureInput | null) => {
    if (!detail) return;
    setReviewSaved(false);
    await submitReview.mutateAsync({ id: detail.id, architecture });
    if (reviewKind) setChosenStep(3);
    else setReviewSaved(true);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canClarify = Boolean(
    !isTriage && detail && isClarificationAvailable(detail.clarificationUsed, detail.currentEvaluation?.verdict),
  );

  return (
    <div
      className={styles.overlay}
      role="presentation"
      {...{ 'data-testid': 'rfp-wizard-overlay' }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rfp-wizard-title"
        {...{ 'data-testid': 'rfp-wizard' }}
      >
        <div className={styles.header}>
          <div>
            <h2 id="rfp-wizard-title" className={landing.title}>{detail?.title ?? 'Request detail'}</h2>
            {detail && (
              <p className={landing.subtitle} aria-live="polite">
                {formatRfpStatusSubtitle(detail.status, detail.currentEvaluation?.verdict, detail.reviewerDecision?.verdict)}
              </p>
            )}
          </div>
          <button
            type="button"
            className={landing.closeButton}
            onClick={onClose}
            aria-label="Close request detail"
            {...{ 'data-testid': 'rfp-wizard-close' }}
          >
            &times;
          </button>
        </div>

        <ol className={styles.stepper} aria-label="Request steps">
          {STEPS.map(({ step: value, label }) => (
            <li key={value} className={styles.stepItem}>
              <button
                type="button"
                className={`${styles.stepButton}${step === value ? ` ${styles.stepButtonActive}` : ''}`}
                aria-current={step === value ? 'step' : undefined}
                disabled={value > unlocked}
                onClick={() => setChosenStep(value)}
                {...{ 'data-testid': `rfp-wizard-step-${value}` }}
              >
                <span className={styles.stepNumber}>{value}</span>
                {label}
              </button>
            </li>
          ))}
        </ol>

        <div className={styles.body}>
          {query.isLoading && (
            <>
              <div className={landing.skeleton} />
              <div className={landing.skeleton} />
            </>
          )}

          {query.isError && (
            <p className={`${landing.banner} ${landing.errorBanner}`} role="alert">
              Could not load this request.{' '}
              <button
                type="button"
                className={landing.secondaryButton}
                onClick={() => void query.refetch()}
                {...{ 'data-testid': 'rfp-wizard-retry' }}
              >
                Retry
              </button>
            </p>
          )}

          {detail && !query.isError && step === 1 && <IntakeDetails detail={detail} />}

          {detail && !query.isError && step === 2 && (
            <>
              {isTriage && <RfpStatusControl detail={detail as RfpTriageDetail} canManage={canManage} />}
              {detail.aiStatus === 'failed' && (
                <p className={`${landing.banner} ${landing.errorBanner}`} role="alert">
                  Evaluation failed. Apex triage can retry. This request has no successful Evaluation yet.
                </p>
              )}
              {detail.aiStatus === 'evaluating' && (
                <p className={landing.subtitle} role="status" {...{ 'data-testid': 'rfp-evaluation-running' }}>
                  Evaluation is running. This view updates when it finishes.
                </p>
              )}
              {detail.currentEvaluation && (
                <section className={landing.block}>
                  <h3 className={landing.blockTitle}>Current Evaluation</h3>
                  <RfpEvaluationCard
                    evaluation={detail.currentEvaluation}
                    reviewerDecision={detail.reviewerDecision}
                    {...{ 'data-testid': 'rfp-evaluation-card' }}
                  />
                </section>
              )}
              {detail.currentEvaluation && (
                <section className={landing.block}>
                  {isTriage ? (
                    <RfpEvaluationChat
                      requestId={detail.id}
                      canManage={canManage}
                      reviewerDecision={detail.reviewerDecision}
                      evaluationInProgress={detail.aiStatus === 'evaluating'}
                    />
                  ) : (
                    <RfpEvaluationChat requestId={detail.id} />
                  )}
                </section>
              )}
              {canClarify && (
                // data-testid-exempt — form root is marked inside RfpClarificationForm
                <RfpClarificationForm detail={detail} />
              )}
              {manage && !detail.approval && reviewKind === 'decision-summary' && (
                <p className={landing.subtitle} {...{ 'data-testid': 'rfp-review-decline-note' }}>
                  A Decline needs no architecture. Submitting writes a decision summary for the requester.
                </p>
              )}
              {manage && !detail.approval && reviewKind !== 'decision-summary' && (
                // data-testid-exempt — form root is marked inside RfpArchitectureForm
                <RfpArchitectureForm
                  key={detail.architecture?.updatedAt ?? 'new'}
                  detail={detail}
                  formId={ARCHITECTURE_FORM_ID}
                  onSubmit={handleReview}
                />
              )}
              {(!manage || detail.approval) && <ArchitectureSummary architecture={detail.architecture} />}
              {submitReview.isError && (
                <p className={`${landing.banner} ${landing.errorBanner}`} role="alert" {...{ 'data-testid': 'rfp-review-submit-error' }}>
                  {submitReview.error.message}
                </p>
              )}
              {reviewSaved && (
                <p className={landing.subtitle} role="status" {...{ 'data-testid': 'rfp-review-saved' }}>
                  Review saved. The proposal stays locked while the verdict is Needs clarification.
                </p>
              )}
              <RfpWizardDiscussion detail={detail} allowMentions={isTriage} />
            </>
          )}

          {detail && !query.isError && step === 3 && (
            <RfpProposalStep
              key={detail.proposal?.publishedAt ?? 'draft'}
              detail={detail}
              isRequester={!isTriage}
              canManage={manage}
            />
          )}
        </div>

        <div className={styles.footer}>
          <button
            type="button"
            className={landing.secondaryButton}
            disabled={step === 1}
            onClick={() => setChosenStep((step - 1) as RfpWizardStep)}
            {...{ 'data-testid': 'rfp-wizard-back' }}
          >
            Back
          </button>
          <div className={styles.footerActions}>
            {step === 2 && canSubmitReview && verdict && (
              <button
                type={reviewKind === 'decision-summary' ? 'button' : 'submit'}
                form={reviewKind === 'decision-summary' ? undefined : ARCHITECTURE_FORM_ID}
                className={landing.primaryButton}
                disabled={submitReview.isPending}
                onClick={reviewKind === 'decision-summary'
                  ? () => void handleReview(null).catch(() => undefined)
                  : undefined}
                {...{ 'data-testid': 'rfp-wizard-submit-review' }}
              >
                {submitReview.isPending ? 'Submitting…' : rfpReviewSubmitLabel(verdict)}
              </button>
            )}
            <button
              type="button"
              className={landing.secondaryButton}
              disabled={step === 3 || step >= unlocked}
              onClick={() => setChosenStep((step + 1) as RfpWizardStep)}
              {...{ 'data-testid': 'rfp-wizard-next' }}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
