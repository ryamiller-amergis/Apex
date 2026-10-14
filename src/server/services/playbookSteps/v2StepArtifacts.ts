/**
 * Scorecard files of a cursor-agent step that ran on the V2 document lane.
 *
 * A V2 run's outputs live in its artifact manifest, not on this instance's disk; the document
 * harvest copies them later and only into a scratch folder, so the Playbook reads Blob directly.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { aiRunAttempts } from '../../db/schema';
import { createArtifactReader } from '../aiRunV2/artifactReader';

const V2_SCORECARD_JSON_PATH = 'output/review-scorecard.json';
const V2_SCORECARD_MD_PATH = 'output/review-scorecard.md';

export type StepScorecardFiles = { scorecard: string | null; reportMd: string | null };

/** Returns undefined when the agent run has no V2 attempt, i.e. it ran on the V1 path. */
export async function readV2ScorecardFiles(
  agentRunId: string,
): Promise<StepScorecardFiles | undefined> {
  const [attempt] = await db
    .select({ manifestRef: aiRunAttempts.manifestRef })
    .from(aiRunAttempts)
    .where(eq(aiRunAttempts.runId, agentRunId))
    .orderBy(desc(aiRunAttempts.attemptNumber))
    .limit(1);
  if (!attempt) return undefined;
  if (!attempt.manifestRef) return { scorecard: null, reportMd: null };

  const artifacts = createArtifactReader();
  const manifest = await artifacts.readManifest(attempt.manifestRef);
  const read = async (path: string): Promise<string | null> =>
    manifest.files.some((file) => file.path === path)
      ? artifacts.readText(manifest, path)
      : null;
  return {
    scorecard: await read(V2_SCORECARD_JSON_PATH),
    reportMd: await read(V2_SCORECARD_MD_PATH),
  };
}
