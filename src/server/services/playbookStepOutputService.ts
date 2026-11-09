import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../db/schema';
import {
  createPlaybookStepOutputStore,
  PlaybookStepOutputVerificationError,
} from './playbookStepOutputStore';
import type {
  PlaybookStepBlobRef,
  PlaybookStepOutputEnvelope,
} from '../../shared/types/playbook';

export type PlaybookOutputPart = 'full' | 'reportMd' | 'scorecard';

export class PlaybookStepOutputNotFoundError extends Error {
  constructor() {
    super('No such Playbook step output in this project.');
    this.name = 'PlaybookStepOutputNotFoundError';
  }
}

export async function getPlaybookStepOutput(input: {
  project: string;
  runId: string;
  stepRunId: string;
  part: PlaybookOutputPart;
}): Promise<{
  value: unknown;
  blobRef: PlaybookStepBlobRef | null;
}> {
  const [row] = await db
    .select({
      stepId: playbookStepRuns.stepId,
      outputInline: playbookStepRuns.outputInline,
      outputBlobRef: playbookStepRuns.outputBlobRef,
    })
    .from(playbookStepRuns)
    .innerJoin(playbookRuns, eq(playbookStepRuns.runId, playbookRuns.id))
    .where(
      and(
        eq(playbookRuns.id, input.runId),
        eq(playbookRuns.project, input.project),
        eq(playbookStepRuns.id, input.stepRunId)
      )
    )
    .limit(1);
  if (!row) throw new PlaybookStepOutputNotFoundError();

  let output = (row.outputInline ?? {}) as Record<string, unknown>;
  if (row.outputBlobRef) {
    let envelope: PlaybookStepOutputEnvelope;
    try {
      envelope = await createPlaybookStepOutputStore().load(row.outputBlobRef);
    } catch (error) {
      if (error instanceof PlaybookStepOutputVerificationError) {
        throw new PlaybookStepOutputNotFoundError();
      }
      throw error;
    }
    if (
      envelope.project !== input.project
      || envelope.runId !== input.runId
      || envelope.stepRunId !== input.stepRunId
      || envelope.stepId !== row.stepId
    ) {
      throw new PlaybookStepOutputNotFoundError();
    }
    output = envelope.output;
  }

  if (input.part !== 'full' && !(input.part in output)) {
    throw new PlaybookStepOutputNotFoundError();
  }
  return {
    value: input.part === 'full' ? output : output[input.part],
    blobRef: row.outputBlobRef,
  };
}
