/**
 * Describe a goal, get the steps for it, and add them to the canvas in one click. The added steps
 * are wired in order after the selected step (or the last step) and stay unsaved until Save.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Loader2, Plus, Sparkles, X } from 'lucide-react';
import { stepMeta } from './playbookStepCatalog';
import styles from './PlaybookSuggestPopover.module.css';

export interface PlaybookStepSuggestion {
  stepType: string;
  title: string;
  config: Record<string, unknown>;
  reason: string;
}

type Result =
  | { kind: 'suggestions'; reason: string; suggestions: PlaybookStepSuggestion[] }
  | { kind: 'gap'; reason: string }
  | { kind: 'error'; reason: string };

const EXAMPLES = [
  'Investigate production errors, file a bug, and fix it',
  'Check the design doc and notify me',
  'Comment on the work item with a summary',
];

interface PlaybookSuggestPopoverProps {
  project: string;
  definitionId: string;
  onApply: (suggestions: PlaybookStepSuggestion[]) => void;
  onClose: () => void;
  'data-testid'?: string;
}

function configPreview(config: Record<string, unknown>): string {
  const parameters = config.parameters as Record<string, unknown> | undefined;
  for (const value of [config.prompt, config.subject, config.title, parameters?.title, config.operation]) {
    if (typeof value === 'string' && value.trim()) return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return '';
}

export const PlaybookSuggestPopover: React.FC<PlaybookSuggestPopoverProps> = ({
  project,
  definitionId,
  onApply,
  onClose,
  'data-testid': testId = 'playbook-recommend-form',
}) => {
  const [goal, setGoal] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (rootRef.current?.contains(target) || target.closest('[data-testid="playbook-canvas-recommend"]')) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const suggest = async (text: string) => {
    if (!text.trim()) return;
    setPending(true);
    setResult(null);
    try {
      const response = await fetch(
        `/api/playbooks/definitions/${encodeURIComponent(definitionId)}/recommend?project=${encodeURIComponent(project)}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project, goal: text }),
        },
      );
      const body = await response.json() as Result & { error?: string };
      setResult(response.ok ? body : { kind: 'error', reason: body.error ?? 'No suggestion could be made.' });
    } catch {
      setResult({ kind: 'error', reason: 'No suggestion could be made.' });
    } finally {
      setPending(false);
    }
  };

  const suggestions = result?.kind === 'suggestions' ? result.suggestions : [];

  return (
    <div
      ref={rootRef}
      className={styles.popover}
      role="dialog"
      aria-label="Suggest steps"
      {...{ 'data-testid': testId }}
    >
      <header className={styles.header}>
        <span className={styles.headerIcon} aria-hidden><Sparkles size={15} /></span>
        <div className={styles.headerText}>
          <h2 className={styles.title}>Suggest steps</h2>
          <p className={styles.subtitle}>Say what the Playbook should do. Apex adds the steps for you.</p>
        </div>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close suggestions"
          {...{ 'data-testid': "playbook-recommend-close" }}
        >
          <X size={15} aria-hidden />
        </button>
      </header>

      <form
        className={styles.form}
        {...{ 'data-testid': 'playbook-recommend-goal-form' }}
        onSubmit={(event) => {
          event.preventDefault();
          void suggest(goal);
        }}
      >
        <textarea
          ref={inputRef}
          className={styles.goal}
          rows={3}
          value={goal}
          placeholder="For example: every night, investigate production errors, file a bug, then fix it"
          aria-label="Goal"
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void suggest(goal);
            }
          }}
          {...{ 'data-testid': "playbook-recommend-goal" }}
        />
        <div className={styles.formFooter}>
          <div className={styles.examples}>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className={styles.example}
                onClick={() => {
                  setGoal(example);
                  void suggest(example);
                }}
                {...{ 'data-testid': "playbook-recommend-example" }}
              >
                {example}
              </button>
            ))}
          </div>
          <button
            type="submit"
            className={styles.primary}
            disabled={pending || !goal.trim()}
            {...{ 'data-testid': "playbook-recommend-suggest" }}
          >
            {pending ? <Loader2 size={14} aria-hidden className={styles.spin} /> : <Sparkles size={14} aria-hidden />}
            Suggest
          </button>
        </div>
      </form>

      {result && result.kind !== 'suggestions' ? (
        <p className={result.kind === 'error' ? styles.error : styles.gap} role="status">{result.reason}</p>
      ) : null}

      {suggestions.length ? (
        <section className={styles.results} aria-label="Suggested steps">
          <p className={styles.resultsLead}>{result?.reason}</p>
          <ol className={styles.cards}>
            {suggestions.map((suggestion, index) => {
              const meta = stepMeta(suggestion.stepType);
              const Icon = meta.icon;
              const preview = configPreview(suggestion.config);
              return (
                <li key={`${suggestion.stepType}-${index}`} className={styles.card} data-group={meta.group}>
                  <span className={styles.cardIndex} aria-hidden>{index + 1}</span>
                  <span className={styles.cardIcon} aria-hidden><Icon size={15} /></span>
                  <span className={styles.cardText}>
                    <span className={styles.cardTitle}>{suggestion.title}</span>
                    <span className={styles.cardReason}>{suggestion.reason}</span>
                    {preview ? <span className={styles.cardPreview}>{preview}</span> : null}
                  </span>
                  <button
                    type="button"
                    className={styles.cardAdd}
                    onClick={() => onApply([suggestion])}
                    aria-label={`Add ${suggestion.title}`}
                    {...{ 'data-testid': `playbook-recommend-add-${index}` }}
                  >
                    <Plus size={14} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className={`${styles.primary} ${styles.applyAll}`}
            onClick={() => onApply(suggestions)}
            {...{ 'data-testid': "playbook-recommend-accept" }}
          >
            {suggestions.length === 1 ? 'Add this step' : `Add all ${suggestions.length} steps, connected`}
            <ArrowRight size={14} aria-hidden />
          </button>
        </section>
      ) : null}
    </div>
  );
};

export default PlaybookSuggestPopover;
