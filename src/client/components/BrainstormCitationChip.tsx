import React, { useId, useState } from 'react';
import type { BrainstormCitationDto } from '../../shared/types/brainstormSources';
import styles from './BrainstormSourcesPanel.module.css';

function chipLabel(citation: BrainstormCitationDto): string {
  if (citation.sourceKind === 'mcp-server') {
    return `${citation.mcpServerName ?? citation.sourceName} · ${citation.mcpToolId ?? 'tool'}`;
  }
  const revision = citation.revision ? citation.revision.slice(0, 7) : 'unpinned';
  return `${citation.sourceName} · ${citation.path ?? 'file'} · ${revision}`;
}

export const BrainstormCitationChip: React.FC<{ citation: BrainstormCitationDto }> = ({ citation }) => {
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  return (
    <span>
      <button
        type="button"
        className={styles.chip}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((value) => !value)}
        {...{ 'data-testid': `brainstorm-citation-chip-${citation.id}` }}
      >
        {chipLabel(citation)}
      </button>
      {open && (
        <div id={popoverId} role="dialog" className={styles.popover} {...{ 'data-testid': 'brainstorm-citation-popover' }}>
          <p>{citation.claim}</p>
          {citation.path && <p>{citation.path}</p>}
          {citation.revision && <p title={citation.revision}>{citation.revision}</p>}
          {citation.mcpServerName && <p>{citation.mcpServerName}</p>}
          {citation.mcpToolId && <p>{citation.mcpToolId}</p>}
        </div>
      )}
    </span>
  );
};
