import React from 'react';
import type { IncidentBadgeTone } from '../utils/incidentTriageDisplay';
import styles from './IncidentTriagePage.module.css';

const TONE_CLASS: Record<IncidentBadgeTone, string> = {
  neutral: styles.chip,
  danger: styles.chipDanger,
  ok: styles.chipOk,
};

interface IncidentTriageBadgeProps {
  label: string;
  tone?: IncidentBadgeTone;
  'data-testid'?: string;
}

export const IncidentTriageBadge: React.FC<IncidentTriageBadgeProps> = ({ label, tone = 'neutral', 'data-testid': dataTestId }) => (
  <span className={TONE_CLASS[tone]} {...(dataTestId ? { 'data-testid': dataTestId } : {})}>{label}</span>
);
