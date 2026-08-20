import React, { useEffect, useState } from 'react';
import { isClarificationAvailable, validateRfpAttachments } from '../../shared/types/rfpIntake';
import { useAddRfpComment, useRfpRequestDetail } from '../hooks/useRfpIntake';
import { useRfpAttachmentUpload } from '../hooks/useRfpTriage';
import { RfpClarificationForm } from './RfpClarificationForm';
import { RfpEvaluationCard } from './RfpEvaluationCard';
import { RfpEvaluationChat } from './RfpEvaluationChat';
import styles from './RfpIntakeLanding.module.css';

interface RfpDetailDrawerProps {
  requestId: string;
  onClose: () => void;
}

function formatLabel(value: string): string {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export const RfpDetailDrawer: React.FC<RfpDetailDrawerProps> = ({ requestId, onClose }) => {
  const detailQuery = useRfpRequestDetail(requestId, true);
  const addComment = useAddRfpComment();
  const upload = useRfpAttachmentUpload();
  const [commentBody, setCommentBody] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const detail = detailQuery.data;
  const canClarify = Boolean(
    detail && isClarificationAvailable(detail.clarificationUsed, detail.currentEvaluation?.verdict),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rfp-detail-title"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
      {...{ 'data-testid': 'rfp-detail-drawer' }}
    >
      <aside className={styles.drawer}>
        <div className={styles.header}>
          <div>
            <h2 id="rfp-detail-title" className={styles.title}>{detail?.title ?? 'Request detail'}</h2>
            {detail && (
              <p className={styles.subtitle} aria-live="polite">
                {formatLabel(detail.status)}
                {detail.currentEvaluation ? ` · ${formatLabel(detail.currentEvaluation.verdict)}` : ''}
              </p>
            )}
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close request detail"
            {...{ 'data-testid': 'rfp-detail-close' }}
          >
            &times;
          </button>
        </div>

        {detailQuery.isLoading && (
          <>
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </>
        )}

        {detailQuery.isError && (
          <p className={`${styles.banner} ${styles.errorBanner}`} role="alert">
            Could not load this request.{' '}
            <button type="button" className={styles.secondaryButton} onClick={() => void detailQuery.refetch()} {...{ 'data-testid': 'rfp-detail-retry' }}>
              Retry
            </button>
          </p>
        )}

        {detail && !detailQuery.isError && (
          <>
            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Intake</h3>
              <p>{detail.request}</p>
              <p className={styles.subtitle}>{detail.problem}</p>
            </section>

            {detail.aiStatus === 'failed' && (
              <p className={`${styles.banner} ${styles.errorBanner}`} role="alert">
                Evaluation failed. Apex triage can retry. This request has no successful Evaluation yet.
              </p>
            )}

            {detail.currentEvaluation && (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>Current Evaluation</h3>
                <RfpEvaluationCard
                  evaluation={detail.currentEvaluation}
                  {...{ 'data-testid': 'rfp-evaluation-card' }}
                />
              </section>
            )}

            {detail.currentEvaluation && (
              <section className={styles.block}>
                <RfpEvaluationChat requestId={detail.id} />
              </section>
            )}

            {canClarify && (
              // data-testid-exempt — form root is marked inside RfpClarificationForm
              <RfpClarificationForm detail={detail} />
            )}

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Comments</h3>
              {detail.comments.map((comment) => (
                <p key={comment.id}>{comment.body}</p>
              ))}
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  const body = commentBody.trim();
                  if (!body) return;
                  void (async () => {
                    let attachmentIds: string[] = [];
                    if (pendingFiles.length > 0) {
                      const uploaded = await upload.mutateAsync({ id: detail.id, files: pendingFiles });
                      const rows = Array.isArray(uploaded) ? uploaded : [uploaded];
                      attachmentIds = rows.map((row) => (row as { id: string }).id);
                    }
                    await addComment.mutateAsync({ id: detail.id, body, attachmentIds });
                    setCommentBody('');
                    setPendingFiles([]);
                    setFileError(null);
                  })();
                }}
                {...{ 'data-testid': 'rfp-comment-form' }}
              >
                <label className={styles.subtitle} htmlFor="rfp-owner-comment-input">Comment</label>
                <textarea
                  id="rfp-owner-comment-input"
                  className={styles.textarea}
                  value={commentBody}
                  onChange={(event) => setCommentBody(event.target.value)}
                  aria-label="Comment"
                  {...{ 'data-testid': 'rfp-comment-input' }}
                />
                <input
                  className={styles.input}
                  type="file"
                  multiple
                  accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,image/png,image/jpeg,image/gif,image/webp,application/pdf"
                  aria-label="Attachments"
                  onChange={(event) => {
                    const next = Array.from(event.target.files ?? []);
                    const errors = validateRfpAttachments(next.map((file) => ({
                      filename: file.name,
                      contentType: file.type,
                      sizeBytes: file.size,
                    })));
                    if (errors.length > 0) {
                      setFileError(errors[0]);
                      setPendingFiles([]);
                      event.target.value = '';
                      return;
                    }
                    setFileError(null);
                    setPendingFiles(next);
                  }}
                  {...{ 'data-testid': 'rfp-attachment-input' }}
                />
                {(fileError || addComment.isError || upload.isError) && (
                  <p className={styles.fieldError} role="alert" aria-live="assertive">
                    {fileError ?? 'Could not post the comment. Try again.'}
                  </p>
                )}
                <button type="submit" className={styles.primaryButton} disabled={addComment.isPending || upload.isPending} {...{ 'data-testid': 'rfp-comment-submit' }}>
                  {addComment.isPending || upload.isPending ? 'Posting…' : 'Post comment'}
                </button>
              </form>
            </section>

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Attachments</h3>
              {detail.attachments.length === 0 && <p className={styles.subtitle}>No attachments.</p>}
              {detail.attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={`/api/rfp-intake/requests/${detail.id}/attachments/${attachment.id}`}
                  {...{ 'data-testid': `rfp-attachment-${attachment.id}` }}
                >
                  {attachment.filename}
                </a>
              ))}
            </section>

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Activity</h3>
              <ol className={styles.activity} {...{ 'data-testid': 'rfp-activity-list' }}>
                {detail.activity.map((event) => (
                  <li key={event.id}>{formatLabel(event.eventType)} · {new Date(event.createdAt).toLocaleString()}</li>
                ))}
              </ol>
            </section>
          </>
        )}
      </aside>
    </div>
  );
};
