import React from 'react';
import styles from './BuildBriefTakeoverNotice.module.css';

interface BuildBriefTakeoverNoticeProps {
  requesterName: string;
}

export const BuildBriefTakeoverNotice: React.FC<BuildBriefTakeoverNoticeProps> = ({ requesterName }) => (
  <div className={styles.notice} role="note" {...{ 'data-testid': 'build-brief-takeover-notice' }}>
    You are editing this brief for {requesterName}.
  </div>
);
