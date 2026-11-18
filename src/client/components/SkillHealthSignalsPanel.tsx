import React from 'react';
import grid from './DataGrid.module.css';
import styles from './SkillHealthAdmin.module.css';
import type {
  SkillHealthInterval,
  SkillHealthProjectSignals,
  SkillHealthSignalSurface,
} from '../../shared/types/skillHealth';

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

export function rateWithInterval(rate: number | null, interval: SkillHealthInterval | null): string {
  if (rate === null) return '—';
  if (!interval) return pct(rate);
  return `${pct(rate)} (${pct(interval.low)}–${pct(interval.high)})`;
}

function ratio(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

function rating(surface: SkillHealthSignalSurface): string {
  if (surface.ratingScore === null) return '—';
  const sign = surface.ratingScore > 0 ? '+' : '';
  return `${sign}${surface.ratingScore.toFixed(2)} (${surface.ratings})`;
}

/** Best version's lead over the next one, or null unless both have enough decisions to compare. */
export function versionComparison(surface: SkillHealthSignalSurface): string | null {
  const [first, second] = surface.versions;
  if (!first || !second || !first.sufficientSample || !second.sufficientSample) return null;
  if (first.acceptanceRate === null || second.acceptanceRate === null) return null;
  const overlap = first.acceptanceInterval && second.acceptanceInterval
    && first.acceptanceInterval.low <= second.acceptanceInterval.high
    && second.acceptanceInterval.low <= first.acceptanceInterval.high;
  const label = (sha: string | null) => (sha ? sha.slice(0, 8) : 'unversioned');
  const verdict = overlap ? 'not yet a clear difference' : 'a clear difference';
  return `${label(first.skillSha256)} ${pct(first.acceptanceRate)} vs ${label(second.skillSha256)} ${pct(second.acceptanceRate)} — ${verdict}`;
}

interface SkillHealthSignalsPanelProps {
  project: string;
  signals: SkillHealthProjectSignals | null;
}

/** What people did with AI output on every surface: accept, reject, regenerate, roll back, rate. */
export const SkillHealthSignalsPanel: React.FC<SkillHealthSignalsPanelProps> = ({ project, signals }) => {
  if (!signals) return null;
  return (
    <div className={styles.evaluation} data-testid="skill-health-signals">
      <h4 className={styles.sectionTitle}>
        Outcomes by surface{' '}
        <span className={styles.gapMeta} data-testid="skill-health-signals-coverage">
          {signals.coverage.active} of {signals.coverage.total} surfaces reporting
        </span>
      </h4>
      {signals.surfaces.length === 0 ? (
        <p className={styles.muted}>No accept, reject or rating signals in {project} in this period.</p>
      ) : (
        <section className={styles.card}>
          <table className={styles.versionTable} data-testid="skill-health-signals-table">
            <thead>
              <tr>
                <th scope="col">Surface</th>
                <th scope="col">Signals</th>
                <th scope="col">Accepted (95% range)</th>
                <th scope="col">Edited before accept</th>
                <th scope="col">Regenerations per accept</th>
                <th scope="col">Failure rate</th>
                <th scope="col">Rating</th>
                <th scope="col">Sampled judge (1–5)</th>
                <th scope="col">Skill versions</th>
              </tr>
            </thead>
            <tbody>
              {signals.surfaces.map((surface) => {
                const comparison = versionComparison(surface);
                return (
                  <tr key={surface.surface} data-testid={`skill-health-signals-row-${surface.surface}`}>
                    <td>{surface.label}</td>
                    <td>{surface.signals}</td>
                    <td>
                      {rateWithInterval(surface.acceptanceRate, surface.acceptanceInterval)}
                      {surface.decisions > 0 && !surface.sufficientSample && (
                        <span className={styles.gapMeta}> · small sample</span>
                      )}
                    </td>
                    <td>{pct(surface.editedBeforeAcceptRate)}</td>
                    <td>{ratio(surface.regenerationsPerAccepted)}</td>
                    <td>{pct(surface.failureRate)}</td>
                    <td>{rating(surface)}</td>
                    <td>{surface.judgedScore === null ? '—' : `${surface.judgedScore.toFixed(1)} (${surface.judged})`}</td>
                    <td>{comparison ?? <span className={grid.hint}>{surface.versions.length || '—'}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
};
