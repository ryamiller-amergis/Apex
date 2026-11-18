import React from 'react';
import {
  useAddReferenceRepository,
  useReferenceRepositories,
  useRemoveReferenceRepository,
} from '../hooks/useLinkedContext';
import styles from './LinkedContextPicker.module.css';

interface InterviewReferenceRepositoriesProps {
  interviewId: string;
  canEdit: boolean;
}

/**
 * Brainstorm catalog repositories mounted read-only on the Interview's
 * Technical turns, so the agent can read systems outside the project repo.
 */
export const InterviewReferenceRepositories: React.FC<InterviewReferenceRepositoriesProps> = ({
  interviewId,
  canEdit,
}) => {
  const query = useReferenceRepositories(interviewId, true);
  const addRepository = useAddReferenceRepository(interviewId);
  const removeRepository = useRemoveReferenceRepository(interviewId);

  const isBusy = addRepository.isPending || removeRepository.isPending;
  const actionError = addRepository.error ?? removeRepository.error;
  const model = query.data;
  const atCapacity = model ? model.links.length >= model.capacity : false;

  return (
    <section
      className={styles.section}
      aria-labelledby="interview-reference-repositories-heading"
      {...{ 'data-testid': 'interview-reference-repositories' }}
    >
      <h3 id="interview-reference-repositories-heading" className={styles['section-title']}>
        Reference repositories
      </h3>
      <p className={styles.description}>
        Other systems the agent can read during the Technical phase. Repositories come from the
        Brainstorm repository list for this project.
      </p>

      {query.isLoading && (
        <p className={styles['state-message']} role="status">
          Loading repositories…
        </p>
      )}

      {(query.error || actionError) && (
        <div
          className={styles.error}
          role="status"
          aria-live="polite"
          {...{ 'data-testid': 'interview-reference-repositories-error' }}
        >
          <span>{(actionError ?? query.error)?.message}</span>
        </div>
      )}

      {model && (
        <>
          {model.links.length === 0 ? (
            <p className={styles['state-message']}>No reference repositories linked.</p>
          ) : (
            <ul className={styles['link-list']}>
              {model.links.map((link) => (
                <li
                  key={link.catalogRepositoryId}
                  className={styles['link-row']}
                  {...{ 'data-testid': `interview-reference-repository-${link.catalogRepositoryId}` }}
                >
                  <div className={styles['link-details']}>
                    <span className={styles['type-label']}>Repository</span>
                    <span className={styles['item-label']}>{link.displayName}</span>
                    {!link.ready && (
                      <span className={styles['stale-badge']}>{link.readinessText}</span>
                    )}
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      className={styles['secondary-button']}
                      disabled={isBusy}
                      data-testid={`interview-reference-repository-remove-${link.catalogRepositoryId}`}
                      aria-label={`Remove ${link.displayName}`}
                      onClick={() => removeRepository.mutate(link.catalogRepositoryId)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canEdit && model.candidates.length === 0 && (
            <p className={styles['state-message']}>
              No other repositories are available. An administrator can add one from the
              Brainstorm repository list.
            </p>
          )}

          {canEdit && model.candidates.length > 0 && (
            <ul className={styles['candidate-list']}>
              {model.candidates.map((candidate) => (
                <li
                  key={candidate.catalogRepositoryId}
                  className={styles['candidate-row']}
                  {...{
                    'data-testid': `interview-reference-repository-candidate-${candidate.catalogRepositoryId}`,
                  }}
                >
                  <div className={styles['link-details']}>
                    <span className={styles['type-label']}>Repository</span>
                    <span className={styles['item-label']}>{candidate.displayName}</span>
                    {!candidate.ready && (
                      <span className={styles['stale-badge']}>{candidate.readinessText}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className={styles['primary-button']}
                    disabled={!candidate.ready || atCapacity || isBusy}
                    data-testid={`interview-reference-repository-add-${candidate.catalogRepositoryId}`}
                    aria-label={`Add ${candidate.displayName}`}
                    onClick={() =>
                      addRepository.mutate({ catalogRepositoryId: candidate.catalogRepositoryId })
                    }
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className={atCapacity ? styles.capacity : styles['capacity-available']}>
            {model.links.length} of {model.capacity} linked.
          </p>
        </>
      )}
    </section>
  );
};

export default InterviewReferenceRepositories;
