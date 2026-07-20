/**
 * Authentication helpers for E2E tests.
 *
 * Uses the non-production /auth/dev-login endpoint to create a server session
 * without Azure AD. The resulting session cookie is stored in the Playwright
 * browser context and forwarded automatically to all subsequent requests.
 */
import type { Page } from '@playwright/test';
import type { Persona } from './fixtures';

/**
 * Log the browser page session in as a dev persona.
 * Calls POST /auth/dev-login (Vite proxy → Express) and relies on the
 * Set-Cookie header being forwarded back to the browser context.
 */
export async function devLogin(page: Page, persona: Persona): Promise<void> {
  const response = await page.request.post('/auth/dev-login', {
    data: { persona },
  });

  if (!response.ok()) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `[E2E] dev-login failed for persona "${persona}": HTTP ${response.status()} — ${body}`,
    );
  }
}
