import React, { useEffect, useState } from 'react';
import { useLocalDevContext } from '../hooks/useLocalDevContext';
import { downloadArtifactZip } from '../utils/artifactDownload';
import { buildCursorPromptDeeplink } from '../utils/cursorDeeplink';
import { canWriteLocalDevFiles, writeLocalDevFilesToRepo } from '../utils/localDevFs';
import styles from './StartLocalDevModal.module.css';

export type StartLocalDevTarget =
  | { kind: 'apex'; project: string; prdId: string; featureId: string; title: string }
  | { kind: 'ado'; project: string; workItemId: number; title: string };

interface StartLocalDevModalProps {
  target: StartLocalDevTarget;
  onClose: () => void;
}

type EditorChoice = 'cursor' | 'vscode';

function copyText(text: string): void {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

export const StartLocalDevModal: React.FC<StartLocalDevModalProps> = ({ target, onClose }) => {
  const [editor, setEditor] = useState<EditorChoice>('cursor');
  const [promptCopied, setPromptCopied] = useState(false);
  const [openAttempted, setOpenAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [packDownloaded, setPackDownloaded] = useState(false);
  const [fsSupported] = useState(() => canWriteLocalDevFiles());
  const [forceManual, setForceManual] = useState(false);

  const fetchContext = useLocalDevContext();

  useEffect(() => {
    const params =
      target.kind === 'apex'
        ? { project: target.project, prdId: target.prdId, featureId: target.featureId }
        : { project: target.project, workItemId: target.workItemId };
    fetchContext.mutate(params);
    setStatusNote(null);
    setActionError(null);
    setPackDownloaded(false);
    setOpenAttempted(false);
    setForceManual(false);
    setPromptCopied(false);
    // Intentionally fetch once when the modal mounts for this target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind === 'apex' ? `${target.prdId}:${target.featureId}` : target.workItemId, target.project]);

  const data = fetchContext.data;
  const isLoading = fetchContext.isPending;
  const error = fetchContext.error;

  const promptText = data?.prompt ?? '';
  const { desktop: desktopLink, web: webLink } = promptText
    ? buildCursorPromptDeeplink(promptText)
    : { desktop: '', web: '' };

  const extractPath = data
    ? `.ai-pilot/local-dev/${data.slug}/`
    : '.ai-pilot/local-dev/{slug}/';

  const canDeepLink = editor === 'cursor';
  /** Write files into the repo automatically when the browser allows it. */
  const useAutomaticPath = fsSupported && !forceManual;
  /** ZIP download only when we cannot write files into the repo. */
  const showManualDownload = !useAutomaticPath;

  const handleDownloadZip = () => {
    if (!data) return;
    downloadArtifactZip(`local-dev-${data.slug}.zip`, data.files);
    setPackDownloaded(true);
  };

  const handleCopyPrompt = () => {
    if (!promptText) return;
    copyText(promptText);
    setPromptCopied(true);
    window.setTimeout(() => setPromptCopied(false), 2000);
  };

  const finishInEditor = (writtenNote?: string) => {
    if (canDeepLink) {
      if (writtenNote) setStatusNote(writtenNote);
      if (!desktopLink) return;
      // Use an anchor click instead of location.href so the page stays put and
      // any last disk flush isn't interrupted by a navigation.
      const anchor = document.createElement('a');
      anchor.href = desktopLink;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setOpenAttempted(true);
      return;
    }
    copyText(promptText);
    setPromptCopied(true);
    setStatusNote(
      writtenNote
        ? `${writtenNote} Kickoff prompt copied — paste it into VS Code chat.`
        : 'Kickoff prompt copied — paste it into VS Code chat.',
    );
    window.setTimeout(() => setPromptCopied(false), 2000);
  };

  const handleOpenInIde = async () => {
    if (!data) return;
    setBusy(true);
    setActionError(null);
    setStatusNote(null);
    try {
      let writtenNote: string | undefined;
      if (fsSupported) {
        // Always confirm the folder so we don't silently write to a stale handle.
        const result = await writeLocalDevFilesToRepo(data.files, {
          forcePick: true,
          extractPathHint: extractPath,
        });
        writtenNote = `Wrote ${result.fileCount} files into ${result.repoName}/${result.extractPath}`;
      }
      finishInEditor(writtenNote);
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') {
        setActionError(null);
      } else {
        setForceManual(true);
        setActionError(
          (err as Error).message
            || 'Could not write into the repo. Use the download steps below.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const primaryLabel = canDeepLink
    ? (busy ? 'Opening…' : 'Open in Cursor')
    : (busy ? 'Setting up…' : promptCopied ? '✓ Prompt copied' : 'Set up for VS Code');

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="local-dev-modal-title"
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title} id="local-dev-modal-title">
            Start Local Development
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close" type="button">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.meta}>
            <span className={styles.metaLabel}>Work item</span>
            <span className={styles.metaTitle}>{target.title}</span>
            {target.kind === 'ado' && (
              <span className={styles.badge}>ADO #{target.workItemId}</span>
            )}
            {target.kind === 'apex' && (
              <span className={styles.badge}>{target.featureId}</span>
            )}
          </div>

          <div className={styles.editorToggle} role="group" aria-label="Editor">
            <button
              type="button"
              className={`${styles.editorBtn}${editor === 'cursor' ? ` ${styles.editorBtnActive}` : ''}`}
              onClick={() => {
                setEditor('cursor');
                setForceManual(false);
                setActionError(null);
                setStatusNote(null);
              }}
              aria-pressed={editor === 'cursor'}
            >
              Cursor
            </button>
            <button
              type="button"
              className={`${styles.editorBtn}${editor === 'vscode' ? ` ${styles.editorBtnActive}` : ''}`}
              onClick={() => {
                setEditor('vscode');
                setForceManual(false);
                setActionError(null);
                setStatusNote(null);
              }}
              aria-pressed={editor === 'vscode'}
            >
              VS Code
            </button>
          </div>

          {isLoading && <div className={styles.status}>Building context pack…</div>}
          {error && <div className={styles.error}>{error.message}</div>}
          {actionError && <div className={styles.error}>{actionError}</div>}
          {statusNote && <p className={styles.successNote}>{statusNote}</p>}

          {data && useAutomaticPath && (
            <div className={styles.primaryBlock}>
              {canDeepLink ? (
                <p className={styles.lead}>
                  You&apos;ll pick your <strong>repository root</strong>. We write the context pack to{' '}
                  <code>{extractPath}</code> (may be hidden in the IDE because it&apos;s gitignored),
                  then open Cursor with the kickoff prompt.
                </p>
              ) : (
                <p className={styles.lead}>
                  You&apos;ll pick your <strong>repository root</strong>. We write the context pack to{' '}
                  <code>{extractPath}</code> (may be hidden in the IDE because it&apos;s gitignored)
                  and copy the kickoff prompt — paste it into VS Code chat.
                </p>
              )}
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={handleOpenInIde}
                disabled={busy}
              >
                {primaryLabel}
              </button>
              {canDeepLink && openAttempted && (
                <p className={styles.webFallbackNote}>
                  Cursor didn&apos;t open?{' '}
                  <a href={webLink} target="_blank" rel="noopener noreferrer">
                    Use the web link instead
                  </a>
                </p>
              )}
            </div>
          )}

          {data && showManualDownload && (
            <div className={styles.primaryBlock}>
              <p className={styles.lead}>
                {canDeepLink
                  ? 'This browser can\'t write files into your repo automatically. Download the pack, extract it, then open Cursor.'
                  : 'This browser can\'t write files into your repo automatically. Download the pack, extract it, then paste the kickoff prompt into VS Code chat.'}
              </p>

              <ol className={styles.manualSteps}>
                <li>
                  <div className={styles.stepHeader}>
                    <span className={styles.stepTitle}>Download context pack</span>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={handleDownloadZip}
                    >
                      {packDownloaded ? 'Download again' : 'Download ZIP'}
                    </button>
                  </div>
                  <p className={styles.stepHint}>
                    PRD, design docs, acceptance criteria, test cases, and prototype HTML when
                    available ({data.files.length} files).
                  </p>
                </li>
                <li>
                  <div className={styles.stepHeader}>
                    <span className={styles.stepTitle}>Extract into repo root</span>
                  </div>
                  <p className={styles.stepHint}>
                    Unzip so this path exists: <code>{extractPath}</code>
                  </p>
                </li>
                <li>
                  <div className={styles.stepHeader}>
                    <span className={styles.stepTitle}>
                      {canDeepLink ? 'Open Cursor' : 'Paste kickoff prompt'}
                    </span>
                    {canDeepLink ? (
                      <button
                        type="button"
                        className={styles.btnPrimary}
                        onClick={handleOpenInIde}
                        disabled={busy}
                      >
                        {busy ? 'Opening…' : 'Open in Cursor'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.btnPrimary}
                        onClick={handleCopyPrompt}
                      >
                        {promptCopied ? '✓ Copied' : 'Copy prompt'}
                      </button>
                    )}
                  </div>
                  {!canDeepLink && (
                    <p className={styles.stepHint}>
                      Open the repo in VS Code, open chat, and paste the prompt.
                    </p>
                  )}
                </li>
              </ol>

              {canDeepLink && openAttempted && (
                <p className={styles.webFallbackNote}>
                  Cursor didn&apos;t open?{' '}
                  <a href={webLink} target="_blank" rel="noopener noreferrer">
                    Use the web link instead
                  </a>
                </p>
              )}
            </div>
          )}

          {data && (
            <details className={styles.promptDetails}>
              <summary className={styles.sectionLabel}>Preview kickoff prompt</summary>
              <div className={styles.promptBox}>
                <pre className={styles.promptText}>{promptText}</pre>
                <button
                  type="button"
                  className={`${styles.copyBtn}${promptCopied ? ` ${styles.copied}` : ''}`}
                  onClick={handleCopyPrompt}
                >
                  {promptCopied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </details>
          )}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.btnCancel} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default StartLocalDevModal;
