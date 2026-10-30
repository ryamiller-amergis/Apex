import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrainstormTurnSources } from '../../../shared/types/brainstormSources';
import type { DurableInteractiveTurnSpecification } from '../../../shared/types/durableInteractiveTurn';

type Checkout = (
  grounding: NonNullable<DurableInteractiveTurnSpecification['grounding']>,
  destination: string,
  signal: AbortSignal,
) => Promise<{ status: string }>;

/**
 * Puts each ready Brainstorm source where the interactive agent reads files.
 * A clone on this machine is copied from the shared data root (the same root
 * as the repository cache). Otherwise the worker restores the grounding bundle
 * for that commit, the same way a grounded turn does.
 */
async function alreadyMountedAtSha(dest: string, sha: string): Promise<boolean> {
  try {
    const marker = await fs.readFile(path.join(dest, '.apex-brainstorm-ready'), 'utf8');
    return marker.trim().toLowerCase() === sha.trim().toLowerCase();
  } catch {
    return false;
  }
}

async function linkOrCopyLocalClone(input: {
  sourceDir: string;
  dest: string;
  sha: string;
  runGit: (args: string[], cwd?: string) => Promise<void>;
}): Promise<void> {
  await fs.rm(input.dest, { recursive: true, force: true }).catch(() => {});
  try {
    await fs.symlink(
      input.sourceDir,
      input.dest,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return;
  } catch {
    await fs.rm(input.dest, { recursive: true, force: true }).catch(() => {});
  }
  await input.runGit(['clone', '--local', '--no-hardlinks', input.sourceDir, input.dest]);
  await input.runGit(['checkout', '--detach', input.sha], input.dest);
  await fs.writeFile(path.join(input.dest, '.apex-brainstorm-ready'), `${input.sha}\n`).catch(() => {});
}

/**
 * Returns candidate paths to probe for a Brainstorm source clone across local
 * development and cloud container mounts:
 * 1. Exact `workspacePath` (local dev, or when App Service and container share `/workspaces`).
 * 2. `<root>/<subpath>` with `/workspaces/` stripped (when App Service writes into its
 *    `/home/data/ai-pilot/workspaces` Azure Files mount and the V2 container mounts
 *    that same share at `/home/data/ai-pilot`).
 * 3. `<root>/workspaces/<subpath>` (when a legacy path without `/workspaces/` was recorded).
 */
export function candidateSourcePaths(workspacePath: string): string[] {
  const seen = new Set<string>();
  const add = (candidate: string) => {
    if (candidate && !seen.has(candidate)) seen.add(candidate);
  };
  add(workspacePath);

  const workspacesMarkerRe = /([/\\])workspaces\1(brainstorm-(?:repo-mirrors|workspaces)(?:[/\\].*)?)$/;
  const strippedMatch = workspacesMarkerRe.exec(workspacePath);
  if (strippedMatch) {
    const sep = strippedMatch[1];
    const prefix = workspacePath.slice(0, strippedMatch.index);
    add(`${prefix}${sep}${strippedMatch[2]}`);
  }

  const directMarkerRe = /([/\\])(brainstorm-(?:repo-mirrors|workspaces)(?:[/\\].*)?)$/;
  const directMatch = directMarkerRe.exec(workspacePath);
  if (directMatch && !strippedMatch) {
    const sep = directMatch[1];
    const prefix = workspacePath.slice(0, directMatch.index);
    add(`${prefix}${sep}workspaces${sep}${directMatch[2]}`);
  }

  return [...seen];
}

export async function mountBrainstormSources(input: {
  sources: BrainstormTurnSources | undefined;
  destination: string;
  signal: AbortSignal;
  runGit: (args: string[], cwd?: string) => Promise<void>;
  checkout: Checkout;
  pathExists?: (target: string) => Promise<boolean>;
}): Promise<void> {
  const roots = input.sources?.readRoots ?? [];
  if (roots.length === 0) return;
  const exists = input.pathExists ?? (async (target: string) => {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  });
  for (const root of roots) {
    if (input.signal.aborted) return;
    const dest = path.join(input.destination, 'sources', root.sourceId);
    if (await alreadyMountedAtSha(dest, root.commitSha)) continue;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    let resolvedSourceDir: string | null = null;
    for (const candidate of candidateSourcePaths(root.workspacePath)) {
      if (await exists(candidate)) {
        resolvedSourceDir = candidate;
        break;
      }
    }
    if (resolvedSourceDir) {
      await linkOrCopyLocalClone({
        sourceDir: resolvedSourceDir,
        dest,
        sha: root.commitSha,
        runGit: input.runGit,
      });
      continue;
    }
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
    await input.checkout({
      provider: root.provider,
      project: root.project,
      repository: root.repository,
      sha: root.commitSha,
      profileId: 'brainstorm-source',
    }, dest, input.signal);
    await fs.writeFile(path.join(dest, '.apex-brainstorm-ready'), `${root.commitSha}\n`).catch(() => {});
  }
}
