import React, { useState } from 'react';
import { useLatestFoundationSkillRelease, useFoundationSkillRepoStatus } from '../hooks/useFoundationSkillUpdateStatus';
import {
  getVisibleSkillsForProject,
  withAlwaysInstallSkills,
} from '../../shared/types/foundationSkills';
import { BrandLogo } from './BrandLogo';
import styles from './FoundationSkillUpdateBanner.module.css';

interface FoundationSkillUpdateBannerProps {
  project: string | null | undefined;
  repo: string | null | undefined;
  provider?: 'ado' | 'github';
  branch?: string;
  'data-testid'?: string;
}

interface StepCmd {
  /** Shell label shown above the copyable command (e.g. PowerShell, Git Bash). */
  shell: string;
  cmd: string;
}

interface Step {
  /** Primary command — used when `cmds` is omitted. */
  cmd: string;
  label: string;
  /** Optional side-by-side shell variants (PowerShell + Git Bash). */
  cmds?: StepCmd[];
}

interface TroubleshootRow {
  symptom: string;
  fix: string;
  cmd?: string;
}

/** Fallback when a release has no artifactFeed stored. */
const DEFAULT_APEX_NPM_REGISTRY =
  'https://pkgs.dev.azure.com/amergis/_packaging/apex-skills/npm/registry/';

function apexRegistryLine(artifactFeed: string | null | undefined): string {
  const raw = (artifactFeed?.trim() || DEFAULT_APEX_NPM_REGISTRY).replace(/\/?$/, '/');
  return `@apex:registry=${raw}`;
}

/**
 * Origin of the APEX site the user is viewing (prod, QA, or local).
 * Never hardcode a host — the banner must work the same in every environment.
 */
