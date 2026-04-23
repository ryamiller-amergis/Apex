import { useState } from 'react';
import type { BacklogPBI } from '../types/workitem';
import {
  buildDesignDocKickoffPrompt,
  buildCursorPromptDeeplink,
  getMaxViewRepoUrl,
} from '../utils/cursorDeeplink';
import styles from './BeginDevKickoffModal.module.css';

interface BeginDevKickoffModalProps {
  pbi: BacklogPBI;
  onClose: () => void;
  onKickoffInitiated?: () => void;
}

export default function BeginDevKickoffModal({ pbi, onClose, onKickoffInitiated }: BeginDevKickoffModalProps) {
  const adoId = (pbi as any).adoWorkItemId as number | undefined;
  const hasAdoId = typeof adoId === 'number';

  const promptText = hasAdoId ? buildDesignDocKickoffPrompt(adoId!) : '';
  const { desktop: desktopLink, web: webLink } = hasAdoId
    ? buildCursorPromptDeeplink(promptText)
    : { desktop: '', web: '' };

  const repoUrl = getMaxViewRepoUrl();

  const [promptCopied, setPromptCopied] = useState(false);
  const [repoCopied, setRepoCopied] = useState(false);
  const [openAttempted, setOpenAttempted] = useState(false);

  const copyToClipboard = (text: string, which: 'prompt' | 'repo') => {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
    if (which === 'prompt') {
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2000);
    } else {
      setRepoCopied(true);
      setTimeout(() => setRepoCopied(false), 2000);
    }
  };

  const handleOpenInCursor = () => {
    window.location.href = desktopLink;
    setOpenAttempted(true);
    onKickoffInitiated?.();
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="kickoff-modal-title">
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title} id="kickoff-modal-title">
            ▶ Begin Development — Design Doc Kickoff
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {/* PBI info */}
          <div className={styles.pbiMeta}>
            <span className={styles.pbiLabel}>PBI</span>
            <span className={styles.pbiTitle}>{pbi.title}</span>
            {hasAdoId ? (
              <span className={styles.adoBadge}>ADO #{adoId}</span>
            ) : (
              <div className={styles.guard}>
                This PBI has not been created in Azure DevOps yet. Run{' '}
                <strong>⊕ Create ADO Items</strong> on the parent Epic first, then come back to
                kick off the design doc.
              </div>
            )}
          </div>

          {hasAdoId && (
            <>
              {/* Prompt preview */}
              <div className={styles.promptSection}>
                <span className={styles.sectionLabel}>Cursor prompt that will be sent</span>
                <div className={styles.promptBox}>
                  <span className={styles.promptText}>{promptText}</span>
                  <button
                    className={`${styles.copyBtn}${promptCopied ? ` ${styles.copied}` : ''}`}
                    onClick={() => copyToClipboard(promptText, 'prompt')}
                    title="Copy prompt"
                  >
                    {promptCopied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Repo URL */}
              <div className={styles.repoSection}>
                <span className={styles.sectionLabel}>MaxView repository</span>
                <div className={styles.repoRow}>
                  <span className={styles.repoUrl}>{repoUrl}</span>
                  <button
                    className={`${styles.copyBtn}${repoCopied ? ` ${styles.copied}` : ''}`}
                    onClick={() => copyToClipboard(repoUrl, 'repo')}
                    title="Copy repo URL"
                  >
                    {repoCopied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Hint */}
              <p className={styles.hint}>
                Make sure the <strong>MaxView</strong> workspace is open in Cursor Desktop before
                clicking "Open in Cursor". The prompt will be pre-filled in the chat — review it,
                then press Enter to run <code>/design-doc-kickoff</code>.
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          {hasAdoId && (
            <>
              <button
                className={styles.btnPrimary}
                onClick={handleOpenInCursor}
                title="Open Cursor Desktop with the design-doc-kickoff prompt pre-filled"
              >
                Open in Cursor
              </button>
              {openAttempted && (
                <div className={styles.webFallbackNote}>
                  Cursor didn't open?{' '}
                  <a href={webLink} target="_blank" rel="noopener noreferrer">
                    Use the web link instead
                  </a>
                </div>
              )}
            </>
          )}
          <button className={styles.btnCancel} onClick={onClose}>
            {hasAdoId ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
