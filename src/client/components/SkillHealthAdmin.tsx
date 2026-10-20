import React, { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import grid from './DataGrid.module.css';
import styles from './SkillHealthAdmin.module.css';
import { DataGridFilterPills } from './DataGridToolbar';
import { SkillHealthWorkItemModal, destinationLabel } from './SkillHealthWorkItemModal';
import {
  PROPOSED_CHANGE_PROMPT,
  SkillFeedbackSummary,
  SkillHealthEvaluationPanel,
  skillNameOf,
  type SkillHealthWorkItemDraft,
} from './SkillHealthEvaluationPanel';
import { useSkillHealth } from '../hooks/useSkillHealth';
import {
  SKILL_HEALTH_PERIOD_OPTIONS,
  defaultWorkItemDestination,
  type SkillHealthArtifactKind,
  type SkillHealthEvaluationSkill,
  type SkillHealthPeriodDays,
  type SkillHealthProject,
  type SkillHealthRecurringGap,
  type SkillHealthSkill,
  type SkillHealthStatus,
} from '../../shared/types/skillHealth';

const SECTION_LABELS: Record<string, string> = {
  prd: 'PRD body',
  backlog: 'Backlog',
  design: 'Design',
  tech_spec: 'Tech spec',
  assumptions: 'Assumptions',
};

function statusLabel(status: SkillHealthStatus): string {
  switch (status) {
    case 'good':
      return 'Good';
    case 'fair':
      return 'Fair';
    case 'poor':
      return 'Poor';
    case 'insufficient_data':
      return 'Not enough data';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function kindLabel(kind: SkillHealthArtifactKind): string {
  switch (kind) {
    case 'prd':
      return 'PRD';
    case 'design_doc':
      return 'Design doc';
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function number(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits);
}

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

function skillName(skill: SkillHealthSkill): string {
  return skillNameOf(skill.skillPath);
}

/** The project's human feedback for a PRD Skill; design doc Skills have no feedback stage yet. */
function feedbackFor(project: SkillHealthProject, skill: SkillHealthSkill): SkillHealthEvaluationSkill | null {
  if (!project.evaluation || skill.artifactKind !== 'prd') return null;
  const path = (skill.skillPath ?? '').toLowerCase();
  return (
    project.evaluation.skills.find((s) => s.subjectType === 'prd' && (s.skillPath ?? '').toLowerCase() === path) ??
    null
  );
}

function draftForSkill(skill: SkillHealthSkill, periodDays: number): SkillHealthWorkItemDraft {
  return {
    skill,
    title: `Skill Health: improve ${skillName(skill)} in ${skill.project}`,
    description: [
      `${skill.project} · ${skill.skillPath ?? 'app default Skill'} (${kindLabel(skill.artifactKind)}), last ${periodDays} days: ` +
        `${skill.documents} documents, ${skill.scoredDocuments} scored, average ${number(skill.averageScore)}, ` +
        `pass rate ${percent(skill.passRate)}, ${skill.overrides} gate overrides, ${skill.reviewComments} review comments.`,
      PROPOSED_CHANGE_PROMPT,
    ].join('\n\n'),
  };
}

function draftForGap(skill: SkillHealthSkill, gap: SkillHealthRecurringGap, periodDays: number): SkillHealthWorkItemDraft {
  const examples = gap.sampleDescriptions.map((description) => `- ${description}`).join('\n');
  return {
    skill,
    title: `Skill Health: ${skillName(skill)} — ${gap.section} (${skill.project})`,
    description: [
      `${gap.documentCount} of ${skill.documents} ${kindLabel(skill.artifactKind)} documents in ${skill.project} ` +
        `had an open "${gap.section}" validation gap in the last ${periodDays} days (${gap.occurrences} occurrences).`,
      ...(examples ? [`Examples from the validator:\n${examples}`] : []),
      PROPOSED_CHANGE_PROMPT,
    ].join('\n\n'),
  };
}

interface SkillDetailProps {
  skill: SkillHealthSkill;
  /** True for PRD Skills in projects with human feedback turned on. */
  showFeedback: boolean;
  feedback: SkillHealthEvaluationSkill | null;
  onCreateWorkItem: (gap: SkillHealthRecurringGap | null) => void;
}

const SkillDetail: React.FC<SkillDetailProps> = ({ skill, showFeedback, feedback, onCreateWorkItem }) => {
  const maxComments = useMemo(() => Math.max(1, ...skill.sections.map((c) => c.commentCount)), [skill.sections]);

  return (
    <div className={styles.detail} data-testid="skill-health-detail">
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h4 className={styles.cardTitle}>Summary</h4>
          <button
            type="button"
            className={grid.buttonGhost}
            onClick={() => onCreateWorkItem(null)}
            data-testid="skill-health-create-work-item"
          >
            Create work item
          </button>
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Documents</span>
            <span className={styles.statValue}>{skill.documents}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Scored</span>
            <span className={styles.statValue}>{skill.scoredDocuments}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Sent back</span>
            <span className={styles.statValue}>{skill.revisionRequested}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Gate overridden</span>
            <span className={styles.statValue}>{skill.overrides}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Generation failures</span>
            <span className={styles.statValue}>{skill.generationFailures}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>Total cost</span>
            <span className={styles.statValue}>{money(skill.costUsd)}</span>
          </div>
        </div>
        <p className={grid.hint}>
          Linked by the document&rsquo;s own settings: {skill.attribution['document-settings']} · by project
          default: {skill.attribution['project-default']} · not linked: {skill.attribution.unattributed}
        </p>
      </section>

      {showFeedback && <SkillFeedbackSummary feedback={feedback} />}

      <section className={styles.card}>
        <h4 className={styles.cardTitle}>SKILL.md versions</h4>
        <table className={styles.versionTable} data-testid="skill-health-versions">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Used</th>
              <th scope="col">Docs</th>
              <th scope="col">Avg score</th>
              <th scope="col">Pass rate</th>
              <th scope="col">Accepted</th>
              {showFeedback && <th scope="col">Feedback</th>}
              {showFeedback && <th scope="col">Human avg</th>}
            </tr>
          </thead>
          <tbody>
            {skill.versions.map((version) => (
              <tr
                key={version.skillSha256 ?? 'unversioned'}
                data-testid={`skill-health-version-${version.skillSha256?.slice(0, 8) ?? 'unversioned'}`}
              >
                <td>
                  {version.skillSha256 ? (
                    <span className={styles.skillPath} title={version.skillSha256}>
                      {version.skillSha256.slice(0, 8)}
                    </span>
                  ) : (
                    <span className={styles.muted}>Unversioned</span>
                  )}
                </td>
                <td>
                  {version.firstSeen.slice(0, 10)} – {version.lastSeen.slice(0, 10)}
                </td>
                <td>{version.documents}</td>
                <td>{number(version.averageScore)}</td>
                <td>{percent(version.passRate)}</td>
                <td>{percent(version.acceptanceRate)}</td>
                {showFeedback && <td>{version.humanEvents}</td>}
                {showFeedback && <td>{number(version.humanAverageScore)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={styles.card}>
        <h4 className={styles.cardTitle}>Average score by week</h4>
        {skill.trend.length === 0 ? (
          <p className={styles.muted}>No documents in this period.</p>
        ) : (
          <div className={styles.chart}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={skill.trend} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                <XAxis dataKey="weekStart" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                {/* data-testid-exempt — Recharts hover chrome; no host DOM we own */}
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="averageScore"
                  name="Average score"
                  stroke="var(--accent-color)"
                  strokeWidth={2}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className={styles.card}>
        <h4 className={styles.cardTitle}>Review comments by section</h4>
        {skill.sections.length === 0 ? (
          <p className={styles.muted}>No review comments in this period.</p>
        ) : (
          <table className={styles.heatmap} data-testid="skill-health-heatmap">
            <thead>
              <tr>
                {skill.sections.map((cell) => (
                  <th key={cell.sectionKey}>{SECTION_LABELS[cell.sectionKey] ?? cell.sectionKey}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {skill.sections.map((cell) => (
                  <td key={cell.sectionKey} className={styles.heatCell}>
                    <span className={styles.heatFill} style={{ opacity: (cell.commentCount / maxComments) * 0.45 }} />
                    <span className={styles.heatValue}>{cell.commentCount}</span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.card}>
        <h4 className={styles.cardTitle}>Recurring validation gaps</h4>
        {skill.recurringGaps.length === 0 ? (
          <p className={styles.muted}>No open validation gaps in this period.</p>
        ) : (
          <ul className={styles.gapList} data-testid="skill-health-gaps">
            {skill.recurringGaps.map((gap) => (
              <li key={gap.section}>
                <div className={styles.gapHeader}>
                  <span>{gap.section}</span>
                  <span className={styles.gapActions}>
                    <span className={styles.gapMeta}>
                      {gap.documentCount} docs · {gap.occurrences} times
                    </span>
                    <button
                      type="button"
                      className={grid.buttonGhost}
                      onClick={() => onCreateWorkItem(gap)}
                      data-testid={`skill-health-gap-work-item-${gap.section}`}
                    >
                      Create work item
                    </button>
                  </span>
                </div>
                {gap.sampleDescriptions.length > 0 && (
                  <ul className={styles.gapSamples}>
                    {gap.sampleDescriptions.map((description) => (
                      <li key={description}>{description}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export const SkillHealthAdmin: React.FC = () => {
  const [days, setDays] = useState<SkillHealthPeriodDays>(SKILL_HEALTH_PERIOD_OPTIONS[0]);
  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [workItemDraft, setWorkItemDraft] = useState<SkillHealthWorkItemDraft | null>(null);
  const { data, isLoading, error } = useSkillHealth(days);

  const project = useMemo(() => {
    if (!data || data.projects.length === 0) return null;
    return data.projects.find((p) => p.project === selectedProjectName) ?? data.projects[0];
  }, [data, selectedProjectName]);

  const projectOptions = useMemo(
    () =>
      (data?.projects ?? []).map((p) => ({
        value: p.project,
        label: p.isFoundation ? `${p.project} (foundation)` : p.project,
      })),
    [data],
  );

  const selected = useMemo(() => {
    if (!project || project.skills.length === 0) return null;
    return project.skills.find((s) => s.key === selectedKey) ?? project.skills[0];
  }, [project, selectedKey]);

  return (
    <div className={grid.section} data-testid="skill-health-admin">
      <div className={grid.header}>
        <div>
          <h3 className={grid.title}>Skill Health</h3>
          <p className={grid.hint}>
            How well each Skill performs, from validation scores, review comments, approvals, cost and human
            feedback with its Promptfoo and judge diagnostics.
          </p>
        </div>
        <div className={grid.headerActions}>
          <label htmlFor="skill-health-period" className={grid.hint}>
            Period
          </label>
          <select
            id="skill-health-period"
            className={styles.periodSelect}
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as SkillHealthPeriodDays)}
            data-testid="skill-health-period"
          >
            {SKILL_HEALTH_PERIOD_OPTIONS.map((option) => (
              <option key={option} value={option}>
                Last {option} days
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && <div className={grid.loading}>Loading Skill Health…</div>}
      {error && <div className={grid.error}>{error instanceof Error ? error.message : 'Failed to load'}</div>}

      {data && !project && (
        <div className={grid.empty}>
          No PRDs, design docs or human feedback in the last {data.periodDays} days.
        </div>
      )}

      {data && project && (
        <>
          <DataGridFilterPills
            options={projectOptions}
            value={project.project}
            onChange={(value) => {
              setSelectedProjectName(value);
              setSelectedKey(null);
            }}
            testIdPrefix="skill-health-project"
            aria-label="Project"
            data-testid="skill-health-projects"
          />
          <p className={grid.hint} data-testid="skill-health-project-summary">
            Skill repo: {project.skillRepo ?? 'none configured'} · Work items go to{' '}
            {destinationLabel(defaultWorkItemDestination(project.project), project.project)}.
          </p>

          {project.skills.length === 0 ? (
            <p className={styles.muted} data-testid="skill-health-no-documents">
              No PRDs or design docs in {project.project} in this period.
            </p>
          ) : (
            <div className={grid.tableWrap}>
              <table className={grid.table} data-testid="skill-health-table">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Output</th>
                    <th>Health</th>
                    <th>Docs</th>
                    <th>Avg score</th>
                    <th>Pass rate</th>
                    <th>Accepted</th>
                    <th>Comments / doc</th>
                    <th>Cost / doc</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {project.skills.map((skill) => (
                    <tr key={skill.key} className={skill.key === selected?.key ? styles.selectedRow : undefined}>
                      <td>
                        {skill.skillPath ? (
                          <span className={styles.skillPath}>{skill.skillPath}</span>
                        ) : (
                          <span className={styles.muted}>App default</span>
                        )}
                      </td>
                      <td>{kindLabel(skill.artifactKind)}</td>
                      <td>
                        <span className={`${styles.status} ${styles[`status-${skill.status}`]}`}>
                          {statusLabel(skill.status)}
                        </span>
                      </td>
                      <td>{skill.documents}</td>
                      <td>{number(skill.averageScore)}</td>
                      <td>{percent(skill.passRate)}</td>
                      <td>{percent(skill.acceptanceRate)}</td>
                      <td>{number(skill.commentsPerDocument)}</td>
                      <td>{money(skill.costPerDocument)}</td>
                      <td>
                        <div className={grid.rowActions}>
                          <button
                            type="button"
                            className={grid.buttonGhost}
                            onClick={() => setSelectedKey(skill.key)}
                            data-testid={`skill-health-view-${skill.key}`}
                          >
                            View
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selected && (
            <SkillDetail
              skill={selected}
              showFeedback={project.evaluation !== null && selected.artifactKind === 'prd'}
              feedback={feedbackFor(project, selected)}
              onCreateWorkItem={(gap) =>
                setWorkItemDraft(
                  gap ? draftForGap(selected, gap, data.periodDays) : draftForSkill(selected, data.periodDays),
                )
              }
            />
          )}

          {/* data-testid-exempt — the panel root carries skill-health-evaluation(-off) */}
          <SkillHealthEvaluationPanel
            project={project.project}
            evaluation={project.evaluation}
            onCreateWorkItem={setWorkItemDraft}
          />

          <ul className={styles.caveats} data-testid="skill-health-caveats">
            {data.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </>
      )}

      {workItemDraft && (
        // data-testid-exempt — the modal root carries skill-health-work-item-modal
        <SkillHealthWorkItemModal
          skill={workItemDraft.skill}
          initialTitle={workItemDraft.title}
          initialDescription={workItemDraft.description}
          onClose={() => setWorkItemDraft(null)}
        />
      )}
    </div>
  );
};
