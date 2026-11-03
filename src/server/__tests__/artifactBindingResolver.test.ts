import { createHash } from 'crypto';
import {
  canonicalJson,
  hashInterviewPhaseArtifact,
  hashPrdArtifact,
  resolveCurrentArtifactBinding,
} from '../services/artifactBindingResolver';
import { WorkflowEvaluationError } from '../services/workflowEvaluationError';

jest.mock('../services/prdService', () => ({
  getPrdEvaluationInputs: jest.fn(),
}));

jest.mock('../services/interviewService', () => ({
  getInterviewEvaluationInputs: jest.fn(),
}));

const { getPrdEvaluationInputs } = jest.requireMock('../services/prdService') as {
  getPrdEvaluationInputs: jest.Mock;
};

describe('artifactBindingResolver hashes — TBI-006', () => {
  const markdown = '# Problem\nShip the evaluation service.';
  const backlog = { epics: [{ id: 'e1', title: 'Foundations', features: [] }] };

  it('VT-01 / TBI-006 (a): the same PRD input always yields the same SHA-256 hash', () => {
    const first = hashPrdArtifact(markdown, backlog);
    const second = hashPrdArtifact(markdown, backlog);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(createHash('sha256').update(
      ['apex-eval-artifact/v1', 'prd', markdown, canonicalJson(backlog)].join('\0'),
      'utf8',
    ).digest('hex'));
  });

  it('VT-02 / TBI-006 (c): nested key order does not change the hash and array order does', () => {
    const nested = { b: 1, a: { z: 1, y: [1, 2] } };
    const reordered = { a: { y: [1, 2], z: 1 }, b: 1 };
    const arrayReordered = { b: 1, a: { z: 1, y: [2, 1] } };
    expect(hashPrdArtifact(markdown, nested)).toBe(hashPrdArtifact(markdown, reordered));
    expect(hashPrdArtifact(markdown, nested)).not.toBe(hashPrdArtifact(markdown, arrayReordered));
  });

  it('VT-03 / TBI-006 (c): a markdown or backlog value change changes the hash', () => {
    const baseline = hashPrdArtifact(markdown, backlog);
    const markdownChanged = hashPrdArtifact(`${markdown}x`, backlog);
    const backlogChanged = hashPrdArtifact(markdown, { ...backlog, note: 'changed' });
    expect(new Set([baseline, markdownChanged, backlogChanged]).size).toBe(3);
  });

  it('VT-04 / TBI-006 (c): null and undefined backlogs share a stable hash that differs from {}', () => {
    const fromNull = hashPrdArtifact(markdown, null);
    const fromUndefined = hashPrdArtifact(markdown, undefined);
    const fromEmpty = hashPrdArtifact(markdown, {});
    expect(fromNull).toBe(fromUndefined);
    expect(fromNull).toMatch(/^[0-9a-f]{64}$/);
    expect(fromNull).not.toBe(fromEmpty);
  });

  it('VT-05 / TBI-006 (c): a message or link id changes the hash and link order does not', () => {
    const slice = [{ role: 'user', text: 'The problem is slow reviews.' }];
    const links = { adrIds: ['b', 'a'], designModuleIds: ['m1'] };
    const baseline = hashInterviewPhaseArtifact(slice, links);
    const reordered = hashInterviewPhaseArtifact(slice, {
      adrIds: ['a', 'b'],
      designModuleIds: ['m1'],
    });
    const addedMessage = hashInterviewPhaseArtifact(
      [...slice, { role: 'agent', text: 'Noted.' }],
      links,
    );
    const addedId = hashInterviewPhaseArtifact(slice, {
      adrIds: ['a', 'b', 'c'],
      designModuleIds: ['m1'],
    });
    expect(baseline).toBe(reordered);
    expect(baseline).not.toBe(addedMessage);
    expect(baseline).not.toBe(addedId);
  });
});

describe('resolveCurrentArtifactBinding — TBI-006', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('VT-08 / TBI-006 (a)(b): a ready PRD binds lineage and hash, and empty content is not ready', async () => {
    getPrdEvaluationInputs.mockResolvedValueOnce({
      id: 'prd-1',
      project: 'proj-a',
      status: 'draft',
      interviewId: 'interview-1',
      model: 'claude',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      skillVersion: 'grounded-sha',
      content: '# PRD',
      backlogJson: { epics: [] },
    });

    const binding = await resolveCurrentArtifactBinding({
      project: 'proj-a',
      subjectType: 'prd',
      subjectId: 'prd-1',
      phaseIndex: null,
    });

    expect(binding.lineage).toEqual({
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      skillVersion: 'grounded-sha',
      model: 'claude',
      interviewId: 'interview-1',
      prdId: 'prd-1',
    });
    expect(binding.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.prdMarkdown).toBe('# PRD');

    getPrdEvaluationInputs.mockResolvedValueOnce({
      id: 'prd-2',
      project: 'proj-a',
      status: 'generating',
      interviewId: null,
      model: null,
      skillPath: null,
      skillVersion: null,
      content: '   ',
      backlogJson: null,
    });
    await expect(resolveCurrentArtifactBinding({
      project: 'proj-a',
      subjectType: 'prd',
      subjectId: 'prd-2',
      phaseIndex: null,
    })).rejects.toMatchObject({ code: 'ARTIFACT_NOT_READY' });
  });

  it('TBI-006 (b): a PRD in another project is not found and produces no hash', async () => {
    getPrdEvaluationInputs.mockResolvedValue({
      id: 'prd-1',
      project: 'proj-b',
      status: 'draft',
      interviewId: null,
      model: null,
      skillPath: null,
      skillVersion: null,
      content: '# PRD',
      backlogJson: null,
    });
    await expect(resolveCurrentArtifactBinding({
      project: 'proj-a',
      subjectType: 'prd',
      subjectId: 'prd-1',
      phaseIndex: null,
    })).rejects.toBeInstanceOf(WorkflowEvaluationError);
    await expect(resolveCurrentArtifactBinding({
      project: 'proj-a',
      subjectType: 'prd',
      subjectId: 'prd-1',
      phaseIndex: null,
    })).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' });
  });
});
