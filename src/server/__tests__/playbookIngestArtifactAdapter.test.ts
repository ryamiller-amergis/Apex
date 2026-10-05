const getDesignDoc = jest.fn();
const createDesignDocValidationAdapter = jest.fn();
jest.mock('../services/designDocService', () => ({
  getDesignDoc: (...args: unknown[]) => getDesignDoc(...args),
  createDesignDocValidationAdapter: (...args: unknown[]) => createDesignDocValidationAdapter(...args),
}));

jest.mock('../services/prdService', () => ({
  getPrd: jest.fn(),
  createPrdValidationAdapter: jest.fn(),
}));

const ingestValidationScorecard = jest.fn();
jest.mock('../services/documentValidationService', () => ({
  ingestValidationScorecard: (...args: unknown[]) => ingestValidationScorecard(...args),
}));

import { executeIngestArtifactStep } from '../services/playbookSteps/ingestArtifactAdapter';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';

function context(): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'ingest',
    stepType: 'ingest-artifact',
    project: 'Apex',
    initiatorUserId: 'owner-1',
    config: {
      documentType: 'design_doc',
      documentId: 'doc-1',
      validationThreadId: 'thread-9',
    },
  };
}

describe('ingest-artifact step', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDesignDoc.mockResolvedValue({ id: 'doc-1', project: 'Apex' });
    createDesignDocValidationAdapter.mockReturnValue({ getStatus: () => 'draft' });
  });

  it('reports stale when the document write matched no row, so the run stops before routing', async () => {
    ingestValidationScorecard.mockResolvedValue({ disposition: 'discarded_stale' });

    const outcome = await executeIngestArtifactStep(context());

    expect(outcome).toEqual({ kind: 'completed', output: { outcome: 'stale' } });
  });
});
