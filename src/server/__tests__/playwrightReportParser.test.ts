import { parsePlaywrightReportHtml } from '../utils/playwrightReportParser';

describe('playwrightReportParser', () => {
  it('returns null when template tag is missing', async () => {
    await expect(parsePlaywrightReportHtml('<html></html>')).resolves.toBeNull();
  });

  it('returns null when embedded zip is invalid', async () => {
    const html = '<template id="playwrightReportBase64">data:application/zip;base64,not-a-zip</template>';
    await expect(parsePlaywrightReportHtml(html)).resolves.toBeNull();
  });
});

describe('suiteKeyFromArtifactName', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { suiteKeyFromArtifactName } = require('../services/e2eBurnDownService') as typeof import('../services/e2eBurnDownService');

  it('maps known artifact names', () => {
    expect(suiteKeyFromArtifactName('PlaywrightReport_quick_smoke')).toBe('quick_smoke');
    expect(suiteKeyFromArtifactName('PlaywrightReport_timecard_validation')).toBe('timecard_validation');
  });

  it('returns null for unknown artifacts', () => {
    expect(suiteKeyFromArtifactName('eslint-burn-down')).toBeNull();
  });
});
