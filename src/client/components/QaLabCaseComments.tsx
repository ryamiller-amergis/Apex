import React, { useState } from 'react';
import type { QaLabCaseComment, QaLabCaseRegeneration, QaLabTestCase } from '../../shared/types/qaLab';
import { useAddCaseComment, useRegenerateCase, useRestoreCase } from '../hooks/useQaLab';
import { QaLabCaseDiff } from './QaLabCaseDiff';
import styles from './QaLabCaseComments.module.css';

const MAX_COMMENT_LENGTH = 4000;

interface QaLabCaseCommentsProps {
  suiteId: string;
  localCaseId: string;
  currentCase: QaLabTestCase;
  comments: QaLabCaseComment[];
  regeneration: QaLabCaseRegeneration | null;
  isPublished: boolean;
}

function regenerationNote(regeneration: QaLabCaseRegeneration): string | null {
  switch (regeneration.status) {
    case 'generating':
      return 'Rewriting this case from the open comments…';
    case 'ready':
      return regeneration.source === 'assistant'
        ? 'Edited by Ask Apex.'
        : 'Rewritten from the comments below.';
    case 'failed':
      return `Could not rewrite the case: ${regeneration.error ?? 'unknown error'}`;
    case 'restored':
      return 'Restored the version from before the last rewrite.';
    default: {
      const unhandled: never = regeneration.status;
      return unhandled;
    }
  }
}

/** Reviewer comments on one generated case, and the controls to rewrite it from them. */
export const QaLabCaseComments: React.FC<QaLabCaseCommentsProps> = ({
  suiteId,
  localCaseId,
  currentCase,
  comments,
  regeneration,
  isPublished,
}) => {
  const [draft, setDraft] = useState('');
  const [showAddressed, setShowAddressed] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const addComment = useAddCaseComment();
  const regenerate = useRegenerateCase();
  const restore = useRestoreCase();

  const open = comments.filter((comment) => comment.status === 'open');
  const addressed = comments.filter((comment) => comment.status === 'addressed');
  const isRegenerating = regeneration?.status === 'generating';
  const error = addComment.error ?? regenerate.error ?? restore.error;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    addComment.mutate(
      { suiteId, localCaseId, body },
      { onSuccess: () => setDraft('') },
    );
  };

  return (
    <section className={styles.panel} {...{ 'data-testid': `qa-lab-case-comments-${localCaseId}` }}>
      <h4 className={styles.heading}>Comments</h4>

      {regeneration && (
        <p
          className={`${styles.note} ${regeneration.status === 'failed' ? styles.noteError : ''}`}
          {...{ 'data-testid': `qa-lab-case-regeneration-${localCaseId}` }}
          data-state={regeneration.status}
        >
          {isRegenerating && <span className={styles.spinner} aria-hidden="true" />}
          {regenerationNote(regeneration)}
        </p>
      )}

      {regeneration?.previousCase && (
        <div className={styles.addressed}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setShowDiff((value) => !value)}
            aria-expanded={showDiff}
            {...{ 'data-testid': `qa-lab-case-diff-toggle-${localCaseId}` }}
          >
            {showDiff ? 'Hide what changed' : 'Show what changed'}
          </button>
          {showDiff && (
            <QaLabCaseDiff localCaseId={localCaseId} before={regeneration.previousCase} after={currentCase} />
          )}
        </div>
      )}

      {open.length === 0 && addressed.length === 0 && (
        <p className={styles.empty}>No comments yet. Say what should change, then regenerate.</p>
      )}

      {open.length > 0 && (
        <ul className={styles.list}>
          {open.map((comment) => (
            <li key={comment.id} className={styles.comment}>
              <p className={styles.body}>{comment.body}</p>
              <span className={styles.meta}>
                {comment.authorName ?? 'Unknown'} · {new Date(comment.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      {addressed.length > 0 && (
        <div className={styles.addressed}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => setShowAddressed((value) => !value)}
            aria-expanded={showAddressed}
            {...{ 'data-testid': `qa-lab-case-addressed-toggle-${localCaseId}` }}
          >
            {showAddressed ? 'Hide' : 'Show'} {addressed.length} addressed
          </button>
          {showAddressed && (
            <ul className={styles.list}>
              {addressed.map((comment) => (
                <li key={comment.id} className={`${styles.comment} ${styles.commentAddressed}`}>
                  <p className={styles.body}>{comment.body}</p>
                  <span className={styles.meta}>
                    {comment.authorName ?? 'Unknown'} · Addressed
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isPublished ? (
        <p className={styles.empty}>Published to Azure DevOps. Change this case there.</p>
      ) : (
        <form
          className={styles.form}
          onSubmit={submit}
          {...{ 'data-testid': `qa-lab-case-comment-form-${localCaseId}` }}
        >
          <textarea
            className={styles.input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_COMMENT_LENGTH}
            rows={2}
            placeholder="What should change in this case?"
            aria-label={`Comment on ${localCaseId}`}
            disabled={isRegenerating}
            {...{ 'data-testid': `qa-lab-case-comment-input-${localCaseId}` }}
          />
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.secondaryBtn}
              disabled={!draft.trim() || addComment.isPending || isRegenerating}
              {...{ 'data-testid': `qa-lab-case-comment-add-${localCaseId}` }}
            >
              {addComment.isPending ? 'Adding…' : 'Add comment'}
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={open.length === 0 || isRegenerating || regenerate.isPending}
              onClick={() => regenerate.mutate({ suiteId, localCaseId })}
              title={open.length === 0 ? 'Add a comment first' : 'Rewrite only this case from the open comments'}
              {...{ 'data-testid': `qa-lab-case-regenerate-${localCaseId}` }}
            >
              {isRegenerating || regenerate.isPending ? 'Regenerating…' : 'Regenerate with comments'}
            </button>
            {regeneration?.canRestore && (
              <button
                type="button"
                className={styles.linkBtn}
                disabled={restore.isPending}
                onClick={() => restore.mutate({ suiteId, regenerationId: regeneration.id })}
                {...{ 'data-testid': `qa-lab-case-restore-${localCaseId}` }}
              >
                {restore.isPending ? 'Restoring…' : 'Restore previous'}
              </button>
            )}
          </div>
        </form>
      )}

      {error && <p className={styles.error} role="alert">{error.message}</p>}
    </section>
  );
};