function apexUrl(): string {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/**
 * The CLI verifies your project is entitled to these skills before installing,
 * so it needs to know where APEX lives. Show PowerShell and Git Bash side by
 * side so Windows teams can copy the form that matches their terminal.
 */
function apexUrlStep(): Step {
  const origin = apexUrl();
  const placeholder = '<this-apex-site-origin>';
  const host = origin || placeholder;
  const psCmd = `$env:APEX_URL="${host}"`;
  const bashCmd = `export APEX_URL="${host}"`;
  return {
    cmd: psCmd,
    cmds: [
      { shell: 'PowerShell', cmd: psCmd },
      { shell: 'Git Bash', cmd: bashCmd },
    ],
    label:
      'Point the CLI at this APEX site (the page you are on now) so it can confirm ' +
      'your project is entitled to these skills. Copy the command for your shell.',
  };
}

/**
 * Pin the package to the version this release shipped.
 *
 * Azure Artifacts does not support npm dist-tags — `latest` is not maintained
 * per view, so a bare `npx @apex/skills` can resolve a version this project was
 * never granted, which the CLI then refuses. Naming the version here means the
 * command APEX hands out always agrees with the version the CLI enforces.
 *
 * Falls back to the unpinned form for releases created before artifactVersion
 * was recorded.
 */
function cliRef(artifactVersion: string | null | undefined): string {
  return artifactVersion ? `@apex/skills@${artifactVersion}` : '@apex/skills';
}

function buildInstallSteps(skillList: string[], artifactVersion: string | null | undefined): Step[] {
  const skillArgs = skillList.length > 0 ? ' ' + skillList.join(' ') : ' --all';
  const cli = cliRef(artifactVersion);
  return [
    apexUrlStep(),
    { cmd: `npx ${cli} doctor`, label: 'Check Node, Git, registry, feed auth, and APEX entitlement' },
    {
      cmd: `npx ${cli} install${skillArgs}`,
      label: skillList.length > 0
        ? `Vendor foundations + scaffold adapters for ${skillList.length} skill${skillList.length === 1 ? '' : 's'}: ${skillList.join(', ')}`
        : 'Vendor all foundation skill files and scaffold adapters',
    },
    {
      cmd: `npx ${cli} bootstrap${skillArgs}`,
      label: 'Fill any unfilled project slot anchors from repo evidence. Existing project prose and filled slots are preserved.',
    },
    {
      cmd: '/post-skill-bootstrap',
      label:
        'In Cursor (not a terminal): run this slash skill. It scans lockfile-installed skills for unfilled markers, asks about gaps, and replaces those markers with confirmed values (re-run skips when none remain).',
    },
  ];
}

function buildUpdateSteps(skillList: string[], artifactVersion: string | null | undefined): Step[] {
  const skillArgs = skillList.length > 0 ? ' ' + skillList.join(' ') : '';
  const cli = cliRef(artifactVersion);
  return [
    {
      cmd: `npx ${cli} update${skillArgs}`,
      label: 'Pull latest managed skill content (project notes below the fence are preserved)',
    },
    {
      cmd: `npx ${cli} bootstrap${skillArgs || ' --all'}`,
      label: 'Fill newly introduced or still-unfilled project slot anchors, then review and commit',
    },
    {
      cmd: '/post-skill-bootstrap',
      label:
        'In Cursor: address any new unfilled markers after the update (filled slots are kept; skip if none remain).',
    },
  ];
}

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
    fix: 'Use Feed setup and paste the @apex:registry line into .npmrc before any npx @apex/skills command.',
    cmd: 'npm view @apex/skills version',
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
    symptom: 'apex-authorization FAIL — APEX_URL is not set',
    fix: 'Set APEX_URL to the origin of the APEX site you are viewing (step 1 of Install — it is not a fixed environment URL), then re-run doctor.',
    cmd: 'npx @apex/skills doctor',
  },
  {
    symptom: 'apex-authorization FAIL — no published release targets your project',
    fix: 'Your repo is registered but no release ships to it yet. Ask an APEX admin to publish a release targeting your project under Platform Admin → Foundation Skills → Releases.',
  },
  {
    symptom: 'apex-authorization FAIL — repo is not registered',
    fix: 'The repo\'s git origin does not match any project in APEX. Ask an APEX admin to register it under Project Admin → Project Settings.',
    cmd: 'git remote -v',
  },
  {
    symptom: 'apex-authorization FAIL — could not reach APEX',
    fix: 'Check APEX_URL is correct and reachable (VPN?). A previously recorded .apex/config.json is deliberately not accepted as a substitute, so that revoked access takes effect. For genuinely air-gapped use, pass --skip-apex-check.',
  },
  {
    symptom: 'apex-authorization FAIL — APEX is reachable but could not answer',
    fix: 'APEX is up but its authorization lookup timed out. Nothing on your machine is wrong, so do not change APEX_URL or your network. Wait a moment and re-run the same command; report it to the APEX team if it keeps happening.',
  },
  {
    symptom: 'install refuses with "Version mismatch"',
    fix: 'Your release pins a specific @apex/skills version. Copy the commands from the Install tab — they already name that version. Typing the command unpinned can pull a different version, because the feed does not maintain an npm "latest" tag.',
  },
  {
    symptom: 'install refuses a skill as "not released to your project"',
    fix: 'Install only the skills your release ships. Use the Install command above — it already lists exactly those, and --all resolves to them.',
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
            {s.cmds && s.cmds.length > 0 ? (
              <div className={styles.cmdVariants}>
                {s.cmds.map((variant, vi) => (
                  <div key={variant.shell} className={styles.cmdVariant}>
                    <span className={styles.shellLabel}>{variant.shell}</span>
                    <button
                      className={styles.codeBtn}
                      title={`Copy ${variant.shell} command`}
                      onClick={() => onCopy(variant.cmd)}
                      type="button"
                      {...{ 'data-testid': `${idPrefix}-copy-cmd-btn-${i}-${vi}` }}
                    >
                      <code>{variant.cmd}</code>
                      <span className={styles.copyHint}>Copy</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
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
            )}
            <span className={styles.stepDesc}>{s.label}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function FeedDirectSetup({
  registryLine,
  onCopy,
}: {
  registryLine: string;
  onCopy: (text: string) => void;
}) {
  return (
    <div className={styles.stepsList}>
      <p className={styles.noNotes}>
        Paste the registry line by hand first — do not start with <code>npx @apex/skills</code> until
        this works (that package is not on public npm).
      </p>

      <div className={styles.stepRow}>
        <span className={styles.stepNum}>1</span>
        <span className={styles.stepBody}>
          <span className={styles.stepDesc}>
            In your <strong>repo root</strong> (same folder as the project <code>.git</code>), open
            {' '}<code>.npmrc</code>. Create the file if it does not exist. Keep any existing scopes
            (for example <code>@maxview:registry=…</code>). Do not commit auth tokens —
            {' '}<code>.npmrc</code> is often gitignored.
          </span>
        </span>
      </div>

      <div className={styles.stepRow}>
        <span className={styles.stepNum}>2</span>
        <span className={styles.stepBody}>
          <span className={styles.stepDesc}>
            Add this <strong>exact</strong> line (new line at the end of the file is fine):
          </span>
          <button
            className={styles.codeBtn}
            title="Copy registry line"
            onClick={() => onCopy(registryLine)}
            type="button"
            {...{ 'data-testid': 'foundation-skills-banner-feed-direct-copy-registry-btn' }}
          >
            <code>{registryLine}</code>
            <span className={styles.copyHint}>Copy</span>
          </button>
          <span className={styles.stepDesc}>
            Optional: if the file does not already have it, also add{' '}
            <button
              className={styles.inlineCodeBtn}
              type="button"
              title="Copy always-auth line"
              onClick={() => onCopy('always-auth=true')}
              {...{ 'data-testid': 'foundation-skills-banner-feed-direct-copy-always-auth-btn' }}
            >
              <code>always-auth=true</code>
            </button>
            .
          </span>
        </span>
      </div>

      <div className={styles.stepRow}>
        <span className={styles.stepNum}>3</span>
        <span className={styles.stepBody}>
          <button
            className={styles.codeBtn}
            title="Copy command"
            onClick={() => onCopy('npx vsts-npm-auth -config .npmrc')}
            type="button"
            {...{ 'data-testid': 'foundation-skills-banner-feed-direct-copy-cmd-btn-0' }}
          >
            <code>npx vsts-npm-auth -config .npmrc</code>
            <span className={styles.copyHint}>Copy</span>
          </button>
          <span className={styles.stepDesc}>
            Sign in to Azure Artifacts from the repo root. Tokens stay on your machine — never commit them.
          </span>
        </span>
      </div>

      <div className={styles.stepRow}>
        <span className={styles.stepNum}>4</span>
        <span className={styles.stepBody}>
          <button
            className={styles.codeBtn}
            title="Copy command"
            onClick={() => onCopy('npm view @apex/skills version')}
            type="button"
            {...{ 'data-testid': 'foundation-skills-banner-feed-direct-copy-cmd-btn-1' }}
          >
            <code>npm view @apex/skills version</code>
            <span className={styles.copyHint}>Copy</span>
          </button>
          <span className={styles.stepDesc}>
            Expect a version like <code>1.0.0</code>. If you still see registry.npmjs.org 404, the
            {' '}<code>@apex:registry</code> line is missing or in the wrong folder.
          </span>
        </span>
      </div>
    </div>
  );
}

export const FoundationSkillUpdateBanner: React.FC<FoundationSkillUpdateBannerProps> = ({
  project,
  repo,
  provider = 'ado',
  branch = 'main',
  'data-testid': dataTestId = 'foundation-skills-update-banner',
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
  const registryLine = apexRegistryLine(latest.artifactFeed);
  const releaseSkills = getVisibleSkillsForProject(latest, project ?? null);
  // Companion skills only accompany a real release skill set — never alone.
  const scopedSkills = releaseSkills.length > 0
    ? withAlwaysInstallSkills(releaseSkills)
    : [];
  const installSteps = buildInstallSteps(scopedSkills, latest.artifactVersion);

  function copy(text: string) {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  return (
    <div
      className={`${styles.strip} ${hasBreaking ? styles.stripWarning : ''}`}
      role="note"
      aria-label="Foundation skills update available"
      {...{ 'data-testid': dataTestId }}
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
                  <FeedDirectSetup registryLine={registryLine} onCopy={copy} />
                ) : firstTimeTab === 'install' ? (
                  <>
                    {scopedSkills.length === 0 ? (
                      <p className={styles.noNotes}>
                        <strong>No skills are configured for this project.</strong>{' '}
                        A Platform Admin must publish a release with <code>selectedSkills</code> targeting
                        this project before you can install. Contact your APEX admin.
                      </p>
                    ) : (
                      <>
                        <StepList
                          steps={installSteps}
                          idPrefix="foundation-skills-banner-install"
                          onCopy={copy}
                        />
                        <p className={styles.noNotes}>
                          Only do this after Feed setup shows a version from <code>npm view @apex/skills version</code>.
                          Install vendors foundations and scaffolds project content once; bootstrap only fills unfilled anchored slots;
                          then run <code>/post-skill-bootstrap</code> in Cursor to clear remaining gaps.
                          <code>post-skill-bootstrap</code> is always included with the install.
                        </p>
                      </>
                    )}
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
                  steps={buildUpdateSteps(scopedSkills, latest.artifactVersion)}
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
