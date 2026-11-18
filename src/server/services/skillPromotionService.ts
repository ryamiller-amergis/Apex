/**
 * Opens the pull request for an approved Skill change. It touches one file, the SKILL.md the
 * experiment replayed, and refuses if that file changed in the repo since the experiment started,
 * so a stale candidate never overwrites someone else's edit.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { SkillExperimentResult } from '../../shared/types/skillExperiment';
import { getSkillConfig } from './projectSettingsService';
import {
  checkoutDefaultBranch,
  checkoutNewBranch,
  cleanupWorkspace,
  pushBranch,
} from './repoCheckoutService';
import { resolveGitRemote } from './repoCacheService';
import { git, safeArgs } from '../utils/asyncGit';
import * as githubCatalog from './skillCatalogGitHub';
import { AzureDevOpsService } from './azureDevOps';

export type SkillPullRequestOutcome =
  | { ok: true; url: string; branchName: string }
  | { ok: false; error: string };

function sha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

function skillName(skillPath: string): string {
  const parts = skillPath.split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : 'skill';
}

function signed(value: number | null): string {
  if (value === null) return 'n/a';
  return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

export function buildPullRequestBody(input: {
  experimentId: string;
  skillPath: string;
  changeNotes: string | null;
  result: SkillExperimentResult | null;
}): string {
  const result = input.result;
  return [
    `Apex Skill Learning: a change to \`${input.skillPath}\` that scored better than the current Skill on replayed cases.`,
    '',
    '## What changed',
    input.changeNotes ?? '(no notes)',
    '',
    '## Evidence',
    result
      ? [
          `- Dev cases: ${result.dev.pairs} paired, mean change ${signed(result.dev.meanDiff)} on the 1–5 judge scale` +
            (result.dev.diffInterval ? ` (95% range ${signed(result.dev.diffInterval.low)} to ${signed(result.dev.diffInterval.high)})` : ''),
          `- Holdout cases (never shown to the change drafter): ${result.holdout.pairs} paired, mean change ${signed(result.holdout.meanDiff)}`,
          `- Wins / losses / ties on dev: ${result.dev.wins} / ${result.dev.losses} / ${result.dev.ties}`,
          ...result.reasons.map((reason) => `- ${reason}`),
        ].join('\n')
      : '(no result recorded)',
    '',
    `Each case was replayed with the same prompt, inputs, model and pinned commit; only SKILL.md differed. Experiment: ${input.experimentId}.`,
    'To roll back, revert this pull request.',
  ].join('\n');
}

export async function openSkillChangePullRequest(input: {
  project: string;
  experimentId: string;
  skillPath: string;
  baselineContent: string;
  candidateContent: string;
  changeNotes: string | null;
  result: SkillExperimentResult | null;
}): Promise<SkillPullRequestOutcome> {
  const config = await getSkillConfig(input.project);
  if (!config?.skillRepo) return { ok: false, error: 'The project has no Skill repository configured.' };
  const provider = config.skillProvider ?? 'ado';
  const baseBranch = config.skillBranch || 'main';
  const relativePath = input.skillPath.replace(/^\/+/, '');
  const branchName = `skill-learning/${skillName(relativePath)}-${input.experimentId.slice(0, 8)}-${randomBytes(2).toString('hex')}`;
  const sessionId = `skill-learning-${input.experimentId}`;

  try {
    const workspaceDir = await checkoutDefaultBranch({
      project: input.project,
      repo: config.skillRepo,
      branch: baseBranch,
      sessionId,
      provider,
    });
    const target = path.resolve(workspaceDir, relativePath);
    if (!target.startsWith(path.resolve(workspaceDir) + path.sep)) {
      return { ok: false, error: 'The Skill path points outside the repository.' };
    }
    const current = await fs.readFile(target, 'utf8').catch(() => null);
    if (current === null) return { ok: false, error: `${relativePath} is not in ${config.skillRepo}@${baseBranch}.` };
    if (sha256(current) !== sha256(input.baselineContent)) {
      return {
        ok: false,
        error: `${relativePath} changed in ${config.skillRepo}@${baseBranch} after the experiment started. Run a new experiment on the current text.`,
      };
    }

    await checkoutNewBranch(workspaceDir, branchName);
    const lineEnding = current.includes('\r\n') ? '\r\n' : '\n';
    await fs.writeFile(target, input.candidateContent.replace(/\r?\n/g, lineEnding), 'utf8');
    await git(safeArgs(workspaceDir, ['add', '--', relativePath]), { cwd: workspaceDir });
    await git(safeArgs(workspaceDir, ['commit', '-m', `skill-learning: improve ${skillName(relativePath)} Skill\n\nExperiment ${input.experimentId}`]), {
      cwd: workspaceDir,
      env: {
        GIT_AUTHOR_NAME: 'Apex Skill Learning',
        GIT_AUTHOR_EMAIL: 'apex@noreply',
        GIT_COMMITTER_NAME: 'Apex Skill Learning',
        GIT_COMMITTER_EMAIL: 'apex@noreply',
      },
    });
    await pushBranch(workspaceDir, branchName, resolveGitRemote(provider, input.project, config.skillRepo));

    const title = `Skill Learning: improve ${skillName(relativePath)} Skill`;
    const description = buildPullRequestBody(input);
    let url: string;
    if (provider === 'github') {
      const slash = config.skillRepo.indexOf('/');
      url = await githubCatalog.createPullRequest({
        org: slash > 0 ? config.skillRepo.slice(0, slash) : undefined,
        repo: slash > 0 ? config.skillRepo.slice(slash + 1) : config.skillRepo,
        sourceBranch: branchName,
        targetBranch: baseBranch,
        title,
        description,
      });
    } else {
      url = await new AzureDevOpsService(input.project).createPullRequest({
        repo: config.skillRepo,
        project: input.project,
        sourceBranch: branchName,
        targetBranch: baseBranch,
        title,
        description,
      });
    }
    if (!url) return { ok: false, error: 'The pull request provider returned no link.' };
    return { ok: true, url, branchName };
  } catch (error) {
    return { ok: false, error: `Pull request failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      cleanupWorkspace(sessionId);
    } catch {
      // The checkout directory is temporary; a later checkout with the same session replaces it.
    }
  }
}
