import React from 'react';
import type { RunCheckKind } from '../../shared/types/agentRunLifecycle';
import type { ProductBuildSummary } from '../../shared/types/productBuild';
import { productBuildStatusLabel } from '../../shared/types/productBuild';
import { useChatThread } from '../hooks/useChatThreads';
import { useUiLabDesign } from '../hooks/useUiLab';
import styles from './ProductBuildSetup.module.css';

const CHECK_LABELS: Record<RunCheckKind, string> = {
  unit: 'Unit tests',
  e2e: 'End-to-end tests',
  wcag: 'Accessibility',
  install: 'Install',
  lint: 'Lint',
  typecheck: 'Type check',
  build: 'Build',
  migrations: 'Migrations',
  security: 'Security',
};

export interface BuildDetailProps {
  summary: ProductBuildSummary;
  onClose: () => void;
}

export const BuildDetail: React.FC<BuildDetailProps> = ({ summary, onClose }) => {
  const threadQuery = useChatThread(summary.chatThreadId);
  const designQuery = useUiLabDesign(summary.designId);
  const html = designQuery.data?.status === 'ready' ? designQuery.data.html?.trim() ?? '' : '';
  const messages = (threadQuery.data?.messages ?? []).filter((message) =>
    !message.hidden
    && (message.role === 'user' || message.role === 'agent')
    && message.toolName !== '_reasoning'
    && message.toolName !== '_thinking');

  return (
    <aside
      className={styles.detail}
      role="dialog"
      aria-label="Build detail"
      {...{ 'data-testid': 'product-build-detail' }}
    >
      <button
        type="button"
        className={styles.secondaryButton}
        onClick={onClose}
        {...{ 'data-testid': 'product-build-detail-close' }}
      >
        Close
      </button>
      <p {...{ 'data-testid': 'product-build-detail-status' }}>{productBuildStatusLabel(summary.status)}</p>
      <h2>What you asked</h2>
      <p {...{ 'data-testid': 'product-build-detail-request' }}>{summary.request || 'No request was saved.'}</p>
      {messages.length > 0 && (
        <div className={styles.qa} {...{ 'data-testid': 'product-build-detail-qa' }}>
          <h3>Questions and answers</h3>
          {messages.map((message) => (
            <p key={message.id} {...{ 'data-testid': `product-build-detail-message-${message.id}` }}>
              {message.text}
            </p>
          ))}
        </div>
      )}
      <h3>Preview</h3>
      {html ? (
        <iframe
          className={styles.previewFrame}
          srcDoc={html}
          sandbox="allow-scripts"
          title="Approved preview"
          {...{ 'data-testid': 'product-build-detail-preview' }}
        />
      ) : (
        <p className={styles.previewEmpty}>No preview for this build.</p>
      )}
      <h3>In this build</h3>
      <p {...{ 'data-testid': 'product-build-detail-summary' }}>{summary.summary || 'Not set yet.'}</p>
      <h3>Out of this build</h3>
      <ul className={styles.detailList} {...{ 'data-testid': 'product-build-detail-out' }}>
        {summary.outOfScope.length === 0
          ? <li>None</li>
          : summary.outOfScope.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <h3>Saved for later</h3>
      <ul className={styles.detailList} {...{ 'data-testid': 'product-build-detail-deferred' }}>
        {summary.deferred.length === 0
          ? <li>None</li>
          : summary.deferred.map((item) => <li key={item}>{item}</li>)}
      </ul>
      <h3>Checks</h3>
      {summary.checks.length === 0 ? (
        <p>No checks yet.</p>
      ) : (
        <ul className={styles.detailList} {...{ 'data-testid': 'product-build-detail-checks' }}>
          {summary.checks.map((check) => (
            <li key={check.kind}>
              {CHECK_LABELS[check.kind]}: {check.outcome === 'passed' ? 'Pass' : 'Fail'}
            </li>
          ))}
        </ul>
      )}
      <details className={styles.folded} {...{ 'data-testid': 'product-build-detail-details' }}>
        <summary {...{ 'data-testid': 'product-build-detail-details-toggle' }}>Details</summary>
        {summary.adoWorkItemId != null && (
          <p {...{ 'data-testid': 'product-build-work-item' }}>Work item {summary.adoWorkItemId}</p>
        )}
        {summary.agentRunId && (
          <p {...{ 'data-testid': 'product-build-run' }}>Run {summary.agentRunId}</p>
        )}
        {summary.prUrl && (
          <a
            className={styles.prLink}
            href={summary.prUrl}
            target="_blank"
            rel="noreferrer"
            {...{ 'data-testid': 'product-build-pr' }}
          >
            Open the review
          </a>
        )}
      </details>
    </aside>
  );
};
