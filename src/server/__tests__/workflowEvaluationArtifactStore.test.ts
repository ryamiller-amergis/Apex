jest.mock('../services/aiRunV2/artifactContainer', () => {
  const upload = jest.fn().mockResolvedValue({});
  const deleteIfExists = jest.fn().mockResolvedValue({});
  const getBlockBlobClient = jest.fn(() => ({ upload, deleteIfExists }));
  return {
    artifactContainerName: () => 'ai-run-artifacts',
    resolveArtifactContainerClient: () => ({ getBlockBlobClient }),
    upload,
    deleteIfExists,
    getBlockBlobClient,
  };
});

import {
  correctedArtifactBlobKey,
  deleteCorrectedArtifact,
  writeCorrectedArtifact,
} from '../services/workflowEvaluationArtifactStore';

const {
  upload,
  deleteIfExists,
  getBlockBlobClient,
} = jest.requireMock('../services/aiRunV2/artifactContainer') as {
  upload: jest.Mock;
  deleteIfExists: jest.Mock;
  getBlockBlobClient: jest.Mock;
};

describe('workflowEvaluationArtifactStore — TBI-007', () => {
  beforeEach(() => {
    upload.mockClear();
    deleteIfExists.mockClear();
    getBlockBlobClient.mockClear();
  });

  it('VT-18: writes markdown at a key that contains the project and event id', async () => {
    const ref = await writeCorrectedArtifact('proj a', 'event-1', '# Corrected');
    expect(ref).toEqual({
      container: 'ai-run-artifacts',
      key: correctedArtifactBlobKey('proj a', 'event-1'),
    });
    expect(ref.key).toContain(encodeURIComponent('proj a'));
    expect(ref.key).toContain('event-1');
    expect(ref.key.startsWith('workflow-evaluations/')).toBe(true);
    expect(upload).toHaveBeenCalledWith(expect.any(Buffer), Buffer.byteLength('# Corrected', 'utf8'), expect.any(Object));
  });

  it('VT-19: delete addresses the stored blob reference', async () => {
    await deleteCorrectedArtifact({ container: 'ai-run-artifacts', key: 'workflow-evaluations/proj/event-1/corrected-artifact.md' });
    expect(deleteIfExists).toHaveBeenCalledTimes(1);
  });
});
