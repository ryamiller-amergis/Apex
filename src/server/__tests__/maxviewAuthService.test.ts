import {
  extractAntiforgeryToken,
  parseSetCookies,
  buildCookieHeader,
  normalizeToken,
  decodeJwtExpMs,
  isMaxviewConfigured,
  maxviewRejectUnauthorized,
} from '../services/maxviewAuthService';

describe('maxviewAuthService helpers', () => {
  describe('extractAntiforgeryToken', () => {
    it('scrapes the __RequestVerificationToken hidden field value', () => {
      const html =
        '<form><input name="__RequestVerificationToken" type="hidden" value="ABC123-token_value" /></form>';
      expect(extractAntiforgeryToken(html)).toBe('ABC123-token_value');
    });

    it('returns null when the field is absent', () => {
      expect(extractAntiforgeryToken('<html><body>no form here</body></html>')).toBeNull();
    });
  });

  describe('parseSetCookies / buildCookieHeader', () => {
    it('parses cookie name/value pairs and ignores attributes', () => {
      const jar = parseSetCookies([
        '.AspNetCore.Antiforgery.xyz=abc; path=/; secure; samesite=strict; httponly',
        '.AspNetCore.Cookies=authvalue; path=/; httponly',
      ]);
      expect(jar).toEqual({
        '.AspNetCore.Antiforgery.xyz': 'abc',
        '.AspNetCore.Cookies': 'authvalue',
      });
    });

    it('returns an empty jar for undefined input', () => {
      expect(parseSetCookies(undefined)).toEqual({});
    });

    it('serializes a jar into a Cookie header', () => {
      expect(buildCookieHeader({ a: '1', b: '2' })).toBe('a=1; b=2');
    });
  });

  describe('normalizeToken', () => {
    it('strips surrounding JSON quotes and whitespace', () => {
      expect(normalizeToken('"the.jwt.token"')).toBe('the.jwt.token');
      expect(normalizeToken('  raw.token  ')).toBe('raw.token');
    });
  });

  describe('decodeJwtExpMs', () => {
    it('decodes the exp claim to epoch milliseconds', () => {
      const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString('base64url');
      const token = `header.${payload}.signature`;
      expect(decodeJwtExpMs(token)).toBe(1_700_000_000_000);
    });

    it('returns null for a malformed token', () => {
      expect(decodeJwtExpMs('not-a-jwt')).toBeNull();
    });

    it('returns null when exp is missing', () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url');
      expect(decodeJwtExpMs(`h.${payload}.s`)).toBeNull();
    });
  });

  describe('isMaxviewConfigured / maxviewRejectUnauthorized', () => {
    const original = { ...process.env };
    afterEach(() => {
      process.env = { ...original };
    });

    it('is false without a base URL', () => {
      delete process.env.MAXVIEW_MCP_BASE_URL;
      expect(isMaxviewConfigured()).toBe(false);
    });

    it('is true with a static token', () => {
      process.env.MAXVIEW_MCP_BASE_URL = 'https://maxview.example';
      process.env.MAXVIEW_MCP_TOKEN = 'static-token';
      expect(isMaxviewConfigured()).toBe(true);
    });

    it('is true with service credentials', () => {
      process.env.MAXVIEW_MCP_BASE_URL = 'https://maxview.example';
      delete process.env.MAXVIEW_MCP_TOKEN;
      process.env.MAXVIEW_MCP_USERNAME = 'svc';
      process.env.MAXVIEW_MCP_PASSWORD = 'pw';
      expect(isMaxviewConfigured()).toBe(true);
    });

    it('is false with only a username', () => {
      process.env.MAXVIEW_MCP_BASE_URL = 'https://maxview.example';
      delete process.env.MAXVIEW_MCP_TOKEN;
      process.env.MAXVIEW_MCP_USERNAME = 'svc';
      delete process.env.MAXVIEW_MCP_PASSWORD;
      expect(isMaxviewConfigured()).toBe(false);
    });

    it('rejects unauthorized by default and honors the insecure opt-out', () => {
      delete process.env.MAXVIEW_MCP_INSECURE_TLS;
      expect(maxviewRejectUnauthorized()).toBe(true);
      process.env.MAXVIEW_MCP_INSECURE_TLS = 'true';
      expect(maxviewRejectUnauthorized()).toBe(false);
    });
  });
});
