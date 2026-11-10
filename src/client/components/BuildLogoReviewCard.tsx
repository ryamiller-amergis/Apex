import React from 'react';
import type { BuildLogoReviewView } from '../../shared/buildLogoReview';
import styles from './BuildWorkspace.module.css';

interface BuildLogoReviewCardProps {
  review: BuildLogoReviewView;
  buildId: string;
  project: string;
  pending: boolean;
  onApprove: (candidateId: string) => void;
  onReject: (candidateId: string) => void;
  onRegenerate: () => void;
  onUseInBuild?: () => void;
}

export const BuildLogoReviewCard: React.FC<BuildLogoReviewCardProps> = ({
  review,
  buildId,
  project,
  pending,
  onApprove,
  onReject,
  onRegenerate,
  onUseInBuild,
}) => (
  <section
    className={styles.logoReview}
    aria-label="Logo options"
    {...{ 'data-testid': 'build-logo-review' }}
  >
    <h2 className={styles.sectionHeading}>Logo options</h2>
    <p className={styles.confirmText}>
      {review.status === 'running'
        ? 'Cursor is generating logo options. Nothing changes in the build until you approve one.'
        : review.status === 'failed'
          ? (review.failureMessage ?? 'The logo generator failed.')
          : 'Choose a logo to keep. Approving one does not change the preview.'}
    </p>
    {review.status === 'ready' && (
      <div className={styles.logoGrid}>
        {review.candidates
          .filter(
            (candidate) =>
              candidate.status !== 'superseded' && candidate.status !== 'failed'
          )
          .map((candidate) => (
            <figure key={candidate.id} className={styles.logoOption}>
              <img
                src={`/api/builds/${encodeURIComponent(buildId)}/logo-candidates/${encodeURIComponent(candidate.id)}/image?project=${encodeURIComponent(project)}`}
                alt="Generated logo option"
              />
              <div className={styles.logoActions}>
                {candidate.status === 'approved' ? (
                  <span>Approved</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      disabled={pending}
                      onClick={() => onApprove(candidate.id)}
                      {...{
                        'data-testid': `build-logo-approve-${candidate.id}`,
                      }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className={styles.choiceButton}
                      disabled={pending}
                      onClick={() => onReject(candidate.id)}
                    >
                      Reject
                    </button>
                  </>
                )}
              </div>
            </figure>
          ))}
      </div>
    )}
    {review.approvedCandidateId && onUseInBuild && (
      <button
        type="button"
        className={styles.primaryButton}
        disabled={pending}
        onClick={onUseInBuild}
        {...{ 'data-testid': 'build-logo-use' }}
      >
        Use this logo in the build
      </button>
    )}
    {review.status !== 'running' && (
      <button
        type="button"
        className={styles.choiceButton}
        disabled={pending}
        onClick={onRegenerate}
        {...{ 'data-testid': 'build-logo-regenerate' }}
      >
        Generate again
      </button>
    )}
  </section>
);
