import { createDesignDocValidationAdapter, getDesignDoc } from '../designDocService';
import { ingestValidationScorecard } from '../documentValidationService';
import { createPrdValidationAdapter, getPrd } from '../prdService';
import type { ValidationScorecard } from '../../../shared/types/interview';
import type { IngestArtifactStepConfig } from '../../../shared/types/playbook';
import { NO_SCORECARD_REASON } from '../../../shared/utils/validationReport';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import type { PlaybookStepExecutionContext, PlaybookStepOutcome } from './stepRuns';

export class PlaybookArtifactNotFoundError extends Error {
  constructor(documentType: string, documentId: string) {
    super(`No ${documentType} artifact "${documentId}" exists in this Playbook project.`);
    this.name = 'PlaybookArtifactNotFoundError';
  }
}

export async function executeIngestArtifactStep(
  context: PlaybookStepExecutionContext,
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<IngestArtifactStepConfig>('ingest-artifact', context.config);
  let adapter;
  if (config.documentType === 'design_doc') {
    const document = await getDesignDoc(config.documentId);
    if (!document || document.project !== context.project) {
      throw new PlaybookArtifactNotFoundError(config.documentType, config.documentId);
    }
    adapter = createDesignDocValidationAdapter(config.documentId, document);
  } else {
    const document = await getPrd(config.documentId);
    if (!document || document.project !== context.project) {
      throw new PlaybookArtifactNotFoundError(config.documentType, config.documentId);
    }
    adapter = createPrdValidationAdapter(document);
  }
  const ingestOutcome = config.scorecard
    ? {
        kind: 'success' as const,
        scorecardRaw: config.scorecard as unknown as ValidationScorecard,
        reportMd: config.reportMd,
      }
    : { kind: 'unusable' as const, reason: NO_SCORECARD_REASON };
  const result = await ingestValidationScorecard(adapter, config.validationThreadId, ingestOutcome);

  if (result.disposition === 'discarded_stale') {
    return {
      kind: 'completed',
      output: parseStepOutput('ingest-artifact', { outcome: 'stale' }),
    };
  }

  return {
    kind: 'completed',
    output: parseStepOutput('ingest-artifact', {
      outcome: 'applied',
      status: adapter.getStatus(),
      verdict: result.scorecard.verdict,
      isReady: result.scorecard.is_ready,
    }),
  };
}
