import fs from 'fs';
import path from 'path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreadOutputs } from '../db/schema';

/**
 * Files a V2 chat turn wrote under `.ai-pilot/`. Ingest saves them here, and
 * whole-V2 projects have no thread folder on the share, so readers look here
 * first and fall back to the folder for threads that still have one.
 */

function toRelativePath(relativePath: string | readonly string[]): string {
  return typeof relativePath === 'string'
    ? relativePath
    : path.posix.join(...relativePath);
}

export async function saveThreadOutputs(
  threadId: string,
  runId: string | null,
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<void> {
  if (files.length === 0) return;
  await db
    .insert(chatThreadOutputs)
    .values(files.map((file) => ({ threadId, path: file.path, content: file.content, runId })))
    .onConflictDoUpdate({
      target: [chatThreadOutputs.threadId, chatThreadOutputs.path],
      set: {
        content: sql`excluded.content`,
        runId: sql`excluded.run_id`,
        updatedAt: sql`now()`,
      },
    });
}

/** The saved file, else the copy in the thread folder, else null. */
export async function readThreadOutput(input: {
  threadId: string;
  workspaceDir?: string | null;
  relativePath: string | readonly string[];
}): Promise<string | null> {
  const relativePath = toRelativePath(input.relativePath);
  const [row] = await db
    .select({ content: chatThreadOutputs.content })
    .from(chatThreadOutputs)
    .where(and(eq(chatThreadOutputs.threadId, input.threadId), eq(chatThreadOutputs.path, relativePath)))
    .limit(1);
  if (row) return row.content;
  if (!input.workspaceDir) return null;
  const file = path.join(input.workspaceDir, ...relativePath.split('/'));
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** Remove a stale output before a re-run, from the store and the thread folder. */
export async function clearThreadOutput(input: {
  threadId: string;
  workspaceDir?: string | null;
  relativePath: string | readonly string[];
}): Promise<void> {
  const relativePath = toRelativePath(input.relativePath);
  await db
    .delete(chatThreadOutputs)
    .where(and(eq(chatThreadOutputs.threadId, input.threadId), eq(chatThreadOutputs.path, relativePath)));
  if (!input.workspaceDir) return;
  fs.rmSync(path.join(input.workspaceDir, ...relativePath.split('/')), { force: true });
}
