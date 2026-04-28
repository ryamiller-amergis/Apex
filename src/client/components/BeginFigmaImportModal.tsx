import { useState } from 'react';
import {
  buildFigmaImportPrompt,
  buildCursorPromptDeeplink,
  type FigmaImportPromptArgs,
} from '../utils/cursorDeeplink';
import styles from './BeginFigmaImportModal.module.css';

interface BeginFigmaImportModalProps {
  /** Title shown in the meta block — e.g. "Feature Overview" or the PBI title */
  mockTitle: string;
  /** "Feature" or "PBI" badge displayed next to the title */
  mockKind: 'Feature' | 'PBI';
  /** Indicates whether this is a re-import after a prior Figma URL was created */
  isReimport?: boolean;
  /** All inputs needed to construct the prompt + deeplink */
  promptArgs: FigmaImportPromptArgs;
  onClose: () => void;
  /** Optional callback fired when the user clicks "Open in Cursor" */
  onImportInitiated?: () => void;
}

const FigmaIcon: React.FC = () => (
  <svg width="14" height="20" viewBox="0 0 38 57" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" fill="#1ABCFE" />
    <path d="M0 47.5a9.5 9.5 0 0 1 9.5-9.5H19v9.5a9.5 9.5 0 0 1-19 0z" fill="#0ACF83" />
    <path d="M19 0v19h9.5a9.5 9.5 0 0 0 0-19H19z" fill="#FF7262" />
    <path d="M0 9.5a9.5 9.5 0 0 0 9.5 9.5H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" fill="#F24E1E" />
    <path d="M0 28.5a9.5 9.5 0 0 0 9.5 9.5H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" fill="#A259FF" />
  </svg>
);

export default function BeginFigmaImportModal({
  mockTitle,
  mockKind,
  isReimport = false,
  promptArgs,
  onClose,
  onImportInitiated,
}: BeginFigmaImportModalProps) {
  const promptText = buildFigmaImportPrompt(promptArgs);
  const { desktop: desktopLink, web: webLink } = buildCursorPromptDeeplink(promptText);

  const [promptCopied, setPromptCopied] = useState(false);
  const [openAttempted, setOpenAttempted] = useState(false);

  const copyPrompt = () => {
    navigator.clipboard.writeText(promptText).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = promptText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
  };

  const handleOpenInCursor = () => {
    window.location.href = desktopLink;
    setOpenAttempted(true);
    onImportInitiated?.();
  };

  const pageName = promptArgs.pbiId && promptArgs.pbiTitle
    ? `${promptArgs.featureTitle} — ${promptArgs.pbiTitle}`
    : promptArgs.featureTitle;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="figma-import-modal-title">
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title} id="figma-import-modal-title">
            <FigmaIcon />
            {isReimport ? 'Re-import to Figma' : 'Import to Figma'}
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {/* Mock info */}
          <div className={styles.mockMeta}>
            <span className={styles.mockLabel}>{mockKind}</span>
            <span className={styles.mockTitle}>{mockTitle}</span>
            <div className={styles.mockBadgeRow}>
              <span className={styles.mockBadge}>Figma page: {pageName}</span>
            </div>
          </div>

          {/* Prompt preview */}
          <div className={styles.promptSection}>
            <span className={styles.sectionLabel}>Cursor prompt that will be sent</span>
            <div className={styles.promptBox}>
              <button
                className={`${styles.copyBtn}${promptCopied ? ` ${styles.copied}` : ''}`}
                onClick={copyPrompt}
                title="Copy prompt"
              >
                {promptCopied ? '✓ Copied' : 'Copy'}
              </button>
              <pre className={styles.promptText}>{promptText}</pre>
            </div>
          </div>

          {/* Hint */}
          <p className={styles.hint}>
            Make sure Cursor Desktop has the <strong>MaxView</strong> workspace open before
            clicking "Open in Cursor". The prompt will be pre-filled in the chat — review it,
            then press Enter to kick off the Figma import. The agent uses the
            <strong> figma-generate-design</strong> and <strong> figma-use</strong> skills to
            build the screen with real MWx Design System components.
          </p>
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <button
            className={styles.btnPrimary}
            onClick={handleOpenInCursor}
            title="Open Cursor Desktop with the Figma import prompt pre-filled"
          >
            <FigmaIcon />
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
          <button className={styles.btnCancel} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
