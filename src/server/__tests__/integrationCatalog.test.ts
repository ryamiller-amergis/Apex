import { PREBUILT_CONNECTORS, PREBUILT_PROVIDER_IDS } from '../../shared/types/integrations';

describe('integration catalog (SC-3)', () => {
  it('SC-3 ships Clerk, Pendo, and SendGrid as fixed read-only catalogs', () => {
    expect(PREBUILT_PROVIDER_IDS).toEqual(['clerk', 'pendo', 'sendgrid']);
    for (const provider of PREBUILT_PROVIDER_IDS) {
      const connector = PREBUILT_CONNECTORS[provider];
      expect(connector.operations.length).toBeGreaterThan(0);
      expect(connector.testRequest.method).toBe('GET');
      for (const operation of connector.operations) {
        expect(operation.method).toBe('GET');
        expect(operation.readOnly).toBe(true);
      }
    }
  });
});
