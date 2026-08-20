import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RfpEvaluation } from '../../shared/types/rfpIntake';
import { formatRationaleMarkdown } from '../../shared/utils/rfpEvaluationDisplay';
import styles from './RfpEvaluationCard.module.css';

interface RfpEvaluationCardProps {
  evaluation: RfpEvaluation;
  'data-testid'?: string;
}

function formatLabel(value: string): string {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export const RfpEvaluationCard: React.FC<RfpEvaluationCardProps> = ({ evaluation }) => {
  const rationale = formatRationaleMarkdown(evaluation.rationale);
  const tooling = evaluation.recommendedTooling.length > 0
    ? evaluation.recommendedTooling.join(', ')
    : 'None named';

  return (
    <div className={styles.card} {...{ 'data-testid': 'rfp-current-evaluation' }}>
      <p className={styles.headline}>
        <strong>{formatLabel(evaluation.verdict)}</strong>
        {' · '}
        {evaluation.confidence} confidence
      </p>
      <p className={styles.summary}>{evaluation.buildBuyRentSummary}</p>
      <dl className={styles.facts} {...{ 'data-testid': 'rfp-evaluation-facts' }}>
        <div>
          <dt>Tech velocity</dt>
          <dd>{formatLabel(evaluation.techVelocity)}</dd>
        </div>
        <div>
          <dt>SDLC product fit</dt>
          <dd>{formatLabel(evaluation.nativeBenefit)}</dd>
        </div>
        <div>
          <dt>Recommended lane</dt>
          <dd>{formatLabel(evaluation.recommendedLane)}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>{formatLabel(evaluation.deliveryApproach)}</dd>
        </div>
        <div>
          <dt>Hosting</dt>
          <dd>{formatLabel(evaluation.hostingRecommendation)}</dd>
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
