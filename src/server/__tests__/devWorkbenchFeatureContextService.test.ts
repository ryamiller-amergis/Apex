/**
 * Unit tests for getApexFeatureContext — feature-index resolution, feature-only
 * backlog normalization, document/prototype association, HTML sanitization,
 * missing artifacts, and not-found behavior.
 */

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      prds: { findFirst: jest.fn() },
      designDocs: { findFirst: jest.fn() },
      designPrototypes: { findFirst: jest.fn() },
    },
  },
}));

jest.mock('../utils/htmlSanitizer', () => ({
  sanitizeMockHtml: jest.fn((html: string) => `sanitized:${html}`),
}));

import { db } from '../db/drizzle';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import { getApexFeatureContext } from '../services/devWorkbenchFeatureContextService';

const mockPrdFindFirst = db.query.prds.findFirst as jest.Mock;
const mockDocFindFirst = db.query.designDocs.findFirst as jest.Mock;
const mockProtoFindFirst = db.query.designPrototypes.findFirst as jest.Mock;
const mockSanitize = sanitizeMockHtml as jest.Mock;

const SAMPLE_BACKLOG = {
  epics: [
    {
      title: 'Notifications Epic',
      features: [
        {
          id: 'FEAT-001',
          title: 'Preference controls',
          priority: 'Must',
          items: [
            {
              type: 'PBI',
              id: 'PBI-001',
              title: 'Toggle preferences',
              priority: 'Must Have',
              description: 'User can toggle notification types',
              status: 'Ready',
              dependsOn: ['TBI-001'],
              acceptanceCriteria: [
                {
                  given: 'I am on preferences',
                  when: 'I toggle off',
                  then: 'Preference is saved',
                },
                'String criterion',
              ],
            },
            {
              type: 'TBI',
              id: 'TBI-001',
              title: 'Preferences API',
              priority: 'Must Have',
              description: 'Add GET/PUT endpoints',
              dependsOn: [],
              definitionOfDone: ['Migration applied', 'Tests pass'],
            },
          ],
        },
        {
          id: 'FEAT-002',
          title: 'Other feature',
          priority: 'Should',
          items: [
            { type: 'PBI', id: 'PBI-099', title: 'Other PBI' },
          ],
        },
      ],
    },
  ],
};

const APPROVED_PRD = {
  id: 'prd-1',
  title: 'Notification Preferences',
  project: 'Apex',
  status: 'approved',
  content: '# PRD\n\nApproved content.',
  backlogJson: SAMPLE_BACKLOG,
};

