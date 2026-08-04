import React, { useState } from 'react';
import { useLatestFoundationSkillRelease, useFoundationSkillRepoStatus } from '../hooks/useFoundationSkillUpdateStatus';
import { BrandLogo } from './BrandLogo';
import styles from './FoundationSkillUpdateBanner.module.css';

interface FoundationSkillUpdateBannerProps {
  project: string | null | undefined;
  repo: string | null | undefined;
  provider?: 'ado' | 'github';
  branch?: string;
}

interface Step {
  cmd: string;
  label: string;
}

interface TroubleshootRow {
  symptom: string;
  fix: string;
  cmd?: string;
}

/** One-time feed wiring — must succeed before any `npx @apex/skills` command. */
const FIRST_TIME_FEED_STEPS: Step[] = [
  {
    cmd: 'npx @apex/skills init-registry',
    label:
      'Add @apex:registry to your local .npmrc (keeps existing scopes like @maxview). If this 404s on public npm, paste the @apex:registry line into .npmrc first, then re-run.',
  },
  {
    cmd: 'npx vsts-npm-auth -config .npmrc',
    label: 'Sign in to Azure Artifacts (token stays on your machine — never commit it)',
  },
  {
    cmd: 'npm view @apex/skills version',
    label: 'Confirm the private feed resolves (expect a version like 1.0.0, not a 404)',
  },
];

const FIRST_TIME_INSTALL_STEPS: Step[] = [
  { cmd: 'npx @apex/skills doctor', label: 'Check Node, Git, registry, and feed auth' },
  { cmd: 'npx @apex/skills install', label: 'Install foundation skill files into the repo' },
  {
    cmd: 'npx @apex/skills bootstrap',
    label: 'Fill adapters from your repo (ADO org, teams, structure), then review and commit',
  },
];

const UPDATE_STEPS: Step[] = [
  { cmd: 'npx @apex/skills update', label: 'Pull latest foundation files (adapters are never overwritten)' },
  { cmd: 'npx @apex/skills bootstrap', label: 'Refresh adapters with updated repo knowledge, then review and commit' },
];

/** Cheat sheet — doctor prints the live fix under each FAIL; this is the short map. */
const TROUBLESHOOT_ROWS: TroubleshootRow[] = [
  {
    symptom: 'Node missing or older than 18',
    fix: 'Install Node.js 18+ LTS (nodejs.org, winget install OpenJS.NodeJS.LTS, or nvm). npm/npx ship with Node.',
    cmd: 'node -v',
  },
  {
    symptom: 'npm / npx not found',
    fix: 'Reinstall Node LTS and ensure it is on PATH. App tooling may use pnpm, but this CLI still needs npm.',
    cmd: 'npm -v',
  },
  {
    symptom: 'npx @apex/skills → 404 on registry.npmjs.org',
    fix: 'Feed setup is incomplete. Add @apex:registry (init-registry or .npmrc.template), then auth.',
    cmd: 'npx @apex/skills init-registry',
  },
  {
    symptom: 'npm view @apex/skills fails / 401',
    fix: 'Authenticate to Azure Artifacts, then re-check the version.',
    cmd: 'npx vsts-npm-auth -config .npmrc',
  },
  {
    symptom: 'Git missing (WARN)',
    fix: 'Optional for install; required for update/PR flow. Install Git and re-run doctor.',
    cmd: 'git --version',
  },
  {
    symptom: 'doctor FAIL — any other check',
    fix: 'Read the remediation printed under that FAIL line, fix it, then re-run doctor.',
    cmd: 'npx @apex/skills doctor',
  },
];

/** Named without a *Tab suffix — the data-testid checker treats `<Type>` generics as JSX. */
type FirstTimeSetupKey = 'feed' | 'install' | 'troubleshoot';

