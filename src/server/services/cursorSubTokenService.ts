/**
 * Mint short-lived Cursor user-scoped tokens from a team service-account API key.
 * Used for ADO Cloud Agent launches so repo access follows the developer's
 * connected Azure DevOps identity (same as the Cursor UI).
 */
import https from 'https';

const CURSOR_API_HOST = 'api.cursor.com';

export interface CursorApiKeyInfo {
  apiKeyName: string;
  createdAt?: string;
  userId?: number;
  userEmail?: string;
}

function cursorAuthHeader(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.startsWith('eyJ')) {
    return `Bearer ${trimmed}`;
  }
  return `Basic ${Buffer.from(`${trimmed}:`).toString('base64')}`;
}

function cursorApiGet(path: string, apiKey: string): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CURSOR_API_HOST,
        path,
        method: 'GET',
        headers: {
          Authorization: cursorAuthHeader(apiKey),
          Accept: 'application/json',
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: raw });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error(`Cursor API GET ${path} timed out`));
    });
    req.end();
  });
}

/** GET /v1/me — userEmail present means a user-scoped key/token. */
export async function fetchCursorApiKeyInfo(apiKey: string): Promise<CursorApiKeyInfo> {
  const { statusCode, body } = await cursorApiGet('/v1/me', apiKey);
  if (!statusCode || statusCode < 200 || statusCode >= 300) {
    let detail = body.trim();
    try {
      const errBody = JSON.parse(body) as { message?: string; error?: string };
      detail = errBody.message ?? errBody.error ?? detail;
    } catch {
      // keep raw body
    }
    throw new Error(`Cursor /v1/me ${statusCode ?? 'error'}: ${detail || 'request failed'}`);
  }
  try {
    return JSON.parse(body) as CursorApiKeyInfo;
  } catch {
    throw new Error('Cursor /v1/me JSON parse error');
  }
}

export interface MintCursorSubTokenInput {
  serviceAccountApiKey: string;
  forUserEmail: string;
}

export interface MintCursorSubTokenResult {
  accessToken: string;
  expiresAt: string;
  userId: number;
  teamId: number;
}

export async function mintCursorUserSubToken(
  input: MintCursorSubTokenInput,
): Promise<MintCursorSubTokenResult> {
  const email = input.forUserEmail.trim();
  if (!email) {
    throw new Error('forUserEmail is required to mint a Cursor user-scoped token.');
  }
  const apiKey = input.serviceAccountApiKey.trim();
  if (!apiKey) {
    throw new Error('CURSOR_API_KEY is not set');
  }

  const body = JSON.stringify({ forUserEmail: email });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CURSOR_API_HOST,
        path: '/v1/sub-tokens',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(raw) as MintCursorSubTokenResult;
              if (!parsed.accessToken) {
                reject(new Error('Cursor sub-token response missing accessToken'));
                return;
              }
              resolve(parsed);
            } catch {
              reject(new Error('Cursor sub-token JSON parse error'));
            }
            return;
          }
          let detail = raw.trim();
          try {
            const errBody = JSON.parse(raw) as { message?: string; error?: string };
            detail = errBody.message ?? errBody.error ?? detail;
          } catch {
            // keep raw body
          }
          reject(new Error(
            `Cursor sub-token ${res.statusCode ?? 'error'}: ${detail || 'request failed'}`,
          ));
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error('Cursor sub-token request timed out'));
    });
    req.write(body);
    req.end();
  });
}
