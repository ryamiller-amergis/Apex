import React, { useEffect, useMemo, useState } from 'react';
import type { RfpAttachment } from '../../shared/types/rfpIntake';
import { validateRfpAttachments } from '../../shared/types/rfpIntake';
import { useAddRfpComment } from '../hooks/useRfpIntake';
import { useRfpAttachmentUpload, useRfpMentionCandidates, useRfpTriageDetail } from '../hooks/useRfpTriage';
import { useRightDrawerResize } from '../hooks/useRightDrawerResize';
import { formatLabel, RfpStatusControl } from './RfpStatusControl';
import { formatRfpStatusSubtitle } from '../../shared/utils/rfpEvaluationDisplay';
import { RfpEvaluationCard } from './RfpEvaluationCard';
import { RfpEvaluationChat } from './RfpEvaluationChat';
import styles from './RfpQueueView.module.css';

interface RfpTriageDetailPanelProps {
  requestId: string;
  canManage: boolean;
  onClose: () => void;
}

export const RfpTriageDetailPanel: React.FC<RfpTriageDetailPanelProps> = ({
  requestId,
  canManage,
  onClose,
}) => {
  const detailQuery = useRfpTriageDetail(requestId, true);
  const addComment = useAddRfpComment();
  const upload = useRfpAttachmentUpload();
  const [body, setBody] = useState('');
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [unsavedError, setUnsavedError] = useState<string | null>(null);
  const resize = useRightDrawerResize();
  const mentions = useRfpMentionCandidates(requestId, mentionQuery, mentionQuery.length > 0);
  const detail = detailQuery.data;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const activity = useMemo(() => detail?.activity ?? [], [detail]);

  const onSelectFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Array.from(event.target.files ?? []);
    const errors = validateRfpAttachments(next.map((file) => ({
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    })));
    if (errors.length > 0) {
      setUnsavedError(errors[0]);
      setPendingFiles([]);
      event.target.value = '';
      return;
    }
    setUnsavedError(null);
    setPendingFiles(next);
  };

  const submitComment = async () => {
    const trimmed = body.trim();
    if (!trimmed || !detail) return;
    setUnsavedError(null);
    try {
      let attachmentIds: string[] = [];
      if (pendingFiles.length > 0) {
        const uploaded = await upload.mutateAsync({ id: detail.id, files: pendingFiles });
        const rows = Array.isArray(uploaded) ? uploaded : [uploaded];
        attachmentIds = (rows as RfpAttachment[]).map((row) => row.id);
      }
      await addComment.mutateAsync({
        id: detail.id,
        body: trimmed,
        mentionedUserIds,
        attachmentIds,
      });
      setBody('');
      setMentionedUserIds([]);
      setPendingFiles([]);
    } catch (err) {
      setUnsavedError(err instanceof Error ? err.message : 'Could not post the comment. Try again.');
    }
  };

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rfp-triage-title"
      onClick={(event) => {
        if (resize.consumeResizeClick()) return;
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
      {...{ 'data-testid': 'rfp-triage-detail' }}
    >
      <aside
        className={`${styles.drawer}${resize.isDragging ? ` ${styles.drawerResizing}` : ''}`}
        style={{ width: resize.width }}
      >
        {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA separator resize must be focusable */}
        <div
          className={`${styles.resizeHandle}${resize.isDragging ? ` ${styles.resizeHandleDragging}` : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize request detail"
          aria-valuemin={resize.minWidth}
          aria-valuemax={resize.maxWidth}
          aria-valuenow={resize.width}
          tabIndex={0}
          onMouseDown={resize.handleResizeMouseDown}
          onKeyDown={resize.handleResizeKeyDown}
          {...{ 'data-testid': 'rfp-triage-resize' }}
        />
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        <div className={styles.header}>
          <div>
            <h2 id="rfp-triage-title" className={styles.title}>{detail?.title ?? 'Request detail'}</h2>
            {detail && (
              <p className={styles.subtitle} aria-live="polite">
                {formatRfpStatusSubtitle(
                  detail.status,
                  detail.currentEvaluation?.verdict,
                  detail.reviewerDecision?.verdict,
                )}
              </p>
            )}
          </div>
          <button type="button" className={styles.secondaryButton} onClick={onClose} aria-label="Close request detail" {...{ 'data-testid': 'rfp-triage-close' }}>
            Close
          </button>
        </div>

        {detailQuery.isLoading && <p className={styles.subtitle}>Loading request…</p>}
        {detailQuery.isError && (
          <p className={`${styles.banner} ${styles.errorBanner}`} role="alert">
            Could not load this request.{' '}
            <button type="button" className={styles.secondaryButton} onClick={() => void detailQuery.refetch()} {...{ 'data-testid': 'rfp-triage-retry' }}>
              Retry
            </button>
          </p>
        )}

        {detail && (
          <>
            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Intake</h3>
              <p>{detail.request}</p>
              <p className={styles.subtitle}>{detail.problem}</p>
            </section>

            {detail.currentEvaluation && (
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>Current Evaluation</h3>
                <RfpEvaluationCard
                  evaluation={detail.currentEvaluation}
                  reviewerDecision={detail.reviewerDecision}
                  {...{ 'data-testid': 'rfp-evaluation-card' }}
                />
              </section>
            )}

            {detail.currentEvaluation && (
              <section className={styles.block}>
                <RfpEvaluationChat
                  requestId={detail.id}
                  canManage={canManage}
                  reviewerDecision={detail.reviewerDecision}
                />
              </section>
            )}

            <RfpStatusControl detail={detail} canManage={canManage} />

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Comments</h3>
              {detail.comments.length === 0 && <p className={styles.subtitle}>No activity yet</p>}
              {detail.comments.map((comment) => (
                <p key={comment.id}>{comment.body}</p>
              ))}
              <form
                className={styles.composer}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitComment();
                }}
                {...{ 'data-testid': 'rfp-comment-composer' }}
              >
                <label className={styles.subtitle} htmlFor="rfp-comment-input">Comment</label>
                <textarea
                  id="rfp-comment-input"
                  className={styles.textarea}
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value);
                    const match = event.target.value.match(/@([^\s]*)$/);
                    setMentionQuery(match ? match[1] : '');
                  }}
                  aria-label="Comment"
                  {...{ 'data-testid': 'rfp-comment-input' }}
                />
                {mentionQuery && (
                  <ul className={styles.mentions} role="listbox" {...{ 'data-testid': 'rfp-mention-picker' }}>
                    {(mentions.data ?? []).map((candidate) => (
                      <li key={candidate.userId}>
                        <button
                          type="button"
                          className={styles.mentionItem}
                          onClick={() => {
                            setMentionedUserIds((current) => [...new Set([...current, candidate.userId])]);
                            setBody((current) => current.replace(/@([^\s]*)$/, `@${candidate.displayName} `));
                            setMentionQuery('');
                          }}
                          {...{ 'data-testid': `rfp-mention-${candidate.userId}` }}
                        >
                          {candidate.displayName}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <label className={styles.subtitle} htmlFor="rfp-attachment-input">Attachments (PNG/JPG/GIF/WebP/PDF, 10 MB, max 5)</label>
                <input
                  id="rfp-attachment-input"
                  className={styles.input}
                  type="file"
                  multiple
                  accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,image/png,image/jpeg,image/gif,image/webp,application/pdf"
                  onChange={onSelectFiles}
                  aria-label="Attachments"
                  {...{ 'data-testid': 'rfp-attachment-input' }}
                />
                {(unsavedError || addComment.isError || upload.isError) && (
                  <p className={styles.subtitle} role="alert" aria-live="assertive">
                    {unsavedError ?? 'Unsaved comment. You can retry without duplicating activity.'}
                  </p>
                )}
                <button type="submit" className={styles.primaryButton} disabled={addComment.isPending || upload.isPending} {...{ 'data-testid': 'rfp-comment-submit' }}>
                  Post comment
                </button>
              </form>
            </section>

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Attachments</h3>
              {detail.attachments.length === 0 && <p className={styles.subtitle}>No attachments</p>}
              {detail.attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={`/api/rfp-intake/requests/${detail.id}/attachments/${attachment.id}`}
                  {...{ 'data-testid': `rfp-attachment-item-${attachment.id}` }}
                >
                  {attachment.filename}
                </a>
              ))}
            </section>

            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Activity</h3>
              <ol className={styles.activity} {...{ 'data-testid': 'rfp-activity-trail' }}>
                {activity.map((event) => (
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
