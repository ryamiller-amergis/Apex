/**
 * Shared programmatic Azure AD (Entra) SSO login for deployed-smoke.
 *
 * Used by the setup project (fresh session → storageState) and by fixtures when
 * a saved connect.sid is present but the server session is gone/empty
 * after a deployment, expiry, or backend reset.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/** Ephemeral session file consumed by the `deployed-smoke` Playwright project. */
export const DEPLOYED_AUTH_FILE = path.resolve(__dirname, '..', '.auth', 'deployed.json');

export function hasDeployedSsoCreds(): boolean {
  return Boolean(process.env.E2E_TEST_USER && process.env.E2E_TEST_PASSWORD);
}

export function isDeployedAuthMode(): boolean {
  return Boolean(
    process.env.E2E_STORAGE_STATE ||
      (process.env.E2E_TEST_USER && process.env.E2E_TEST_PASSWORD),
  );
}

/** True when the current browser context has a live Apex server session. */
export async function isServerAuthenticated(page: Page): Promise<boolean> {
  try {
    // Must use in-page fetch with credentials — page.request API calls do not
    // reliably attach the Secure HttpOnly connect.sid cookie the same way the SPA
    // does, which produced false negatives right after a successful Entra login
    // (UI showed project selector + user menu while this helper returned false).
    const body = await page.evaluate(async () => {
      const response = await fetch('/auth/status', { credentials: 'include' });
      if (!response.ok) return { authenticated: false };
      return (await response.json()) as { authenticated?: boolean };
    });
    return body.authenticated === true;
  } catch {
    return false;
  }
}

/**
 * Drive the real Amergis SSO / Entra form to an authenticated Apex session.
 * Leaves the page on the project selector or an authenticated app shell.
 */
export async function performEntraSsoLogin(page: Page): Promise<void> {
  const email = process.env.E2E_TEST_USER;
  const password = process.env.E2E_TEST_PASSWORD;

  if (!email || !password) {
    throw new Error(
      '[E2E SSO] E2E_TEST_USER and E2E_TEST_PASSWORD must be set for programmatic Entra login.',
    );
  }

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Already signed in (storageState still valid) — nothing to do.
  if (await isServerAuthenticated(page)) {
    const authenticatedLandmark = page
      .getByText(/select a project to start planning/i)
      .or(page.getByRole('navigation', { name: /main navigation/i }))
      .first();
    if (await authenticatedLandmark.isVisible().catch(() => false)) {
      return;
    }
  }

  // Cold login: may already be on the split-gate login, or need a fresh navigation.
  const ssoButton = page.getByRole('button', { name: /sign in with amergis sso/i });
  if (!(await ssoButton.isVisible().catch(() => false))) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }
  await ssoButton.click({ timeout: 30_000 });

  // Entra: email step (`#i0116` canonical; type=email fallback).
  const emailInput = page.locator('#i0116, input[type=email]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 60_000 });
  await emailInput.fill(email);
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  // Entra: password step.
  const passwordInput = page.locator('#i0118, input[type=password]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 60_000 });
  await passwordInput.fill(password);
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  // Optional "Stay signed in?" (KMSI) — best-effort, must never fail the login.
  try {
    const staySignedIn = page.locator('#idSIButton9');
    await staySignedIn.waitFor({ state: 'visible', timeout: 15_000 });
    await staySignedIn.click();
  } catch {
    // No KMSI prompt.
  }

  await page.waitForURL(
    (url) => !/login\.microsoftonline\.com|login\.live\.com/.test(url.host),
    { timeout: 60_000 },
  );
  await expect(
    page
      .getByText(/select a project to start planning/i)
      .or(page.getByRole('navigation', { name: /main navigation/i }))
      .or(page.getByTestId('nav-item-calendar'))
      .first(),
  ).toBeVisible({ timeout: 60_000 });

  if (!(await isServerAuthenticated(page))) {
    throw new Error(
      '[E2E SSO] Entra login completed but /auth/status still returns authenticated:false.',
    );
  }
}

/** Persist the current context cookies/origins for later deployed-smoke workers. */
export async function saveDeployedStorageState(context: BrowserContext): Promise<void> {
  fs.mkdirSync(path.dirname(DEPLOYED_AUTH_FILE), { recursive: true });
  await context.storageState({ path: DEPLOYED_AUTH_FILE });
  console.log(`[E2E SSO] Saved programmatic SSO session to ${DEPLOYED_AUTH_FILE}`);
}

/**
 * Load the saved storageState in a brand-new context and confirm the server
 * still recognizes the session. Catches FileStore races where the setup
 * browser looked authenticated but the session file is already empty/missing.
 */
export async function assertStorageStateAuthenticates(browser: Browser): Promise<void> {
  if (!fs.existsSync(DEPLOYED_AUTH_FILE)) {
    throw new Error(`[E2E SSO] Expected storageState at ${DEPLOYED_AUTH_FILE} but file is missing.`);
  }

  const context = await browser.newContext({
    storageState: DEPLOYED_AUTH_FILE,
    baseURL: process.env.E2E_BASE_URL,
  });
  try {
    const page = await context.newPage();
    // Need a document origin before in-page fetch can hit /auth/status.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const ok = await isServerAuthenticated(page);
    if (!ok) {
      throw new Error(
        '[E2E SSO] storageState was written but a fresh context gets ' +
          '/auth/status → authenticated:false (server session missing/empty). ' +
          'Likely session expiry, backend reset, or instance recycle on the target env.',
      );
    }
  } finally {
    await context.close();
  }
}

/**
 * Ensure the current page context has a live server session.
 * Re-runs Entra SSO and refreshes deployed.json when the cookie is stale.
 */
export async function ensureDeployedServerSession(page: Page): Promise<void> {
  // In-page auth check needs a document on the app origin.
  if (page.url() === 'about:blank' || !page.url().startsWith('http')) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  if (await isServerAuthenticated(page)) {
    return;
  }

  console.warn(
    '[E2E SSO] storageState cookie present but server session is not authenticated — re-running Entra login.',
  );
  await performEntraSsoLogin(page);
  await saveDeployedStorageState(page.context());
}