describe('getApexFeatureContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDocFindFirst.mockResolvedValue(undefined);
    mockProtoFindFirst.mockResolvedValue(undefined);
  });

  it('returns null for ADO-backed projects without querying the DB', async () => {
    const result = await getApexFeatureContext('MaxView', 'prd-1', 'FEAT-001');
    expect(result).toBeNull();
    expect(mockPrdFindFirst).not.toHaveBeenCalled();
  });

  it('loads approved app-native feature context for Amego', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);

    const result = await getApexFeatureContext('Amego', 'prd-1', 'FEAT-001');

    expect(result).not.toBeNull();
    expect(result!.featureId).toBe('FEAT-001');
    expect(mockPrdFindFirst).toHaveBeenCalledTimes(1);
  });

  it('returns null when the approved PRD is not found', async () => {
    mockPrdFindFirst.mockResolvedValue(undefined);
    const result = await getApexFeatureContext('Apex', 'prd-missing', 'FEAT-001');
    expect(result).toBeNull();
  });

  it('returns null when the feature ID is not in the backlog', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);
    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-999');
    expect(result).toBeNull();
  });

  it('resolves featureIndex and returns only that feature’s PBI/TBI children', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);

    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-001');

    expect(result).not.toBeNull();
    expect(result!.featureId).toBe('FEAT-001');
    expect(result!.featureTitle).toBe('Preference controls');
    expect(result!.epicTitle).toBe('Notifications Epic');
    expect(result!.prdTitle).toBe('Notification Preferences');
    expect(result!.prdContent).toBe('# PRD\n\nApproved content.');
    expect(result!.backlogItems).toHaveLength(2);
    expect(result!.backlogItems.map((i) => i.id)).toEqual(['PBI-001', 'TBI-001']);
    expect(result!.backlogItems.find((i) => i.id === 'PBI-099')).toBeUndefined();
  });

  it('normalizes acceptance criteria objects and definition of done', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);

    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-001');
    const pbi = result!.backlogItems.find((i) => i.id === 'PBI-001')!;
    const tbi = result!.backlogItems.find((i) => i.id === 'TBI-001')!;

    expect(pbi.acceptanceCriteria).toEqual([
      'Given I am on preferences, When I toggle off, Then Preference is saved',
      'String criterion',
    ]);
    expect(pbi.dependencies).toEqual(['TBI-001']);
    expect(pbi.status).toBe('Ready');
    expect(tbi.definitionOfDone).toEqual(['Migration applied', 'Tests pass']);
    expect(tbi.description).toBe('Add GET/PUT endpoints');
  });

  it('returns null designDocument and prototype when neither exists', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);

    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-001');

    expect(result!.designDocument).toBeNull();
    expect(result!.prototype).toBeNull();
  });

  it('loads the design document for the resolved featureIndex', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);
    mockDocFindFirst.mockResolvedValue({
      id: 'doc-1',
      title: 'Preference design',
      status: 'approved',
      designContent: '# Design',
      techSpecContent: '# Tech',
      assumptionsContent: '# Assumptions',
      designPrototypeId: null,
      featureIndex: 0,
    });

    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-001');

    expect(result!.designDocument).toEqual({
      id: 'doc-1',
      title: 'Preference design',
      status: 'approved',
      designContent: '# Design',
      techSpecContent: '# Tech',
      assumptionsContent: '# Assumptions',
    });
  });

  it('prefers designPrototypeId then falls back to (prdId, featureIndex)', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);
    mockDocFindFirst.mockResolvedValue({
      id: 'doc-1',
      title: 'Preference design',
      status: 'approved',
      designContent: '',
      techSpecContent: '',
      assumptionsContent: '',
      designPrototypeId: 'proto-linked',
      featureIndex: 0,
    });
    mockProtoFindFirst
      .mockResolvedValueOnce({
        id: 'proto-linked',
        featureName: 'Preference controls',
        status: 'approved',
        mockHtml: '<div>linked</div>',
        mockVersion: 2,
        history: [
          { version: 1, html: '<div>v1</div>', createdAt: '2026-01-01T00:00:00Z' },
          { version: 2, html: '<div>linked</div>', createdAt: '2026-01-02T00:00:00Z' },
        ],
      });

    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-001');

    expect(result!.prototype).not.toBeNull();
    expect(result!.prototype!.id).toBe('proto-linked');
    expect(result!.prototype!.mockHtml).toBe('sanitized:<div>linked</div>');
    expect(result!.prototype!.history[0].html).toBe('sanitized:<div>v1</div>');
    expect(mockSanitize).toHaveBeenCalled();
    // Only called once via designPrototypeId — no fallback
    expect(mockProtoFindFirst).toHaveBeenCalledTimes(1);
  });

  it('falls back to (prdId, featureIndex) when linked prototype is missing', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);
    mockDocFindFirst.mockResolvedValue({
      id: 'doc-1',
      title: 'Preference design',
      status: 'approved',
      designContent: '',
      techSpecContent: '',
      assumptionsContent: '',
      designPrototypeId: 'proto-missing',
      featureIndex: 0,
    });
    mockProtoFindFirst
      .mockResolvedValueOnce(undefined) // by id
      .mockResolvedValueOnce({
        id: 'proto-fallback',
        featureName: 'Preference controls',
        status: 'pending_review',
        mockHtml: '<script>x</script><p>ok</p>',
        mockVersion: 1,
        history: [],
      });

    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-001');

    expect(result!.prototype!.id).toBe('proto-fallback');
    expect(result!.prototype!.mockHtml).toBe('sanitized:<script>x</script><p>ok</p>');
    expect(mockProtoFindFirst).toHaveBeenCalledTimes(2);
  });

  it('loads prototype by featureIndex when there is no design document', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);
    mockDocFindFirst.mockResolvedValue(undefined);
    mockProtoFindFirst.mockResolvedValue({
      id: 'proto-idx',
      featureName: 'Preference controls',
      status: 'approved',
      mockHtml: '<p>solo</p>',
      mockVersion: 1,
      history: [{ version: 1, html: '<p>solo</p>', createdAt: '2026-01-01T00:00:00Z' }],
    });

    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-001');

    expect(result!.designDocument).toBeNull();
    expect(result!.prototype!.id).toBe('proto-idx');
  });

  it('uses featureIndex 1 for the second feature in the backlog', async () => {
    mockPrdFindFirst.mockResolvedValue(APPROVED_PRD);
    mockDocFindFirst.mockResolvedValue({
      id: 'doc-2',
      title: 'Other',
      status: 'draft',
      designContent: 'd',
      techSpecContent: 't',
      assumptionsContent: 'a',
      designPrototypeId: null,
      featureIndex: 1,
    });

    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-002');

    expect(result!.featureId).toBe('FEAT-002');
    expect(result!.backlogItems.map((i) => i.id)).toEqual(['PBI-099']);
    expect(result!.designDocument!.id).toBe('doc-2');
  });

  it('treats empty PRD content as empty string when content is null', async () => {
    mockPrdFindFirst.mockResolvedValue({ ...APPROVED_PRD, content: null });

    const result = await getApexFeatureContext('Apex', 'prd-1', 'FEAT-001');

    expect(result!.prdContent).toBe('');
  });
});
