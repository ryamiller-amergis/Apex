import React, { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { requestReleaseChangelog } from '../hooks/useReleaseChangelog';
import type { GenerateReleaseChangelogResponse } from '../../shared/types/releaseChangelog';
import styles from './ReleaseChangelogModal.module.css';

interface ReleaseChangelogModalProps {
  epicId: number;
  version: string;
  project: string;
  areaPath: string;
  onClose: () => void;
  'data-testid'?: string;
}

export const ReleaseChangelogModal: React.FC<ReleaseChangelogModalProps> = ({
  epicId,
  version,
  project,
  areaPath,
  onClose,
  'data-testid': dataTestId = 'release-changelog-modal',
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'markdown'>('preview');
  const [draftMarkdown, setDraftMarkdown] = useState('');
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [result, setResult] = useState<GenerateReleaseChangelogResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const requestedKeyRef = useRef<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  const runGeneration = useCallback(
    (forceRefresh = false) => {
      const generation = ++generationRef.current;
      setPhase('loading');
      setErrorMessage('');
      requestReleaseChangelog({ epicId, project, areaPath, forceRefresh })
        .then((response) => {
          if (generationRef.current !== generation) return;
          setResult(response);
          setDraftMarkdown(response.markdown);
          setPhase('ready');
        })
        .catch((err: unknown) => {
          if (generationRef.current !== generation) return;
          setErrorMessage(
            err instanceof Error ? err.message : 'Failed to generate release changelog.',
          );
          setPhase('error');
        });
    },
    [areaPath, epicId, project],
  );

  const handleRegenerate = useCallback(() => {
    setCopied(false);
    runGeneration(true);
  }, [runGeneration]);

  useEffect(() => {
    const requestKey = `${project}:${areaPath}:${epicId}`;
    if (requestedKeyRef.current === requestKey) return;
    requestedKeyRef.current = requestKey;
    runGeneration(false);
  }, [areaPath, epicId, project, runGeneration]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const filename =
    result?.filename ??
    `${
      version
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'release'
    }-changelog.md`;

  const handleCopy = async () => {
    if (!draftMarkdown.trim()) return;
    try {
      await navigator.clipboard.writeText(draftMarkdown);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Clipboard API may be unavailable in restricted contexts
    }
  };

  const handleDownload = () => {
    if (!draftMarkdown.trim()) return;
    const blob = new Blob([draftMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(anchor);
  };

  return (
    <div
      className={styles.overlay}
      {...{ 'data-testid': 'release-changelog-overlay' }}
      onClick={onClose}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-changelog-title"
        {...{ 'data-testid': dataTestId }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.titleGroup}>
            <h3 id="release-changelog-title" className={styles.title}>
              Executive Release Changelog — {version}
            </h3>
            <span className={styles.subtitle}>
              High-level, platform-aware summary rolled up from associated Epics, Features, PBIs, TBIs, and Bugs
            </span>
            {result && phase === 'ready' && (
              <div className={styles.metaRow}>
                <span className={styles.metaPill}>
                  {result.itemCount} linked item{result.itemCount === 1 ? '' : 's'}
                  {result.leafItemCount !== result.itemCount
                    ? ` (${result.leafItemCount} deliverables rolled up)`
                    : ''}
                </span>
                {result.platformsIncluded.map((platformName) => (
                  <span key={platformName} className={styles.platformPill}>
                    {platformName}
                  </span>
                ))}
                {typeof result.durationMs === 'number' && (
                  <span className={styles.metaPill}>
                    {(result.durationMs / 1000).toFixed(1)}s
                  </span>
                )}
                <span className={styles.metaPill}>
                  {result.source === 'ai'
                    ? result.modelUsed || 'AI draft'
                    : 'Drafted from linked work items'}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            aria-label="Close changelog modal"
            {...{ 'data-testid': 'release-changelog-close' }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {phase === 'ready' && draftMarkdown && (
          <div className={styles.toolbar}>
            <div className={styles.tabGroup} role="tablist" aria-label="Changelog view mode">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'preview'}
                className={`${styles.tabBtn} ${activeTab === 'preview' ? styles.tabBtnActive : ''}`}
                {...{ 'data-testid': 'release-changelog-tab-preview' }}
                onClick={() => setActiveTab('preview')}
              >
                Preview
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'markdown'}
                className={`${styles.tabBtn} ${activeTab === 'markdown' ? styles.tabBtnActive : ''}`}
                {...{ 'data-testid': 'release-changelog-tab-markdown' }}
                onClick={() => setActiveTab('markdown')}
              >
                Edit Markdown
              </button>
            </div>
            <span className={styles.filenameHint}>{filename}</span>
          </div>
        )}

        <div className={styles.body}>
          {phase === 'loading' ? (
            <div
              className={styles.loadingState}
              {...{ 'data-testid': 'release-changelog-loading' }}
            >
              <div className={styles.spinner} />
              <div className={styles.loadingTitle}>
                Generating executive changelog for {version}…
              </div>
              <div className={styles.loadingSubtext}>
                Evaluating associated work items, hierarchical Feature/PBI rollups, and target platforms.
              </div>
            </div>
          ) : phase === 'error' ? (
            <div
              className={styles.errorState}
              role="alert"
              {...{ 'data-testid': 'release-changelog-error' }}
            >
              <div>{errorMessage || 'Failed to generate release changelog.'}</div>
              <button
                type="button"
                className={styles.secondaryBtn}
                {...{ 'data-testid': 'release-changelog-retry' }}
                onClick={handleRegenerate}
              >
                Try Again
              </button>
            </div>
          ) : activeTab === 'markdown' ? (
            <textarea
              className={styles.editor}
              aria-label="Changelog Markdown content"
              {...{ 'data-testid': 'release-changelog-editor' }}
              value={draftMarkdown}
              onChange={(e) => setDraftMarkdown(e.target.value)}
            />
          ) : (
            <div
              className={styles.preview}
              {...{ 'data-testid': 'release-changelog-preview' }}
            >
              <ReactMarkdown>{draftMarkdown}</ReactMarkdown>
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.secondaryBtn}
            disabled={phase === 'loading'}
            {...{ 'data-testid': 'release-changelog-regenerate' }}
            onClick={handleRegenerate}
          >
            ↻ Regenerate
          </button>
          <div className={styles.footerRight}>
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={phase !== 'ready' || !draftMarkdown.trim()}
              {...{ 'data-testid': 'release-changelog-copy' }}
              onClick={() => void handleCopy()}
            >
              {copied ? '✓ Copied' : 'Copy Markdown'}
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={phase !== 'ready' || !draftMarkdown.trim()}
              {...{ 'data-testid': 'release-changelog-download' }}
              onClick={handleDownload}
            >
              ⬇ Download .md
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
