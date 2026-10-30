import React from 'react';
import type { BrainstormActionId } from '../../shared/types/brainstormArtifact';
import { useBrainstormActions } from '../hooks/useBrainstormActions';
import styles from './BrainstormNextActionsPanel.module.css';

interface BrainstormSuggestionChipsProps {
  project: string;
  sessionId: string;
  onSelect: (actionId: BrainstormActionId) => void;
}

/** Shortcuts to the available next actions, read from the same query as the Next actions panel. */
export const BrainstormSuggestionChips: React.FC<BrainstormSuggestionChipsProps> = ({ project, sessionId, onSelect }) => {
  const actions = useBrainstormActions(project, sessionId);
  const available = (actions.data?.actions ?? []).filter((action) => action.state === 'available');
  if (!actions.data?.viewerCanAct || available.length === 0) return null;

  return (
    <div className={styles.chips} role="group" aria-label="Suggested next actions">
      {available.map((action) => (
        <button
          key={action.id}
          type="button"
          className={styles.chip}
          onClick={() => onSelect(action.id)}
          {...{ 'data-testid': `brainstorm-suggestion-chip-${action.id}` }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
};
