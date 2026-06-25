import { useState } from 'react';
import { buildApexImplementPrompt, buildCursorPromptDeeplink, getMaxViewRepoUrl } from '../utils/cursorDeeplink';
import styles from './BeginImplementationModal.module.css';

interface BeginImplementationModalProps {
  featureTitle: string;
  featureAdoId: number | undefined;
  onClose: () => void;
}

export default function BeginImplementationModal({
  featureTitle,
  featureAdoId,
  onClose,
}: BeginImplementationModalProps) {
  const hasAdoId = typeof featureAdoId === 'number';

  const promptText = hasAdoId ? buildApexImplementPrompt(featureAdoId!) : '';
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
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="impl-modal-title">
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title} id="impl-modal-title">
            Start Implementation in Cursor
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.featureMeta}>
            <span className={styles.featureLabel}>Feature</span>
            <span className={styles.featureTitle}>{featureTitle}</span>
            {hasAdoId ? (
              <span className={styles.adoBadge}>ADO Feature #{featureAdoId}</span>
            ) : (
              <div className={styles.guard}>
                This design doc's feature has not been created in Azure DevOps yet. Run{' '}
                <strong>Create ADO Items</strong> on the parent PRD first, then come back to start
                implementation.
              </div>
            )}
          </div>

          {hasAdoId && (
            <>
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

              <div className={styles.whatHappensSection}>
                <span className={styles.sectionLabel}>What will happen</span>
                <ol className={styles.stepsList}>
                  <li>The skill reads the design doc, tech spec, assumptions, and acceptance criteria from ADO Feature #{featureAdoId}.</li>
                  <li>A Principal-Engineer implementation plan is drafted — you review and approve it before any code is written.</li>
                  <li>On approval: feature branch is created, code + unit tests are implemented, a self code-review is performed, and a PR is opened — with the ADO Feature moved to <strong>In Pull Request</strong>.</li>
                </ol>
              </div>

              <p className={styles.hint}>
                Make sure the <strong>MaxView</strong> workspace is open in Cursor Desktop before
                clicking "Open in Cursor". The prompt will be pre-filled in the chat — review it,
                then press Enter to run <code>/apex-implement-feature</code>.
              </p>
            </>
          )}
        </div>

        <div className={styles.footer}>
          {hasAdoId && (
            <>
              <button
                className={styles.btnPrimary}
                onClick={handleOpenInCursor}
                title="Open Cursor Desktop with the apex-implement-feature prompt pre-filled"
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
