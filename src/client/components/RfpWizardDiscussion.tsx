import React, { useState } from 'react';
import type { RfpAttachment, RfpRequestDetail } from '../../shared/types/rfpIntake';
import { validateRfpAttachments } from '../../shared/types/rfpIntake';
import { useAddRfpComment } from '../hooks/useRfpIntake';
import { useRfpAttachmentUpload, useRfpMentionCandidates } from '../hooks/useRfpTriage';
import { formatLabel } from './RfpStatusControl';
import landing from './RfpIntakeLanding.module.css';
import styles from './RfpRequestWizard.module.css';

interface RfpWizardDiscussionProps {
  detail: RfpRequestDetail;
  allowMentions: boolean;
}

const AI_ACTIVITY_TYPES = new Set([
  'evaluation-started',
  'evaluation-completed',
  'evaluation-failed',
]);

export const RfpWizardDiscussion: React.FC<RfpWizardDiscussionProps> = ({ detail, allowMentions }) => {
  const addComment = useAddRfpComment();
  const upload = useRfpAttachmentUpload();
  const [body, setBody] = useState('');
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mentions = useRfpMentionCandidates(detail.id, mentionQuery, allowMentions && mentionQuery.length > 0);

  const onSelectFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Array.from(event.target.files ?? []);
    const errors = validateRfpAttachments(next.map((file) => ({
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    })));
    if (errors.length > 0) {
      setError(errors[0]);
      setPendingFiles([]);
      event.target.value = '';
      return;
    }
    setError(null);
    setPendingFiles(next);
  };

  const submitComment = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setError(null);
    try {
      let attachmentIds: string[] = [];
      if (pendingFiles.length > 0) {
        const uploaded = await upload.mutateAsync({ id: detail.id, files: pendingFiles });
        const rows = Array.isArray(uploaded) ? uploaded : [uploaded];
        attachmentIds = (rows as RfpAttachment[]).map((row) => row.id);
      }
      await addComment.mutateAsync({ id: detail.id, body: trimmed, mentionedUserIds, attachmentIds });
      setBody('');
      setMentionedUserIds([]);
      setPendingFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the comment. Try again.');
    }
  };

  const isPosting = addComment.isPending || upload.isPending;
  const unlinkedAttachments = detail.attachments.filter((attachment) => !attachment.commentId);

  const renderAttachment = (attachment: RfpAttachment) => (
    <a
      key={attachment.id}
      href={`/api/rfp-intake/requests/${detail.id}/attachments/${attachment.id}`}
      {...{ 'data-testid': `rfp-attachment-${attachment.id}` }}
    >
      {attachment.filename}
    </a>
  );

  return (
    <>
      <section className={landing.block}>
        <h3 className={landing.blockTitle}>Comments</h3>
        {detail.comments.length === 0 && <p className={landing.subtitle}>No comments yet.</p>}
        <div className={styles.commentThread}>
          {detail.comments.map((comment) => {
            const commentAttachments = detail.attachments.filter(
              (attachment) => attachment.commentId === comment.id,
            );
            return (
              <article
                key={comment.id}
                className={styles.commentCard}
                {...{ 'data-testid': `rfp-comment-${comment.id}` }}
              >
                <p className={styles.commentMeta}>
                  <strong>{comment.authorName ?? 'User'}</strong>
                  {' · '}
                  {new Date(comment.createdAt).toLocaleString()}
                </p>
                <p className={styles.commentBody}>{comment.body}</p>
                {commentAttachments.length > 0 && (
                  <div className={styles.commentAttachments}>
                    <span className={styles.attachmentLabel}>Attached to this comment</span>
                    {commentAttachments.map(renderAttachment)}
                  </div>
                )}
              </article>
            );
          })}
        </div>
        <form
          className={landing.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submitComment();
          }}
          {...{ 'data-testid': 'rfp-comment-composer' }}
        >
          <label className={landing.label} htmlFor="rfp-wizard-comment-input">Comment</label>
          <textarea
            id="rfp-wizard-comment-input"
            className={landing.textarea}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              if (allowMentions) {
                const match = event.target.value.match(/@([^\s]*)$/);
                setMentionQuery(match ? match[1] : '');
              }
            }}
            {...{ 'data-testid': 'rfp-comment-input' }}
          />
          {mentionQuery && (
            <ul className={styles.mentions} role="listbox" aria-label="Mention suggestions" {...{ 'data-testid': 'rfp-mention-picker' }}>
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
          <label className={landing.label} htmlFor="rfp-wizard-attachment-input">
            Attachments (PNG/JPG/GIF/WebP/PDF, 10 MB, max 5)
          </label>
          <input
            id="rfp-wizard-attachment-input"
            className={landing.input}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,image/png,image/jpeg,image/gif,image/webp,application/pdf"
            onChange={onSelectFiles}
            {...{ 'data-testid': 'rfp-attachment-input' }}
          />
          {error && (
            <p className={landing.fieldError} role="alert" aria-live="assertive">{error}</p>
          )}
          <div className={styles.actions}>
            <button
              type="submit"
              className={landing.primaryButton}
              disabled={isPosting || body.trim() === ''}
              {...{ 'data-testid': 'rfp-comment-submit' }}
            >
              {isPosting ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </form>
      </section>

      <section className={landing.block}>
        <h3 className={landing.blockTitle}>Other attachments</h3>
        {unlinkedAttachments.length === 0 && (
          <p className={landing.subtitle}>No attachments outside the comments.</p>
        )}
        <div className={styles.commentAttachments}>
          {unlinkedAttachments.map(renderAttachment)}
        </div>
      </section>

      <section className={landing.block}>
        <h3 className={landing.blockTitle}>Activity</h3>
        <ol className={landing.activity} {...{ 'data-testid': 'rfp-activity-list' }}>
          {detail.activity.map((event) => (
            <li key={event.id}>
              {formatLabel(event.eventType)}
              {' · '}
              {event.actorName
                ?? (AI_ACTIVITY_TYPES.has(event.eventType)
                  ? 'Apex Bot'
                  : event.actorId
                    ? 'User'
                    : 'Apex system')}
              {' · '}
              {new Date(event.createdAt).toLocaleString()}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
};
