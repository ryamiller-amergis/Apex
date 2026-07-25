import React, { useEffect, useRef, useState } from 'react';
import { useLoadTestAiGenerate } from '../hooks/useLoadTestAiGenerate';
import type { LoadTestAiGenerateResult } from '../../shared/types/loadTestAi';
import { ConfirmRegenerateScriptModal } from './ConfirmRegenerateScriptModal';
import { LoadTestAiUnavailableState } from './LoadTestAiUnavailableState';
import styles from './LoadTestAiGeneratePanel.module.css';

interface LoadTestAiGeneratePanelProps {
  project: string;
  /** True when at least one ProjectRepoConfigSummary has a non-empty skillRepo (AC-2). */
  connected: boolean;
  canManage: boolean;
  /** True when the current script came from a raw hand-edit (BR-010). */
  needsConfirm: boolean;
  /** Never mutates form state itself — the builder view applies the result (BR-005). */
  onApply: (result: LoadTestAiGenerateResult) => void;
}

/**
 * FEAT-011 / PBI-014 — AI generate panel for the Load Test builder.
 *
 * Flow-hints input + Generate/Cancel + streaming preview; applies the
 * result into shared form state via `onApply` once the backend reports
 * status 'ready'. Errors and cancellation never call `onApply`, so prior
 * builder content (script/thresholds) is left untouched (AC-1).
 */
export const LoadTestAiGeneratePanel: React.FC<LoadTestAiGeneratePanelProps> = ({
  project,
  connected,
  canManage,
  needsConfirm,
  onApply,
}) => {
  const { start, cancel, status, streamingText, progressLabel, result, error, isGenerating } =
    useLoadTestAiGenerate(project);

  const [flowHints, setFlowHints] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const appliedResultRef = useRef<LoadTestAiGenerateResult | null>(null);

  useEffect(() => {
    if (status === 'ready' && result && appliedResultRef.current !== result) {
      appliedResultRef.current = result;
      onApply(result);
    }
  }, [status, result, onApply]);

  if (!connected) {
    return <LoadTestAiUnavailableState />;
  }

  const trimmedHints = flowHints.trim();
  const hintsMissing = !trimmedHints;
  const generateDisabled = !canManage || hintsMissing || isGenerating;

  const runGenerate = () => {
    if (!trimmedHints) return;
    void start({ flowHints: trimmedHints });
  };

  const handleGenerateClick = () => {
    if (needsConfirm) {
      setShowConfirm(true);
      return;
    }
    runGenerate();
  };

  const confirmAndGenerate = () => {
    setShowConfirm(false);
    runGenerate();
  };

  return (
    <div className={styles.panel} data-testid="load-test-ai-panel">
      <div className={styles.summary}>
        <h3 className={styles.title}>AI generate</h3>
        <p className={styles.hint}>
          Describe the HTTP flow to simulate (endpoints, sequence, auth placeholders). The agent
          writes a k6 script from these hints — no requirement linkage required.
        </p>
        <label className={styles.flowHintsLabel} htmlFor="load-test-ai-flow-hints">
          Flow hints
        </label>
        <textarea
          id="load-test-ai-flow-hints"
          className={styles.flowHints}
          data-testid="load-test-ai-flow-hints"
          rows={4}
          disabled={!canManage || isGenerating}
          placeholder="e.g. GET /health then POST /api/login then GET /api/items with Bearer ${__ENV.AUTH_TOKEN}"
          value={flowHints}
          onChange={(e) => setFlowHints(e.target.value)}
        />
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.generateBtn}
          data-testid="load-test-ai-generate-btn"
          disabled={generateDisabled}
          aria-disabled={generateDisabled}
          onClick={handleGenerateClick}
        >
          {isGenerating ? 'Generating…' : 'Generate with AI'}
        </button>
        {isGenerating && (
          <button
            type="button"
            className={styles.cancelBtn}
            data-testid="load-test-ai-cancel-btn"
            onClick={() => void cancel()}
          >
            Cancel
          </button>
        )}
      </div>

      {isGenerating && (
        <div
          className={styles.streamPreview}
          data-testid="load-test-ai-stream-preview"
          role="status"
          aria-live="polite"
        >
          <p className={styles.progressLabel}>{progressLabel ?? 'Generating script…'}</p>
          {streamingText && <pre className={styles.streamText}>{streamingText}</pre>}
        </div>
      )}

      {status === 'ready' && result && (
        <p className={styles.successNote} role="status" data-testid="load-test-ai-applied">
          Script and suggested thresholds applied below — review before saving.
        </p>
      )}

      {status === 'cancelled' && (
        <p className={styles.cancelledNote} role="status">
          Generation cancelled. Prior script is unchanged.
        </p>
      )}

      {status === 'failed' && error && (
        <div className={styles.errorBox} role="alert" data-testid="load-test-ai-error">
          {error}
        </div>
      )}

      {showConfirm && (
        <ConfirmRegenerateScriptModal
          testId="load-test-ai-regenerate-confirm"
          title="Overwrite raw script with AI-generated result?"
          body="You edited the raw k6 script. Generating with AI will overwrite the script and thresholds once ready."
          confirmLabel="Generate anyway"
          onCancel={() => setShowConfirm(false)}
          onConfirm={confirmAndGenerate}
        />
      )}
    </div>
  );
};

export default LoadTestAiGeneratePanel;
