import React, { useState, useEffect, useRef } from 'react';
import type { UiMock } from '../../shared/types/backlog';
import './UiMockPreview.css';

interface UiMockPreviewProps {
  mock: UiMock;
  onSelectVersion?: (version: number) => void;
  onDeleteVersion?: (version: number) => void;
  /** Feedback text controlled by the parent */
  feedback?: string;
  onFeedbackChange?: (value: string) => void;
  onRegenerate?: () => void;
  isBusy?: boolean;
}

export const UiMockPreview: React.FC<UiMockPreviewProps> = ({
  mock,
  onSelectVersion,
  onDeleteVersion,
  feedback = '',
  onFeedbackChange,
  onRegenerate,
  isBusy = false,
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const [viewingVersion, setViewingVersion] = useState(mock.mockVersion);
  const [deleteConfirmVersion, setDeleteConfirmVersion] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setViewingVersion(mock.mockVersion);
  }, [mock.mockVersion]);

  useEffect(() => {
    if (suggestionOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [suggestionOpen]);

  const visibleEntry =
    viewingVersion === mock.mockVersion
      ? { mockHtml: mock.mockHtml, decision: mock.decision, feedback: undefined }
      : mock.history.find(h => h.version === viewingVersion);

  const srcDoc = visibleEntry?.mockHtml ?? null;

  const handleVersionChange = (v: number) => {
    setViewingVersion(v);
    onSelectVersion?.(v);
  };

  const sortedHistory = [...mock.history].sort((a, b) => b.version - a.version);

  const versionLabel = (v: number) => {
    const parts: string[] = [`v${v}`];
    if (v === mock.mockVersion) parts.push('current');
    if (v === mock.approvedVersion) parts.push('approved');
    const entry = mock.history.find(h => h.version === v);
    if (entry?.feedback && v !== mock.mockVersion) parts.push(entry.feedback.slice(0, 28) + (entry.feedback.length > 28 ? '…' : ''));
    return parts.length > 1 ? `v${v} (${parts.slice(1).join(', ')})` : `v${v}`;
  };

  const isLastVersion = mock.history.length <= 1;

  return (
    <>
      {/* ── Delete confirmation modal ── */}
      {deleteConfirmVersion !== null && (
        <div className="ui-mock-preview__modal-backdrop" onClick={() => setDeleteConfirmVersion(null)}>
          <div className="ui-mock-preview__modal" onClick={e => e.stopPropagation()}>
            <div className="ui-mock-preview__modal-title">Remove version</div>
            <div className="ui-mock-preview__modal-body">
              {isLastVersion
                ? <>Removing <strong>v{deleteConfirmVersion}</strong> will discard the entire mock. This cannot be undone.</>
                : deleteConfirmVersion === mock.mockVersion
                  ? <>Removing <strong>v{deleteConfirmVersion} (current)</strong> will promote the previous version. This cannot be undone.</>
                  : <>Remove <strong>v{deleteConfirmVersion}</strong> from history? This cannot be undone.</>
              }
            </div>
            <div className="ui-mock-preview__modal-actions">
              <button className="ui-mock-preview__modal-btn-cancel" onClick={() => setDeleteConfirmVersion(null)}>
                Cancel
              </button>
              <button
                className="ui-mock-preview__modal-btn-confirm"
                onClick={() => { onDeleteVersion?.(deleteConfirmVersion); setDeleteConfirmVersion(null); }}
              >
                {isLastVersion ? 'Discard mock' : 'Remove version'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`ui-mock-preview${isFullscreen ? ' ui-mock-preview--fullscreen' : ''}`}>
        {/* Toolbar */}
        <div className="ui-mock-preview__toolbar">
          <div className="ui-mock-preview__toolbar-left">
            {mock.history.length > 0 && (
              <div className="ui-mock-preview__version-selector">
                <label htmlFor="mock-version-select" className="ui-mock-preview__version-label">
                  Version:
                </label>
                <select
                  id="mock-version-select"
                  value={viewingVersion}
                  onChange={e => handleVersionChange(Number(e.target.value))}
                  className="ui-mock-preview__version-select"
                >
                  {sortedHistory.map(h => (
                    <option key={h.version} value={h.version}>
                      {versionLabel(h.version)}
                    </option>
                  ))}
                </select>
                {onDeleteVersion && (
                  <button
                    className="ui-mock-preview__btn-delete-version"
                    onClick={() => setDeleteConfirmVersion(viewingVersion)}
                    disabled={isBusy}
                    title={`Remove v${viewingVersion}`}
                    aria-label={`Remove version ${viewingVersion}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="ui-mock-preview__toolbar-right">
            <button
              className="ui-mock-preview__btn-icon"
              onClick={() => setIsFullscreen(f => !f)}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen preview'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen preview'}
            >
              {isFullscreen ? '⤡' : '⤢'}
            </button>
          </div>
        </div>

        {/* Preview iframe — srcDoc is a full HTML document from the server */}
        <div className="ui-mock-preview__frame-wrapper">
          {srcDoc ? (
            <iframe
              className="ui-mock-preview__iframe"
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              title={`UI mock v${viewingVersion}`}
            />
          ) : (
            <div className="ui-mock-preview__no-html">
              No visual mock for this version (decision: {visibleEntry?.decision ?? mock.decision})
            </div>
          )}
        </div>

        {viewingVersion !== mock.mockVersion && visibleEntry?.feedback && (
          <div className="ui-mock-preview__history-note">
            <span className="ui-mock-preview__history-label">Feedback that created v{viewingVersion}:</span>{' '}
            {visibleEntry.feedback}
          </div>
        )}

        {/* ── Floating suggestion panel (fullscreen only) ── */}
        {isFullscreen && onRegenerate && (
          <div className={`ui-mock-preview__suggestion-panel${suggestionOpen ? ' is-open' : ''}`}>
            {suggestionOpen ? (
              <>
                <textarea
                  ref={textareaRef}
                  className="ui-mock-preview__suggestion-input"
                  placeholder="Describe the changes you want (e.g. &quot;add a search bar, use a table instead of cards&quot;)…"
                  value={feedback}
                  onChange={e => onFeedbackChange?.(e.target.value)}
                  rows={3}
                  disabled={isBusy}
                />
                <div className="ui-mock-preview__suggestion-actions">
                  <button
                    className="ui-mock-preview__suggestion-btn-cancel"
                    onClick={() => setSuggestionOpen(false)}
                    disabled={isBusy}
                  >
                    Cancel
                  </button>
                  <button
                    className="ui-mock-preview__suggestion-btn-regen"
                    onClick={() => { onRegenerate(); setSuggestionOpen(false); }}
                    disabled={isBusy || !feedback.trim()}
                    title={!feedback.trim() ? 'Enter a suggestion above' : undefined}
                  >
                    {isBusy ? 'Regenerating…' : '↻ Regenerate'}
                  </button>
                </div>
              </>
            ) : (
              <button
                className="ui-mock-preview__suggestion-trigger"
                onClick={() => setSuggestionOpen(true)}
                disabled={isBusy}
              >
                ✎ Suggest changes
              </button>
            )}
          </div>
        )}
      </div>

      {isFullscreen && (
        <button
          className="ui-mock-preview__fullscreen-backdrop"
          onClick={() => setIsFullscreen(false)}
          aria-label="Close fullscreen"
        />
      )}
    </>
  );
};
