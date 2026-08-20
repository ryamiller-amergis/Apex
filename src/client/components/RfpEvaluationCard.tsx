import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RfpEvaluation, RfpReviewerDecision } from '../../shared/types/rfpIntake';
import { formatRationaleMarkdown, formatVerdictLabel } from '../../shared/utils/rfpEvaluationDisplay';
import styles from './RfpEvaluationCard.module.css';

interface RfpEvaluationCardProps {
  evaluation: RfpEvaluation;
  reviewerDecision?: RfpReviewerDecision | null;
  'data-testid'?: string;
}

export const RfpEvaluationCard: React.FC<RfpEvaluationCardProps> = ({
  evaluation,
  reviewerDecision = null,
}) => {
  const rationale = formatRationaleMarkdown(evaluation.rationale);
  const tooling = evaluation.recommendedTooling.length > 0
    ? evaluation.recommendedTooling.join(', ')
    : 'None named';

  return (
    <div className={styles.card} {...{ 'data-testid': 'rfp-current-evaluation' }}>
      {reviewerDecision && (
        <div className={styles.reviewerBanner} {...{ 'data-testid': 'rfp-reviewer-decision' }}>
          <p className={styles.headline}>
            <strong>AI: {formatVerdictLabel(evaluation.verdict)}</strong>
            {' · '}
            <strong>Reviewer: {formatVerdictLabel(reviewerDecision.verdict)}</strong>
          </p>
          <p className={styles.summary}>{reviewerDecision.rationale}</p>
        </div>
      )}
      <p className={styles.headline}>
        <strong>{formatVerdictLabel(evaluation.verdict)}</strong>
        {' · '}
        {evaluation.confidence} confidence
      </p>
      <p className={styles.summary}>{evaluation.buildBuyRentSummary}</p>
      <dl className={styles.facts} {...{ 'data-testid': 'rfp-evaluation-facts' }}>
        <div>
          <dt>Tech velocity</dt>
          <dd>{formatVerdictLabel(evaluation.techVelocity)}</dd>
        </div>
        <div>
          <dt>SDLC product fit</dt>
          <dd>{formatVerdictLabel(evaluation.nativeBenefit)}</dd>
        </div>
        <div>
          <dt>Recommended lane</dt>
          <dd>{formatVerdictLabel(evaluation.recommendedLane)}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>{formatVerdictLabel(evaluation.deliveryApproach)}</dd>
        </div>
        <div>
          <dt>Hosting</dt>
          <dd>{formatVerdictLabel(evaluation.hostingRecommendation)}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{evaluation.operationalOwner}</dd>
        </div>
        <div>
          <dt>Interview flow</dt>
          <dd>{evaluation.entersInterviewFlow ? 'Yes — standalone SDLC build' : 'No'}</dd>
        </div>
        <div>
          <dt>Tooling</dt>
          <dd>{tooling}</dd>
        </div>
      </dl>
      <div className={styles.rationale} {...{ 'data-testid': 'rfp-evaluation-rationale' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{rationale}</ReactMarkdown>
      </div>
    </div>
  );
};
