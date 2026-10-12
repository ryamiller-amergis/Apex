import {
  issueInteractiveToolProxyToken,
  verifyInteractiveToolProxyToken,
} from '../services/interactiveToolProxyToken';

const SECRET = 'unit-test-session-secret-with-sufficient-entropy';
const NOW = new Date('2026-09-23T15:00:00.000Z');
const CLAIMS = {
  runId: 'run-1',
  attemptId: 'attempt-1',
  dispatchMessageId: 'fence-1',
  serverName: 'ado-skills',
  expiresAt: '2026-09-23T16:00:00.000Z',
} as const;

describe('interactiveToolProxyToken', () => {
  it('issues and verifies a run-bound token', () => {
    const token = issueInteractiveToolProxyToken(CLAIMS, SECRET);

    expect(verifyInteractiveToolProxyToken(token, SECRET, NOW)).toMatchObject({
      runId: 'run-1',
      serverName: 'ado-skills',
    });
    expect(() => verifyInteractiveToolProxyToken(`${token}x`, SECRET, NOW)).toThrow(
      'Invalid interactive tool proxy signature',
    );
  });

  it('rejects expired tokens', () => {
    const token = issueInteractiveToolProxyToken(CLAIMS, SECRET);
    expect(() =>
      verifyInteractiveToolProxyToken(
        token,
        SECRET,
        new Date('2026-09-23T16:00:00.000Z'),
      ),
    ).toThrow('Interactive tool proxy token expired');
  });

  it('rejects claim tampering that changes run/attempt/fence/server', () => {
    const token = issueInteractiveToolProxyToken(CLAIMS, SECRET);
    const [payload] = token.split('.');
    const body = JSON.parse(
      Buffer.from(
        payload.replace(/-/g, '+').replace(/_/g, '/'),
        'base64',
      ).toString('utf8'),
    ) as Record<string, string>;
    body.runId = 'run-other';
    const tampered = `${Buffer.from(JSON.stringify(body))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')}.${token.split('.')[1]}`;

    expect(() => verifyInteractiveToolProxyToken(tampered, SECRET, NOW)).toThrow(
      'Invalid interactive tool proxy signature',
    );
  });

  it('requires SESSION_SECRET with no fallback', () => {
    expect(() => issueInteractiveToolProxyToken(CLAIMS, '')).toThrow(
      /SESSION_SECRET/,
    );
  });
});
