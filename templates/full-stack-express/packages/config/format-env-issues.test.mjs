import { describe, expect, it } from 'vitest';
import { formatEnvIssues } from './format-env-issues.mjs';

const secrets = new Set(['DATABASE_URL']);

describe('formatEnvIssues', () => {
  it('VT-04 lists one sorted line per variable and hides secret values', () => {
    const source = {
      PORT: 'abc',
      DATABASE_URL: 'postgresql://app_user:SENTINEL_VALUE_123@localhost/db',
    };
    const message = formatEnvIssues(
      [
        { path: ['PORT'], message: 'expected an integer from 1 to 65535' },
        {
          path: ['DATABASE_URL'],
          message: 'expected a postgres or postgresql URL',
        },
      ],
      source,
      secrets
    );

    expect(message).toBe(
      [
        'Invalid environment configuration (2 problems):',
        '  - DATABASE_URL: set but invalid (value hidden)',
        '  - PORT: set but invalid (expected an integer from 1 to 65535)',
        'See .env.example for every variable.',
      ].join('\n')
    );
    expect(message).not.toContain('SENTINEL_VALUE_123');
  });

  it('VT-04 treats an empty string as unset', () => {
    const message = formatEnvIssues(
      [
        {
          path: ['DATABASE_URL'],
          message: 'expected a postgres or postgresql URL',
        },
      ],
      { DATABASE_URL: '' },
      secrets
    );

    expect(message).toContain('DATABASE_URL: required but not set');
    expect(message).not.toContain('value hidden');
  });

  it('VT-04 uses one line when a variable has several issues', () => {
    const message = formatEnvIssues(
      [
        { path: ['PORT'], message: 'first' },
        { path: ['PORT'], message: 'second' },
      ],
      { PORT: 'abc' },
      secrets
    );

    expect(message).toContain('Invalid environment configuration (1 problem):');
    expect(message.match(/PORT:/g)).toHaveLength(1);
  });
});
