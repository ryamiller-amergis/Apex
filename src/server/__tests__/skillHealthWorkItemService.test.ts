import {
  createSkillHealthWorkItem,
  parseSkillHealthWorkItemRequest,
  toAdoDescriptionHtml,
} from '../services/skillHealthWorkItemService';
import { AzureDevOpsService } from '../services/azureDevOps';
import { AdoUserAuthError } from '../services/adoUserToken';
import { createFeatureRequest, resolveFeatureRequestReviewers } from '../services/featureRequestService';
import { autoStartFeatureRequestAnalysis } from '../services/featureRequestAnalysisService';
import { createNotification } from '../services/notificationService';
import type { CreateSkillHealthWorkItemRequest } from '../../shared/types/skillHealth';

jest.mock('../services/azureDevOps', () => ({ AzureDevOpsService: jest.fn() }));
jest.mock('../services/adoUserToken', () => {
  class MockAdoUserAuthError extends Error {
    status = 403;
  }
  return { AdoUserAuthError: MockAdoUserAuthError };
});
jest.mock('../services/featureRequestService', () => ({
  createFeatureRequest: jest.fn(),
  resolveFeatureRequestReviewers: jest.fn(),
}));
jest.mock('../services/featureRequestAnalysisService', () => ({ autoStartFeatureRequestAnalysis: jest.fn() }));
jest.mock('../services/notificationService', () => ({ createNotification: jest.fn() }));

const MockAdo = AzureDevOpsService as unknown as jest.Mock;
const mockCreateFeatureRequest = createFeatureRequest as jest.Mock;
const mockReviewers = resolveFeatureRequestReviewers as jest.Mock;
const mockAnalysis = autoStartFeatureRequestAnalysis as jest.Mock;
const mockNotify = createNotification as jest.Mock;

const request = (overrides: Partial<CreateSkillHealthWorkItemRequest> = {}): CreateSkillHealthWorkItemRequest => ({
  project: 'MaxView',
  destination: 'project-ado',
  artifactKind: 'prd',
  skillPath: '.cursor/skills/to-prd/SKILL.md',
  title: 'Skill Health: to-prd — Glossary (MaxView)',
  description: 'Uses <Facility> & "workers".\nSecond line.\n\nProposed change: read CONTEXT.md first.',
  ...overrides,
});

describe('parseSkillHealthWorkItemRequest', () => {
  it('accepts a valid request and trims fields', () => {
    expect(parseSkillHealthWorkItemRequest({ ...request(), title: '  T  ', skillPath: ' ' })).toEqual({
      ...request(),
      title: 'T',
      skillPath: null,
    });
  });

  it('rejects a project ADO destination for the foundation project', () => {
    expect(parseSkillHealthWorkItemRequest(request({ project: 'Apex' }))).toBe('Apex Skills are filed to the Apex Backlog');
  });

  it('lets another project send a shared-Skill finding to the Apex Backlog', () => {
    expect(parseSkillHealthWorkItemRequest(request({ destination: 'apex-backlog' }))).toMatchObject({
      project: 'MaxView',
      destination: 'apex-backlog',
    });
  });

  it.each([
    [{ project: '' }, 'project is required'],
    [{ destination: 'email' }, 'destination must be apex-backlog or project-ado'],
    [{ artifactKind: 'adr' }, 'artifactKind must be prd or design_doc'],
    [{ title: ' ' }, 'title is required'],
    [{ title: 'x'.repeat(256) }, 'title must be at most 255 characters'],
    [{ description: '' }, 'description is required'],
  ])('rejects %p', (overrides, message) => {
    expect(parseSkillHealthWorkItemRequest({ ...request(), ...overrides })).toBe(message);
  });
});

describe('toAdoDescriptionHtml', () => {
  it('escapes HTML, keeps paragraphs and line breaks, and names the source', () => {
    expect(toAdoDescriptionHtml(request())).toBe(
      '<p>Uses &lt;Facility&gt; &amp; &quot;workers&quot;.<br>Second line.</p>' +
        '<p>Proposed change: read CONTEXT.md first.</p>' +
        '<p><em>Filed from Apex Skill Health — project MaxView, .cursor/skills/to-prd/SKILL.md (prd).</em></p>',
    );
  });
});

describe('createSkillHealthWorkItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAnalysis.mockResolvedValue(undefined);
  });

  it('files foundation findings to the Apex Backlog as a technical item and notifies reviewers', async () => {
    mockCreateFeatureRequest.mockResolvedValue({ id: 'fr-1', title: 'T' });
    mockReviewers.mockResolvedValue(['reviewer-1']);

    const result = await createSkillHealthWorkItem(
      'user-1',
      null,
      request({ project: 'Apex', destination: 'apex-backlog', description: 'Fix it' }),
    );

    expect(result).toEqual({ destination: 'apex-backlog', project: 'Apex', id: 'fr-1', url: null });
    expect(mockCreateFeatureRequest).toHaveBeenCalledWith('user-1', 'Apex', {
      type: 'technical',
      title: 'Skill Health: to-prd — Glossary (MaxView)',
      request: 'Fix it\n\nFiled from Apex Skill Health — project Apex, .cursor/skills/to-prd/SKILL.md (prd).',
    });
    expect(mockNotify).toHaveBeenCalledWith('reviewer-1', expect.objectContaining({ link: '/feature-requests' }));
    expect(mockAnalysis).toHaveBeenCalledWith('fr-1');
    expect(MockAdo).not.toHaveBeenCalled();
  });

  it('creates a PBI in the project ADO as the signed-in user', async () => {
    const createWorkItemForPrd = jest.fn().mockResolvedValue({ id: 42, url: 'https://ado/MaxView/_workitems/edit/42' });
    MockAdo.mockImplementation(() => ({ createWorkItemForPrd }));

    const result = await createSkillHealthWorkItem('user-1', 'user-token', request());

    expect(MockAdo).toHaveBeenCalledWith('MaxView', 'MaxView', { bearerToken: 'user-token' });
    expect(createWorkItemForPrd).toHaveBeenCalledWith({
      type: 'Product Backlog Item',
      title: 'Skill Health: to-prd — Glossary (MaxView)',
      description: toAdoDescriptionHtml(request()),
      tags: ['skill-health'],
    });
    expect(result).toEqual({
      destination: 'project-ado',
      project: 'MaxView',
      id: '42',
      url: 'https://ado/MaxView/_workitems/edit/42',
    });
    expect(mockCreateFeatureRequest).not.toHaveBeenCalled();
  });

  it('refuses a project ADO item without a user token instead of using the PAT', async () => {
    await expect(createSkillHealthWorkItem('user-1', null, request())).rejects.toBeInstanceOf(AdoUserAuthError);
    expect(MockAdo).not.toHaveBeenCalled();
  });
});
