import { stampAdoIds, stampFeatureLinkId } from '../../../shared/utils/backlogTransform';
import type { CreatePrdAdoItemsResponse } from '../../../shared/types/interview';

describe('stampFeatureLinkId', () => {
  const makeBacklog = () => ({
    epics: [
      {
        title: 'Epic One',
        features: [
          { title: 'Feature A', items: [] },
          { title: 'Feature B', items: [] },
        ],
      },
      {
        title: 'Epic Two',
        features: [
          { title: 'Feature C', items: [] },
        ],
      },
    ],
  });

  it('stamps designDocId on the correct feature by global index', () => {
    const result = stampFeatureLinkId(makeBacklog(), 1, 'designDocId', 'doc-uuid-123') as any;
    expect(result.epics[0].features[0].designDocId).toBeUndefined();
    expect(result.epics[0].features[1].designDocId).toBe('doc-uuid-123');
    expect(result.epics[1].features[0].designDocId).toBeUndefined();
  });

  it('stamps designPrototypeId on feature in second epic', () => {
    const result = stampFeatureLinkId(makeBacklog(), 2, 'designPrototypeId', 'proto-uuid-456') as any;
    expect(result.epics[0].features[0].designPrototypeId).toBeUndefined();
    expect(result.epics[0].features[1].designPrototypeId).toBeUndefined();
    expect(result.epics[1].features[0].designPrototypeId).toBe('proto-uuid-456');
  });

  it('stamps feature at index 0', () => {
    const result = stampFeatureLinkId(makeBacklog(), 0, 'designDocId', 'first-doc') as any;
    expect(result.epics[0].features[0].designDocId).toBe('first-doc');
    expect(result.epics[0].features[1].designDocId).toBeUndefined();
  });

  it('does not mutate the original backlog', () => {
    const original = makeBacklog();
    stampFeatureLinkId(original, 0, 'designDocId', 'doc-1');
    expect((original.epics[0].features[0] as any).designDocId).toBeUndefined();
  });

  it('handles top-level features (non-epic)', () => {
    const backlog = {
      features: [
        { title: 'Standalone A' },
        { title: 'Standalone B' },
      ],
      epics: [
        { title: 'Epic', features: [{ title: 'Nested' }] },
      ],
    };
    const result = stampFeatureLinkId(backlog, 0, 'designDocId', 'top-doc') as any;
    expect(result.features[0].designDocId).toBe('top-doc');
    expect(result.features[1].designDocId).toBeUndefined();
    expect(result.epics[0].features[0].designDocId).toBeUndefined();
  });

  it('stamps epic feature after top-level features', () => {
    const backlog = {
      features: [{ title: 'Standalone' }],
      epics: [{ title: 'Epic', features: [{ title: 'Nested' }] }],
    };
    const result = stampFeatureLinkId(backlog, 1, 'designDocId', 'nested-doc') as any;
    expect(result.features[0].designDocId).toBeUndefined();
    expect(result.epics[0].features[0].designDocId).toBe('nested-doc');
  });

  it('returns input unchanged for null/undefined', () => {
    expect(stampFeatureLinkId(null, 0, 'designDocId', 'x')).toBeNull();
    expect(stampFeatureLinkId(undefined, 0, 'designDocId', 'x')).toBeUndefined();
  });

  it('handles out-of-range featureIndex gracefully', () => {
    const result = stampFeatureLinkId(makeBacklog(), 99, 'designDocId', 'nope') as any;
    for (const epic of result.epics) {
      for (const feat of epic.features) {
        expect(feat.designDocId).toBeUndefined();
      }
    }
  });
});

describe('stampAdoIds – dependsOnAdoIds', () => {
  it('resolves dependsOn by item ID into dependsOnAdoIds', () => {
    const backlog = {
      epics: [{
        title: 'Epic',
        features: [{
          title: 'Feature',
          items: [
            { id: 'tbi-1', title: 'Infra', type: 'TBI' },
            { id: 'pbi-1', title: 'Login', type: 'PBI', dependsOn: ['tbi-1'] },
          ],
        }],
      }],
    };

    const response: CreatePrdAdoItemsResponse = {
      success: true,
      created: {
        epics: [{ title: 'Epic', adoId: 100, adoUrl: 'u' }],
        features: [{ title: 'Feature', adoId: 200, adoUrl: 'u' }],
        pbis: [{ title: 'Login', adoId: 301, adoUrl: 'u', id: 'pbi-1', dependsOn: ['tbi-1'] }],
        tasks: [{ title: 'Infra', adoId: 300, adoUrl: 'u', id: 'tbi-1' }],
        testCases: [],
      },
      totalCreated: 4,
    };

    const result = stampAdoIds(backlog, response) as any;
    const pbi = result.epics[0].features[0].items[1];
    expect(pbi.dependsOnAdoIds).toEqual([300]);
  });
});
