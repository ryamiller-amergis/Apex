import React, { useState } from 'react';
import { useLatestFoundationSkillRelease, useFoundationSkillRepoStatus } from '../hooks/useFoundationSkillUpdateStatus';
import styles from './FoundationSkillUpdateBanner.module.css';

interface FoundationSkillUpdateBannerProps {
  project: string | null | undefined;
  repo: string | null | undefined;
  provider?: 'ado' | 'github';
  branch?: string;
}

const FIRST_TIME_STEPS = [
  { cmd: 'npx @apex/skills doctor',    label: 'Check prerequisites (Node 18+, Cursor project, feed auth)' },
  { cmd: 'npx @apex/skills install',   label: 'Install all 30 foundation skill files into your repo' },
  { cmd: 'npx @apex/skills bootstrap', label: 'Teach skills your repo — scans codebase and fills adapter templates with your ADO org, team names, and project structure' },
];

const UPDATE_STEPS = [
  { cmd: 'npx @apex/skills update',    label: 'Pull latest foundation files (your adapters are never overwritten)' },
  { cmd: 'npx @apex/skills bootstrap', label: 'Refresh adapters with updated repo knowledge, then review and commit' },
];

export const FoundationSkillUpdateBanner: React.FC<FoundationSkillUpdateBannerProps> = ({
  project,
  repo,
  provider = 'ado',
  branch = 'main',
}) => {
  const [dismissed, setDismissed]   = useState(false);
  const [notesOpen, setNotesOpen]   = useState(false);
  const [stepsOpen, setStepsOpen]   = useState(false);
  const { data: latest }            = useLatestFoundationSkillRelease(project);
  const { data: repoStatus }        = useFoundationSkillRepoStatus(provider, project, repo, branch);

  const shouldShow =
    !dismissed &&
    !!latest &&
    !!repoStatus &&
    repoStatus.updateAvailable &&
    !!repoStatus.availableVersion &&
    repoStatus.availableVersion !== repoStatus.installedVersion;

  if (!shouldShow || !latest) return null;

  const isFirstInstall = !repoStatus.installedVersion;
  const hasBreaking    = !!latest.breakingChanges;
  const steps          = isFirstInstall ? FIRST_TIME_STEPS : UPDATE_STEPS;
  const stepsLabel     = isFirstInstall ? 'Getting started ▼' : 'How to update ▼';

  function copy(text: string) {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  return (
    <div
      className={`${styles.strip} ${hasBreaking ? styles.stripWarning : ''}`}
      role="note"
      aria-label="Foundation skills update available"
    >
      {/* ── Main row ── */}
      <div className={styles.mainRow}>
        <span className={styles.badge}>{isFirstInstall ? 'Skills available' : 'Skills update'}</span>

        <span className={styles.text}>
          APEX foundation skills <strong>v{latest.version}</strong>
          {isFirstInstall
            ? ' is available for your project.'
            : ` is available (installed: v${repoStatus.installedVersion}).`}
          {hasBreaking ? ' ⚠ Breaking changes — review before updating.' : ''}
        </span>

        <button
          className={styles.notesToggle}
          type="button"
          onClick={() => setStepsOpen(v => !v)}
          aria-expanded={stepsOpen}
        >
          {stepsOpen ? 'Hide ▲' : stepsLabel}
        </button>

        <button
          className={styles.notesToggle}
          type="button"
          onClick={() => setNotesOpen(v => !v)}
          aria-expanded={notesOpen}
        >
          {notesOpen ? 'Hide notes ▲' : 'Release notes ▼'}
        </button>

        <button
          className={styles.dismiss}
          onClick={() => setDismissed(true)}
          type="button"
          aria-label="Dismiss skills update notice"
        >
          ✕
        </button>
      </div>

      {/* ── Getting started / how-to-update steps ── */}
      {stepsOpen && (
        <div className={styles.notesPanel}>
          <div className={styles.notesSection}>
            <span className={styles.notesSectionLabel}>
              {isFirstInstall
                ? 'Run these 3 commands in your repo — forward to your developer:'
                : 'Run these commands in your repo — forward to your developer:'}
            </span>
            <div className={styles.stepsList}>
              {steps.map((s, i) => (
                <div key={s.cmd} className={styles.stepRow}>
                  <span className={styles.stepNum}>{i + 1}.</span>
                  <button
                    className={styles.codeBtn}
                    title="Copy command"
                    onClick={() => copy(s.cmd)}
                    type="button"
                  >
                    <code>{s.cmd}</code>
                  </button>
                  <span className={styles.stepDesc}>{s.label}</span>
                </div>
              ))}
            </div>
            {isFirstInstall && (
              <p className={styles.noNotes}>
                Skills are plain Markdown and work in any language repo. Only Node.js 18+ is required to run the installer.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Release notes panel ── */}
      {notesOpen && (
        <div className={styles.notesPanel}>
          {hasBreaking && (
            <div className={styles.notesSection}>
              <span className={styles.notesSectionLabel}>Breaking changes</span>
              <pre className={styles.notesPre}>{latest.breakingChanges}</pre>
            </div>
          )}
          {latest.releaseNotes ? (
            <div className={styles.notesSection}>
              <span className={styles.notesSectionLabel}>Release notes</span>
              <pre className={styles.notesPre}>{latest.releaseNotes}</pre>
            </div>
          ) : !hasBreaking ? (
            <p className={styles.noNotes}>No release notes provided for this version.</p>
          ) : null}
        </div>
      )}
    </div>
  );
};
