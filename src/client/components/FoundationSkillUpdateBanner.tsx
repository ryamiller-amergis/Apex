import React from 'react';
import { useLatestFoundationSkillRelease, useFoundationSkillRepoStatus } from '../hooks/useFoundationSkillUpdateStatus';
import styles from './FoundationSkillUpdateBanner.module.css';

interface FoundationSkillUpdateBannerProps {
  /** ADO project or GitHub org for the current project's skill repo */
  project: string | null | undefined;
  /** Skill repo name */
  repo: string | null | undefined;
  provider?: 'ado' | 'github';
  branch?: string;
}

/**
 * A compact, optional banner shown to authenticated team users when a newer
 * foundation skills release is available for their configured skill repo.
 *
 * Shows only when:
 *   - A published release exists
 *   - The repo status record exists and `updateAvailable` is true
 *   - The latest release version is newer than the installed version
 *
 * Never shows Platform Admin controls or applies updates automatically.
 */
export const FoundationSkillUpdateBanner: React.FC<FoundationSkillUpdateBannerProps> = ({
  project,
  repo,
  provider = 'ado',
  branch = 'main',
}) => {
  const { data: latest }     = useLatestFoundationSkillRelease();
  const { data: repoStatus } = useFoundationSkillRepoStatus(provider, project, repo, branch);

  // Only show when there is genuinely an update the team can act on
  const shouldShow =
    !!latest &&
    !!repoStatus &&
    repoStatus.updateAvailable &&
    !!repoStatus.availableVersion &&
    repoStatus.availableVersion !== repoStatus.installedVersion;

  if (!shouldShow || !latest) return null;

  const cliCmd = `npx @apex/skills update`;
  const slashCmd = `/apex-skills update`;

  return (
    <div className={styles.banner} role="note" aria-label="Foundation skills update available">
      <div className={styles.content}>
        <span className={styles.badge}>Skills update</span>
        <span className={styles.text}>
          APEX foundation skills&nbsp;
          <strong>v{latest.version}</strong> is available
          {repoStatus.installedVersion ? ` (installed: v${repoStatus.installedVersion})` : ''}.
          {latest.breakingChanges ? ' ⚠️ Breaking changes — review before updating.' : ''}
        </span>
        <div className={styles.actions}>
          <button
            className={styles.codeBtn}
            title="Copy CLI update command"
            onClick={() => navigator.clipboard?.writeText(cliCmd).catch(() => undefined)}
            type="button"
          >
            <code>{cliCmd}</code>
          </button>
          <span className={styles.or}>or</span>
          <button
            className={styles.codeBtn}
            title="Copy Cursor slash command"
            onClick={() => navigator.clipboard?.writeText(slashCmd).catch(() => undefined)}
            type="button"
          >
            <code>{slashCmd}</code>
          </button>
        </div>
      </div>
    </div>
  );
};
