import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { standupParticipants } from '../db/schema';
import { adoWriteFromToken } from './adoFactory';
import type { AzureDevOpsService } from './azureDevOps';

/**
 * Resolve a participant's stored ADO token by chat thread ID.
 * Returns null if no participant maps to the thread or the token is expired.
 */
export async function getAdoTokenForThread(threadId: string): Promise<string | null> {
  const participant = await db.query.standupParticipants.findFirst({
    where: eq(standupParticipants.threadId, threadId),
    columns: { adoAccessToken: true, adoTokenExpiresAt: true },
  });
  if (!participant?.adoAccessToken) return null;

  if (participant.adoTokenExpiresAt) {
    const expiresAt = new Date(participant.adoTokenExpiresAt).getTime();
    if (Date.now() > expiresAt) return null;
  }

  return participant.adoAccessToken;
}

/**
 * Build an AzureDevOpsService for MCP write tools operating in a standup thread.
 * Resolves the per-user token from the participant row associated with the given threadId.
 */
export async function adoServiceForStandupThread(
  threadId: string,
  project?: string,
  areaPath?: string,
): Promise<AzureDevOpsService> {
  const token = await getAdoTokenForThread(threadId);
  return adoWriteFromToken(token, project, areaPath);
}
