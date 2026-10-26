/**
 * PBI-001 AC-0..AC-2 and TBI-003 DoD-0 / VT-14..VT-18.
 */
import fs from 'fs';
import path from 'path';
import {
  RedactionError,
  knownSecretsFromEnv,
  redactJson,
  redactText,
} from '../services/buildRedactionService';

const emptySecrets = () => [] as const;

const bearer = ['Bear', 'er sk_live_', 'abcdefghij'].join('');
const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signaturevalue'].join('.');
const urlSecret = ['postgres://app:', 'sup3rsecret', '@db.internal/apex'].join('');
const adoSecret = ['Server=db.internal;Database=apex;Pass', 'word=sup3rsecret'].join('');
const accountSecret = ['AccountKey=', 'abcDEF1234567890+/=='].join('');
const pem = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQ==',
  '-----END PRIVATE KEY-----',
].join('\n');
const known = ['known-', 'secret-value'].join('');

describe('VT-14 redaction removes each secret class', () => {
  it('VT-14 / AC-0 / DoD-0 redacts text and names the class', () => {
    const input = [
      `prefix ${bearer} middle`,
      jwt,
      urlSecret,
      adoSecret,
      accountSecret,
      pem,
      'password=hunter22',
      `tail ${known}`,
    ].join('\n');
    const output = redactText(input, { knownSecrets: () => [known] });
    for (const secret of [bearer, jwt, urlSecret, adoSecret, accountSecret, pem, 'hunter22', known]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED:bearer-token]');
    expect(output).toContain('[REDACTED:jwt]');
    expect(output).toContain('[REDACTED:connection-string]');
    expect(output).toContain('[REDACTED:private-key]');
    expect(output).toContain('[REDACTED:secret-key]');
    expect(output).toContain('[REDACTED:known-secret]');
    expect(output.startsWith('prefix ')).toBe(true);
    expect(output.endsWith('[REDACTED:known-secret]')).toBe(true);
  });

  it('VT-14 / AC-0 redacts JSON leaves and secret-like keys', () => {
    const output = redactJson({
      note: `see ${bearer}`,
      password: 'hunter22',
      apiKey: 'abcdEFGH1234',
      client_secret: 'clientsecretvalue',
      nested: { ok: 'plain text' },
    }, { knownSecrets: emptySecrets });
    expect(JSON.stringify(output)).not.toContain(bearer);
    expect(JSON.stringify(output)).not.toContain('hunter22');
    expect(JSON.stringify(output)).not.toContain('abcdEFGH1234');
    expect(JSON.stringify(output)).not.toContain('clientsecretvalue');
    expect(output.password).toBe('[REDACTED:secret-key]');
    expect(output.apiKey).toBe('[REDACTED:secret-key]');
    expect(output.client_secret).toBe('[REDACTED:secret-key]');
    expect(output.note).toContain('[REDACTED:bearer-token]');
    expect(output.nested.ok).toBe('plain text');
  });
});

describe('VT-15 ordinary text stays unchanged', () => {
  it('VT-15 / AC-2 / DoD-0 keeps prose, hashes, and a 32-character word', () => {
    const ordinary = [
      'The build compiled the widget and wrote the log.',
      'sha 0123456789abcdef0123456789abcdef01234567',
      'id 6f1e2d3c-4b5a-6978-90ab-cdef12345678',
      'abcdefghijklmnopqrstuvwxyz012345',
      'monkey tokenizer',
    ].join('\n');
    expect(ordinary).toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(redactText(ordinary, { knownSecrets: emptySecrets })).toBe(ordinary);
  });
});

describe('VT-16 redaction stays fast on a 100 KB payload', () => {
  it('VT-16 / DoD perf median of 5 warm runs stays under 20 ms', () => {
    const benign = `${'log line with a hash 0123456789abcdef '.repeat(2000)}\n${bearer}\n`;
    const payload = benign.padEnd(100 * 1024, 'x').slice(0, 100 * 1024);
    const hostile = `${'='.repeat(50_000)}${'a'.repeat(50_000)}`;
    const time = (input: string) => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const start = performance.now();
        redactText(input, { knownSecrets: emptySecrets });
        samples.push(performance.now() - start);
      }
      samples.sort((left, right) => left - right);
      return samples[2];
    };
    const benignMs = time(payload);
    const hostileMs = time(hostile);
    expect(benignMs).toBeLessThan(20);
    expect(hostileMs).toBeLessThan(benignMs * 2 + 5);
  });
});

describe('VT-17 unprocessable input is refused', () => {
  it('VT-17 / AC-1 throws RedactionError without echoing the input', () => {
    const huge = 'z'.repeat(2 * 1024 * 1024 + 1);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const cases: unknown[] = [1, cycle, huge];
    for (const input of cases) {
      let thrown: unknown;
      try {
        if (typeof input === 'string' || typeof input === 'number') {
          redactText(input as string);
        }
        redactJson(input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RedactionError);
      expect((thrown as Error).message).toBe('Redaction cannot process this input');
      if (typeof input === 'string') expect((thrown as Error).message).not.toContain(input.slice(0, 32));
      if (typeof input === 'number') expect((thrown as Error).message).not.toContain(String(input));
    }
  });
});

describe('VT-18 known secrets come from setting names', () => {
  it('VT-18 / DoD-0 drops long secret-like settings and keeps the rest', () => {
    const cursor = 'cursor-api-key-value';
    const password = 'database-password';
    const secrets = knownSecretsFromEnv({
      CURSOR_API_KEY: cursor,
      DB_PASSWORD: password,
      PORT: '3000',
      SHORT_SECRET: 'abcde',
    });
    expect(secrets).toEqual(expect.arrayContaining([cursor, password]));
    expect(secrets).not.toContain('3000');
    expect(secrets).not.toContain('abcde');
    const output = redactText(`port 3000 and ${cursor} and ${password}`, { knownSecrets: () => secrets });
    expect(output).not.toContain(cursor);
    expect(output).not.toContain(password);
    expect(output).toContain('port 3000');
  });

  it('DoD-2 the redaction module does not import Drizzle', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../services/buildRedactionService.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/drizzle/);
  });
});
