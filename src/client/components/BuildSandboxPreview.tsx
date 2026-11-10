import React, { useMemo, useState } from 'react';
import type {
  BuildDeploymentView,
  BuildPreviewEntry,
  BuildRunStatus,
} from '../../shared/types/build';
import type { BuildRevisionFastEditProgress } from '../../shared/types/buildRevision';
import styles from './BuildSandboxPreview.module.css';

export type SandboxViewport = 'desktop' | 'tablet' | 'phone';

export interface BuildSandboxPreviewProps {
  buildStatus: BuildRunStatus | undefined;
  deployment: BuildDeploymentView | null | undefined;
  previews: BuildPreviewEntry[] | undefined;
  livePreviewUrl: string | null;
  pipelineSteps: React.ReactNode;
  showPipelineSteps: boolean;
  revisionProgress?: BuildRevisionFastEditProgress | null;
}

function sandboxStatusLabel(input: {
  deployment: BuildDeploymentView | null | undefined;
  livePreviewUrl: string | null;
  buildStatus: BuildRunStatus | undefined;
  revisionProgress?: BuildRevisionFastEditProgress | null;
}): string {
  const { deployment, livePreviewUrl, buildStatus, revisionProgress } = input;
  if (revisionProgress) {
    switch (revisionProgress.status) {
      case 'classify':
      case 'edit':
      case 'apply':
        return 'Updating preview';
      case 'checking':
        return 'Preview updated—checking';
      case 'failed':
        return revisionProgress.error?.code === 'checks_failed'
          ? 'Checks failed'
          : 'Update needs attention';
      case 'ready':
        return 'Ready';
      case 'escalate':
        return 'Escalated to full build';
      case 'rollback':
        return 'Rolling back preview';
      case 'superseded':
        break;
      default: {
        const unhandled: never = revisionProgress.status;
        return unhandled;
      }
    }
  }
  if (buildStatus === 'deployment_failed' || deployment?.status === 'failed') {
    return 'Preview needs attention';
  }
  if (livePreviewUrl) {
    return 'Preview ready';
  }
  if (deployment?.status === 'deploying') {
    return 'Preparing your preview';
  }
  if (deployment?.status === 'queued') {
    return 'Waiting for a preview slot';
  }
  return 'Your preview will appear here';
}

function formatUpdatedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toLocaleString();
}

function iframeSandboxFor(previewUrl: string | null): string {
  const restricted = 'allow-forms allow-modals allow-scripts';
  if (!previewUrl) return restricted;

  try {
    const hostname = new URL(previewUrl).hostname;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
      ? `${restricted} allow-same-origin`
      : restricted;
  } catch {
    return restricted;
  }
}

export const BuildSandboxPreview: React.FC<BuildSandboxPreviewProps> = ({
  buildStatus,
  deployment,
  previews,
  livePreviewUrl,
  pipelineSteps,
  showPipelineSteps,
  revisionProgress,
}) => {
  const [viewport, setViewport] = useState<SandboxViewport>('desktop');
  const [reloadNonce, setReloadNonce] = useState(0);

  const liveEntry = useMemo(
    () => previews?.find((entry) => entry.isLive) ?? null,
    [previews]
  );

  const statusLabel = sandboxStatusLabel({
    deployment,
    livePreviewUrl,
    buildStatus,
    revisionProgress,
  });
  const updatedLabel = formatUpdatedAt(liveEntry?.finishedAt ?? null);
  const showIframe = Boolean(livePreviewUrl);

  return (
    <div
      className={styles.root}
      {...{ 'data-testid': 'build-sandbox-preview' }}
    >
      <div className={styles.toolbar}>
        <span
          className={styles.statusBadge}
          {...{ 'data-testid': 'build-sandbox-status' }}
        >
          {statusLabel}
        </span>
        <div className={styles.toolbarActions}>
          <div
            className={styles.viewportGroup}
            role="group"
            aria-label="Preview viewport"
            {...{ 'data-testid': 'build-sandbox-viewport-controls' }}
          >
            {(['desktop', 'tablet', 'phone'] as const).map((size) => (
              <button
                key={size}
                type="button"
                className={`${styles.viewportButton}${viewport === size ? ` ${styles.viewportButtonActive}` : ''}`}
                aria-pressed={viewport === size}
                onClick={() => setViewport(size)}
                {...{ 'data-testid': `build-sandbox-viewport-${size}` }}
              >
                {size === 'desktop'
                  ? 'Desktop'
                  : size === 'tablet'
                    ? 'Tablet'
                    : 'Phone'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setReloadNonce((value) => value + 1)}
            {...{ 'data-testid': 'build-sandbox-refresh' }}
          >
            Refresh
          </button>
          {livePreviewUrl ? (
            <a
              href={livePreviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.linkButton}
              {...{ 'data-testid': 'build-sandbox-open-tab' }}
            >
              Open in new tab
            </a>
          ) : null}
        </div>
      </div>

      {updatedLabel ? (
        <p
          className={styles.meta}
          {...{ 'data-testid': 'build-sandbox-updated' }}
        >
          {`Last updated ${updatedLabel}`}
        </p>
      ) : null}

      <div
        className={`${styles.deviceShell} ${styles[`deviceShell_${viewport}`]}`}
        {...{ 'data-testid': 'build-workspace-sandbox-frame' }}
      >
        <div className={styles.sandboxChrome}>
          <span className={styles.sandboxDots} aria-hidden="true">
            <span className={styles.sandboxDot} />
            <span className={styles.sandboxDot} />
            <span className={styles.sandboxDot} />
          </span>
          <span className={styles.sandboxUrl}>
            {livePreviewUrl ?? 'preview://waiting'}
          </span>
        </div>
        <div className={styles.sandboxViewport}>
          {showIframe ? (
            <iframe
              key={reloadNonce}
              className={styles.previewFrame}
              src={livePreviewUrl ?? undefined}
              title="Build preview"
              sandbox={iframeSandboxFor(livePreviewUrl)}
              referrerPolicy="no-referrer"
              {...{ 'data-testid': 'build-workspace-preview-iframe' }}
            />
          ) : (
            <div className={styles.placeholder}>
              <p className={styles.placeholderTitle}>{statusLabel}</p>
              <p className={styles.placeholderCopy}>
                {deployment?.status === 'failed' ||
                buildStatus === 'deployment_failed'
                  ? 'We could not prepare an interactive preview. Apex will try again when it can.'
                  : deployment?.status === 'queued'
                    ? 'Another build may be using the shared preview slot. Yours will start automatically.'
                    : deployment?.status === 'deploying'
                      ? 'Your interactive preview is being built with sample data.'
                      : 'When checks pass, Apex publishes an interactive preview here.'}
              </p>
              {showPipelineSteps ? pipelineSteps : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
