import { createApplicationInsightsGroundingMetricsSource } from '../services/applicationInsightsGroundingMetrics';

describe('BR-011 / TBI-008 attempted-run metric sample', () => {
  it('counts distinct run IDs across materialize, fallback, and failure events', async () => {
    // Arrange
    const request = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tables: [
          {
            columns: [
              { name: 'sampleSize' },
              { name: 'fallbackRate' },
              { name: 'warmMaterializationP95Ms' },
              { name: 'coldMaterializationP95Ms' },
              { name: 'mirrorHitRate' },
              { name: 'groundingFailureCount' },
            ],
            rows: [[100, 0.01, 2_000, 20_000, 0.95, 0]],
          },
        ],
      }),
    }) as jest.MockedFunction<typeof fetch>;
    const source = createApplicationInsightsGroundingMetricsSource({
      environment: {
        APPLICATIONINSIGHTS_APPLICATION_ID: 'application-id',
      },
      fetch: request,
      getAccessToken: jest.fn().mockResolvedValue('managed-identity-token'),
    });

    // Act
    const sample = await source.loadSample('interview');

    // Assert
    expect(sample?.sampleSize).toBe(100);
    const requestBody = JSON.parse(
      String((request.mock.calls[0][1] as RequestInit).body),
    ) as { query: string };
    expect(requestBody.query).toContain(
      "name in ('grounding.materialize', 'grounding.fallback', 'grounding.failure')",
    );
    expect(requestBody.query).toContain(
      "dcountif(tostring(customDimensions.runId), name in ('grounding.materialize', 'grounding.fallback', 'grounding.failure') and isnotempty(tostring(customDimensions.runId)))",
    );
    expect(requestBody.query).not.toContain(
      "dcountif(tostring(customDimensions.runId), name == 'grounding.materialize')",
    );
  });

  it('PBI-008 security NFR scopes a rollout stage by escaped project and approved caller keys', async () => {
    const request = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tables: [] }),
    }) as jest.MockedFunction<typeof fetch>;
    const source = createApplicationInsightsGroundingMetricsSource({
      environment: {
        APPLICATIONINSIGHTS_APPLICATION_ID: 'application-id',
      },
      fetch: request,
      getAccessToken: jest.fn().mockResolvedValue('managed-identity-token'),
    });

    await source.loadSample(
      'interviews-documents',
      "Apex' | take 1 //",
    );

    const requestBody = JSON.parse(
      String((request.mock.calls[0][1] as RequestInit).body),
    ) as { query: string };
    expect(requestBody.query).toContain(
      "tostring(customDimensions.caller) in ('interview', 'prd', 'design-doc')",
    );
    expect(requestBody.query).toContain(
      "tostring(customDimensions.project) == 'Apex'' | take 1 //'",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
