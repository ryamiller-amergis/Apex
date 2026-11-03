import { createHash } from 'node:crypto';
import {
  assertOAuthPending,
  authorizationServerMetadataUrl,
  buildOAuthAuthorizationUrl,
  createPkcePair,
  devAppOrigin,
  discoverMcpOAuth,
  ensureFreshOAuthCredential,
  exchangeAuthorizationCode,
  parseResourceMetadataUrl,
  refreshOAuthTokens,
  safeAppOrigin,
  wellKnownResourceMetadataUrl,
} from '../services/mcpServerOAuth';
import { buildRemoteMcpCredential, publicRemoteConfig, resolveRemoteMcpHeaders } from '../services/mcpServerDiscovery';
import type { RemoteMcpOAuth } from '../services/mcpServerDiscovery';

jest.mock('../services/mcpServerOpenApi', () => ({
  assertResolvedPublicHttpsUrl: async (value: string) => new URL(value),
}));

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
} {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

describe('MCP OAuth', () => {
  it('sends a local API callback back to the app', () => {
    expect(safeAppOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(safeAppOrigin('https://apex.example', 'apex.example')).toBe('https://apex.example');
    expect(safeAppOrigin('https://evil.example', 'apex.example')).toBeNull();
    expect(safeAppOrigin('http://evil.example')).toBeNull();
    expect(safeAppOrigin('http://localhost:3000/mcp-servers')).toBeNull();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    expect(devAppOrigin('localhost:3001')).toBe('http://localhost:3000');
    process.env.NODE_ENV = 'production';
    expect(devAppOrigin('localhost:3001')).toBeNull();
    process.env.NODE_ENV = previous;
  });

  it('reads the protected-resource address from a bearer challenge', () => {
    expect(parseResourceMetadataUrl(
      'Bearer resource_metadata="https://mcp.clerk.com/.well-known/oauth-protected-resource/mcp", scope="users:read"',
    )).toBe('https://mcp.clerk.com/.well-known/oauth-protected-resource/mcp');
    expect(wellKnownResourceMetadataUrl('https://mcp.example.com/mcp')).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
    );
    expect(authorizationServerMetadataUrl('https://clerk.example.com')).toBe(
      'https://clerk.example.com/.well-known/oauth-authorization-server',
    );
  });

  it('builds an authorization URL with PKCE and the MCP resource', () => {
    const pkce = createPkcePair();
    expect(createHash('sha256').update(pkce.verifier).digest('base64url')).toBe(pkce.challenge);
    const url = new URL(buildOAuthAuthorizationUrl({
      authorizationEndpoint: 'https://clerk.example.com/oauth/authorize',
      clientId: 'client-1',
      redirectUri: 'http://localhost:3000/api/projects/Apex/mcp-servers/1/oauth/callback',
      scopes: ['users:read'],
      resource: 'https://mcp.example.com/mcp',
      state: 'state-1',
      codeChallenge: pkce.challenge,
    }));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
  });

  it('rejects a callback whose state does not match the pending sign-in', () => {
    const oauth: RemoteMcpOAuth = {
      resource: 'https://mcp.example.com/mcp',
      authorizationEndpoint: 'https://clerk.example.com/oauth/authorize',
      tokenEndpoint: 'https://clerk.example.com/oauth/token',
      clientId: 'client-1',
      redirectUri: 'http://localhost/callback',
      scopes: [],
      pending: {
        state: 'expected-state',
        codeVerifier: 'verifier',
        startedBy: 'user-1',
        createdAt: new Date().toISOString(),
      },
    };
    expect(assertOAuthPending(oauth, { state: 'expected-state', userId: 'user-1' }).codeVerifier).toBe('verifier');
    expect(() => assertOAuthPending(oauth, { state: 'other-state', userId: 'user-1' })).toThrow('could not be verified');
    expect(() => assertOAuthPending(oauth, { state: 'expected-state', userId: 'user-2' })).toThrow('someone else');
  });

  it('discovers the authorization server from the MCP challenge', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url === 'https://mcp.example.com/mcp') {
        return jsonResponse(401, { error: 'Unauthorized' }, {
          'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
        });
      }
      if (url.endsWith('/oauth-protected-resource/mcp')) {
        return jsonResponse(200, {
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
          scopes_supported: ['users:read'],
        });
      }
      return jsonResponse(200, {
        authorization_endpoint: 'https://auth.example.com/oauth/authorize',
        token_endpoint: 'https://auth.example.com/oauth/token',
        registration_endpoint: 'https://auth.example.com/oauth/register',
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    });
    const discovered = await discoverMcpOAuth('https://mcp.example.com/mcp', fetchImpl);
    expect(discovered.authorizationEndpoint).toBe('https://auth.example.com/oauth/authorize');
    expect(discovered.scopes).toEqual(['users:read']);
    expect(discovered.usePublicClient).toBe(true);
  });

  it('exchanges a code and refreshes an expired token without returning the token publicly', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    }));
    const oauth: RemoteMcpOAuth = {
      resource: 'https://mcp.example.com/mcp',
      authorizationEndpoint: 'https://auth.example.com/oauth/authorize',
      tokenEndpoint: 'https://auth.example.com/oauth/token',
      clientId: 'client-1',
      redirectUri: 'http://localhost/callback',
      scopes: ['users:read'],
    };
    const tokens = await exchangeAuthorizationCode(oauth, 'code-1', 'verifier-1', fetchImpl);
    expect(tokens.accessToken).toBe('access-token');
    const body = String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code_verifier=verifier-1');

    const stored = buildRemoteMcpCredential({
      headers: { Authorization: 'Bearer ${CLERK_SECRET_KEY}' },
      secrets: [{ name: 'CLERK_SECRET_KEY', value: '' }],
      authMode: 'oauth',
    });
    stored.oauth = {
      ...oauth,
      accessToken: 'stale-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const fresh = await ensureFreshOAuthCredential(stored, async () => jsonResponse(200, {
      access_token: 'new-access',
      refresh_token: 'refresh-token',
      expires_in: 60,
    }));
    expect(resolveRemoteMcpHeaders(fresh).Authorization).toBe('Bearer new-access');
    expect(JSON.stringify(publicRemoteConfig(fresh))).not.toContain('new-access');
    expect(publicRemoteConfig(fresh).oauthConnected).toBe(true);
    await expect(refreshOAuthTokens({ ...oauth }, fetchImpl)).rejects.toThrow('Sign in with OAuth again.');
  });
});
