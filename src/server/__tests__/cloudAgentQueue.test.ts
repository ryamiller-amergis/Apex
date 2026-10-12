import {
  DEFAULT_CLOUD_AGENT_RUN_LIMIT_MS,
  resolveCloudAgentRunLimitMs,
} from '../services/cloudAgentQueue';

describe('cloud agent run limit', () => {
  it('times out running runs after the six-hour turn unless the environment overrides it', () => {
    expect(DEFAULT_CLOUD_AGENT_RUN_LIMIT_MS).toBeGreaterThan(6 * 60 * 60_000);
    expect(resolveCloudAgentRunLimitMs(undefined)).toBe(DEFAULT_CLOUD_AGENT_RUN_LIMIT_MS);
    expect(resolveCloudAgentRunLimitMs('0')).toBe(DEFAULT_CLOUD_AGENT_RUN_LIMIT_MS);
    expect(resolveCloudAgentRunLimitMs('3600000')).toBe(3_600_000);
  });
});
