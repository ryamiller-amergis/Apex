import React from 'react';
import type { BrainstormCitationDto } from '../../shared/types/brainstormSources';
import { BrainstormCitationChip } from './BrainstormCitationChip';
import styles from './BrainstormSourcesPanel.module.css';

export const BrainstormCitationsRow: React.FC<{
  messageId: string;
  citations: BrainstormCitationDto[];
}> = ({ messageId, citations }) => {
  if (citations.length === 0) return null;
  return (
    <div className={styles.citations} {...{ 'data-testid': `brainstorm-citations-row-${messageId}` }}>
      {citations.map((citation) => (
        <React.Fragment key={citation.id}>
          {/* data-testid-exempt — BrainstormCitationChip owns brainstorm-citation-chip */}
          <BrainstormCitationChip citation={citation} />
        </React.Fragment>
      ))}
    </div>
  );
};
