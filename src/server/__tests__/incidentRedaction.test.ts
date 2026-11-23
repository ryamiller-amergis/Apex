/**
 * Unit tests for incidentRedaction. Fixtures are synthetic; none is real incident text.
 */

import { describeErrorForLog, redactForTeams, redactIncidentText } from '../services/incidentRedaction';

describe('incidentRedaction', () => {
  it('masks email addresses', () => {
    expect(redactIncidentText('Contact jane.doe+test@example.org or ops@sub.example.com today')).toBe(
      'Contact [email] or [email] today',
    );
  });

  it('masks US phone formats', () => {
    const forms = ['8135550142', '(813) 555-0142', '813-555-0142', '+1 813 555 0142', '813.555.0142'];
    for (const form of forms) {
      expect(redactIncidentText(`Call me at ${form} please`)).toBe('Call me at [phone] please');
    }
  });

  it('masks ids in parentheses and long digit runs', () => {
    expect(redactIncidentText('Sample Person (5301234) cannot clock in')).toBe(
      'Sample Person [id] cannot clock in',
    );
    expect(redactIncidentText('Candidate 1234567 and 98765432 are affected')).toBe(
      'Candidate [id] and [id] are affected',
    );
  });

  it('keeps ordinary numbers and incident numbers', () => {
    expect(redactIncidentText('INC0012345 failed 3 times on 2026-11-20 with code 500')).toBe(
      'INC0012345 failed 3 times on 2026-11-20 with code 500',
    );
  });

  it('masks SSN-like numbers', () => {
    expect(redactIncidentText('SSN 123-45-6789 was pasted')).toBe('SSN [ssn] was pasted');
  });

  it('drops URL query strings and bearer tokens', () => {
    expect(redactIncidentText('Open https://example.test/page/1?token=abc123&user=x now')).toBe(
      'Open https://example.test/page/1 now',
    );
    expect(redactIncidentText('Header was Authorization: Bearer eyJhbGciOi.abc-def_123')).toBe(
      'Header was Authorization: Bearer [token]',
    );
  });

  it('keeps MaxView error text intact', () => {
    const text = 'This email already has a Clerk account. The HCP should sign in with those credentials.';
    expect(redactIncidentText(text)).toBe(text);
  });

  it('returns null for null and undefined', () => {
    expect(redactIncidentText(null)).toBeNull();
    expect(redactIncidentText(undefined)).toBeNull();
  });

  it('is idempotent', () => {
    const text =
      'Sample Person (5301234) at jane@example.org, 813-555-0142, SSN 123-45-6789, ' +
      'id 7654321, https://example.test/a?x=1, Bearer abcdefgh12345678';
    const once = redactIncidentText(text);
    expect(once).not.toBeNull();
    expect(redactIncidentText(once)).toBe(once);
  });

  describe('describeErrorForLog', () => {
    it('keeps the error name and code and drops the message', () => {
      const error = Object.assign(new Error('select * where id = $1 -- secret-value'), { code: '23505' });
      expect(describeErrorForLog(error)).toBe('Error (23505)');
      expect(describeErrorForLog(new TypeError('secret-value'))).toBe('TypeError');
      expect(describeErrorForLog('secret-value')).toBe('unknown error');
    });
  });

  describe('redactForTeams', () => {
    it('truncates and collapses whitespace', () => {
      const text = 'Line one\n\n  line   two for jane@example.org and more words follow here';
      expect(redactForTeams(text, 200)).toBe('Line one line two for [email] and more words follow here');
      const short = redactForTeams(text, 20);
      expect(short).toHaveLength(20);
      expect(short.endsWith('…')).toBe(true);
      expect(short).toBe('Line one line two f…');
    });

    it('returns an empty string for missing text', () => {
      expect(redactForTeams(null, 50)).toBe('');
      expect(redactForTeams(undefined, 50)).toBe('');
    });

    it('markdown links reduced to text', () => {
      expect(redactForTeams('See [the runbook](https://evil.example/login) now', 200)).toBe('See the runbook now');
      expect(redactForTeams('Look ![chart](https://evil.example/a.png) here', 200)).toBe('Look chart here');
    });

    it('bare URLs removed', () => {
      expect(redactForTeams('Open https://evil.example/login or http://x.test/a and www.evil.example/b', 200)).toBe(
        'Open [link] or [link] and [link]',
      );
    });

    it('escapes brackets and parentheses that remain, and keeps the redaction placeholders', () => {
      expect(redactForTeams('Use [x] and (y) for jane@example.org', 200)).toBe('Use \\[x\\] and \\(y\\) for [email]');
    });

    it('a link built from text and parentheses cannot render', () => {
      const text = redactForTeams('[click](javascript:alert(1)) [a] (b) [id](http://evil.example)', 200);
      expect(text).not.toMatch(/(?<!\\)\]\(/);
      expect(text).not.toContain('evil.example');
    });
  });
});
