import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CHAT_MESSAGE_RATINGS,
  CHAT_MESSAGE_RATING_LABELS,
  MESSAGE_RATING_SUMMARY_DAYS,
  type MessageRatingSummaryDays,
} from '../../shared/types/workflowMessageFeedback';
import { useMessageRatingSummary } from '../hooks/useWorkflowEvaluationsAdmin';
import gridStyles from './DataGrid.module.css';
import styles from './WorkflowMessageRatingsPanel.module.css';

export interface WorkflowMessageRatingsPanelProps {
  project: string;
  'data-testid'?: string;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export const WorkflowMessageRatingsPanel: React.FC<WorkflowMessageRatingsPanelProps> = ({
  project,
  'data-testid': testId = 'workflow-message-ratings',
}) => {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<MessageRatingSummaryDays>(30);
  const summaryQuery = useMessageRatingSummary(project, days, open);
  const summary = summaryQuery.data;

  return (
    <section className={styles.panel} {...{ 'data-testid': testId }}>
      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>Message ratings</h3>
          <p className={gridStyles.hint}>
            Thumbs on interview questions and ratings on home chat replies. No judge runs on these.
          </p>
        </div>
        <div className={styles.headerControls}>
          {open && (
            <label className={styles.field}>
              <span className={styles.label}>Period</span>
              <select
                className={styles.select}
                value={days}
                onChange={(event) => setDays(Number(event.target.value) as MessageRatingSummaryDays)}
                {...{ 'data-testid': 'workflow-message-ratings-days' }}
              >
                {MESSAGE_RATING_SUMMARY_DAYS.map((value) => (
                  <option key={value} value={value}>Last {value} days</option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className={gridStyles.button}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            {...{ 'data-testid': 'workflow-message-ratings-toggle' }}
          >
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {open && summaryQuery.isLoading && <p className={gridStyles.loading}>Loading ratings…</p>}
      {open && summaryQuery.isError && (
        <p className={gridStyles.error} role="alert">
          Could not load ratings: {summaryQuery.error.message}
        </p>
      )}

      {open && summary && (
        <div className={styles.body}>
          <div className={styles.counts}>
            <div className={styles.countGroup} {...{ 'data-testid': 'workflow-message-ratings-interview-counts' }}>
              <span className={styles.countHeading}>Interview questions</span>
              <span className={styles.count}>👍 {summary.interview.up}</span>
              <span className={styles.count}>👎 {summary.interview.down}</span>
            </div>
            <div className={styles.countGroup} {...{ 'data-testid': 'workflow-message-ratings-chat-counts' }}>
              <span className={styles.countHeading}>Home chat replies</span>
              {CHAT_MESSAGE_RATINGS.map((rating) => (
                <span key={rating} className={styles.count}>
                  {CHAT_MESSAGE_RATING_LABELS[rating]}: {summary.chat[rating]}
                </span>
              ))}
            </div>
          </div>

          <h4 className={styles.subTitle}>Interview questions with the most thumbs down</h4>
          {summary.downvotedQuestions.length === 0 ? (
            <p className={gridStyles.hint}>No thumbs down in this period.</p>
          ) : (
            <div className={gridStyles.tableWrap}>
              <table className={gridStyles.table} {...{ 'data-testid': 'workflow-message-ratings-questions' }}>
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Interview</th>
                    <th>👎</th>
                    <th>👍</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.downvotedQuestions.map((question) => (
                    <tr key={question.messageId}>
                      <td>{question.excerpt}</td>
                      <td>
                        <Link
                          to={`/backlog/interview/${question.interviewId}`}
                          {...{ 'data-testid': `workflow-message-ratings-interview-${question.messageId}` }}
                        >
                          {question.interviewTitle}
                        </Link>
                      </td>
                      <td>{question.down}</td>
                      <td>{question.up}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h4 className={styles.subTitle}>Recent home chat comments</h4>
          {summary.chatComments.length === 0 ? (
            <p className={gridStyles.hint}>No comments in this period.</p>
          ) : (
            <div className={gridStyles.tableWrap}>
              <table className={gridStyles.table} {...{ 'data-testid': 'workflow-message-ratings-comments' }}>
                <thead>
                  <tr>
                    <th>Rating</th>
                    <th>Comment</th>
                    <th>Agent reply</th>
                    <th>Chat</th>
                    <th>By</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.chatComments.map((entry) => (
                    <tr key={`${entry.messageId}-${entry.updatedAt}`}>
                      <td>{CHAT_MESSAGE_RATING_LABELS[entry.rating]}</td>
                      <td>{entry.comment}</td>
                      <td className={styles.excerpt}>{entry.excerpt}</td>
                      <td>{entry.threadTitle ?? 'Untitled chat'}</td>
                      <td>{entry.reviewerName ?? 'Unknown'}</td>
                      <td>{formatDate(entry.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