function StepList({
  steps,
  idPrefix,
  onCopy,
}: {
  steps: Step[];
  idPrefix: string;
  onCopy: (text: string) => void;
}) {
  return (
    <div className={styles.stepsList}>
      {steps.map((s, i) => (
        <div key={s.cmd} className={styles.stepRow}>
          <span className={styles.stepNum}>{i + 1}</span>
          <span className={styles.stepBody}>
            <button
              className={styles.codeBtn}
              title="Copy command"
              onClick={() => onCopy(s.cmd)}
              type="button"
              {...{ 'data-testid': `${idPrefix}-copy-cmd-btn-${i}` }}
            >
              <code>{s.cmd}</code>
              <span className={styles.copyHint}>Copy</span>
            </button>
            <span className={styles.stepDesc}>{s.label}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export const FoundationSkillUpdateBanner: React.FC<FoundationSkillUpdateBannerProps> = ({
  project,
  repo,
  provider = 'ado',
  branch = 'main',
}) => {
  const [dismissed, setDismissed] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [firstTimeTab, setFirstTimeTab] = useState<FirstTimeSetupKey>('feed');
  const { data: latest } = useLatestFoundationSkillRelease(project);
  const { data: repoStatus } = useFoundationSkillRepoStatus(provider, project, repo, branch);

  const availableVersion =
    repoStatus?.availableVersion ?? latest?.version ?? null;
  const installedVersion = repoStatus?.installedVersion ?? null;
  const isFirstInstall = !installedVersion;
  const updatePending =
    !!availableVersion && availableVersion !== installedVersion;

  const shouldShow =
    !dismissed &&
    !!latest &&
    !!project &&
    !!repo &&
    updatePending &&
    (isFirstInstall || !!repoStatus?.updateAvailable);

  if (!shouldShow || !latest) return null;

  const hasBreaking = !!latest.breakingChanges;
  const stepsLabel = isFirstInstall ? 'Getting started' : 'How to update';

  function copy(text: string) {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  return (
    <div
      className={`${styles.strip} ${hasBreaking ? styles.stripWarning : ''}`}
      role="note"
      aria-label="Foundation skills update available"
    >
      <div className={styles.mainRow}>
        <span className={styles.icon} aria-hidden="true">
          <BrandLogo variant="mark" className={styles.iconMark} />
        </span>

        <span className={styles.copy}>
          <span className={styles.title}>
            {isFirstInstall ? 'Foundation skills are available' : 'Foundation skills update available'}
            <span className={styles.badge}>{isFirstInstall ? 'New' : 'Update'}</span>
            {hasBreaking && <span className={styles.breakingFlag}>Breaking changes</span>}
          </span>
          <span className={styles.subtitle}>
            APEX foundation skills <span className={styles.version}>v{latest.version}</span>
            {isFirstInstall
              ? ' is ready to install in your repo.'
              : <> — you currently have <span className={styles.version}>v{installedVersion}</span>.</>}
          </span>
        </span>

        <span className={styles.toggleRow}>
          <button
            className={`${styles.notesToggle} ${stepsOpen ? styles.notesToggleActive : ''}`}
            type="button"
            onClick={() => setStepsOpen(v => !v)}
            aria-expanded={stepsOpen}
            {...{ 'data-testid': isFirstInstall ? 'foundation-skills-banner-getting-started-btn' : 'foundation-skills-banner-how-to-update-btn' }}
          >
            {stepsLabel}
            <span className={`${styles.caret} ${stepsOpen ? styles.caretOpen : ''}`} aria-hidden="true">▼</span>
          </button>

          <button
            className={`${styles.notesToggle} ${notesOpen ? styles.notesToggleActive : ''}`}
            type="button"
            onClick={() => setNotesOpen(v => !v)}
            aria-expanded={notesOpen}
            {...{ 'data-testid': 'foundation-skills-banner-release-notes-btn' }}
          >
            Release notes
            <span className={`${styles.caret} ${notesOpen ? styles.caretOpen : ''}`} aria-hidden="true">▼</span>
          </button>

          <button
            className={styles.dismiss}
            onClick={() => setDismissed(true)}
            type="button"
            aria-label="Dismiss skills update notice"
            {...{ 'data-testid': 'foundation-skills-banner-dismiss-btn' }}
          >
            ✕
          </button>
        </span>
      </div>

      {stepsOpen && (
        <div className={styles.notesPanel}>
          <div className={styles.notesSection}>
            {isFirstInstall ? (
              <>
                <span className={styles.notesSectionLabel}>
                  First-time setup — wire the private feed, then install skills. Use Troubleshooting if a command fails.
                </span>
                <div className={styles.toggleRow} role="tablist" aria-label="First-time setup steps">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={firstTimeTab === 'feed'}
                    className={`${styles.notesToggle} ${firstTimeTab === 'feed' ? styles.notesToggleActive : ''}`}
                    onClick={() => setFirstTimeTab('feed')}
                    {...{ 'data-testid': 'foundation-skills-banner-first-time-feed-tab' }}
                  >
                    1. Feed setup (once)
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={firstTimeTab === 'install'}
                    className={`${styles.notesToggle} ${firstTimeTab === 'install' ? styles.notesToggleActive : ''}`}
                    onClick={() => setFirstTimeTab('install')}
                    {...{ 'data-testid': 'foundation-skills-banner-first-time-install-tab' }}
                  >
                    2. Install skills
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={firstTimeTab === 'troubleshoot'}
                    className={`${styles.notesToggle} ${firstTimeTab === 'troubleshoot' ? styles.notesToggleActive : ''}`}
                    onClick={() => setFirstTimeTab('troubleshoot')}
                    {...{ 'data-testid': 'foundation-skills-banner-first-time-troubleshoot-tab' }}
                  >
                    Troubleshooting
                  </button>
                </div>
                {firstTimeTab === 'feed' ? (
                  <>
                    <StepList
                      steps={FIRST_TIME_FEED_STEPS}
                      idPrefix="foundation-skills-banner-feed"
                      onCopy={copy}
                    />
                    <p className={styles.noNotes}>
                      If <code>init-registry</code> 404s on registry.npmjs.org, your .npmrc is missing
                      {' '}@apex:registry. Add that line (or copy from .npmrc.template), then auth and
                      {' '}<code>npm view</code> before any other @apex/skills command.
                    </p>
                  </>
                ) : firstTimeTab === 'install' ? (
                  <>
                    <StepList
                      steps={FIRST_TIME_INSTALL_STEPS}
                      idPrefix="foundation-skills-banner-install"
                      onCopy={copy}
                    />
                    <p className={styles.noNotes}>
                      Only do this after Feed setup shows a version from <code>npm view @apex/skills version</code>.
                    </p>
                  </>
                ) : (
                  <>
                    <p className={styles.noNotes}>
                      Run <code>npx @apex/skills doctor</code> first — each FAIL prints what to do under that line.
                      This tab is a short cheat sheet (Node/npm required even if the repo uses pnpm).
                    </p>
                    <div className={styles.troubleshootList}>
                      {TROUBLESHOOT_ROWS.map((row, i) => (
                        <div key={row.symptom} className={styles.troubleshootRow}>
                          <span className={styles.troubleshootSymptom}>{row.symptom}</span>
                          <span className={styles.stepDesc}>{row.fix}</span>
                          {row.cmd && (
                            <button
                              className={styles.codeBtn}
                              title="Copy command"
                              onClick={() => copy(row.cmd!)}
                              type="button"
                              {...{ 'data-testid': `foundation-skills-banner-troubleshoot-copy-cmd-btn-${i}` }}
                            >
                              <code>{row.cmd}</code>
                              <span className={styles.copyHint}>Copy</span>
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <span className={styles.notesSectionLabel}>
                  Run these in your repo root
                </span>
                <StepList
                  steps={UPDATE_STEPS}
                  idPrefix="foundation-skills-banner-update"
                  onCopy={copy}
                />
              </>
            )}
          </div>
        </div>
      )}

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
