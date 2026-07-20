/**
 * Programmatic Azure AD (Entra) SSO login for deployed-smoke runs.
 *
 * This is a Playwright *setup project* (see playwright.config.ts). It runs once,
 * before the `deployed-smoke` project, whenever we target a deployed dev/staging
 * site with SSO credentials in the environment. It performs a FULLY-AUTOMATED,
 * headless SSO login against the real Microsoft/Entra login form using a
 * dedicated Azure AD test account, then persists the authenticated session to an
 * EPHEMERAL, gitignored storageState file that is produced fresh every run.
 *
 * There is NO manually-captured or secret session blob: the session is generated
 * programmatically each run from `E2E_TEST_USER` + `E2E_TEST_PASSWORD`.
 *
 * ── MFA / conditional-access prerequisite ──────────────────────────────────────
 * Programmatic login cannot clear an interactive MFA challenge or a
 * conditional-access prompt. The dedicated E2E test account MUST be exempted from
 * MFA / conditional access for the environments under test (e.g. via a named
 * location / trusted-IP exclusion, or a security-group exclusion on the CA
 * policy). Without that exemption this setup will hang on the MFA screen and the
 * run will time out. See tests/e2e/README.md → Environments.
 *
 * ── Tenant-specific selectors ──────────────────────────────────────────────────
 * The Entra login page markup varies slightly per tenant and over time. The
 * selectors below use the well-known Entra element ids (`#i0116`, `#i0118`,
 * `#idSIButton9`) with generic-type fallbacks (`input[type=email]`,
 * `input[type=password]`). If Amergis's tenant customises the login page these
 * MAY NEED PER-TENANT ADJUSTMENT — update the locators here and nowhere else.
 */
import { test as setup, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// Ephemeral session file, produced fresh each run. Must match the storageState
// path consumed by the `deployed-smoke` project in playwright.config.ts.
// __dirname === tests/e2e/support, so .auth lives one level up (tests/e2e/.auth).
const authFile = path.resolve(__dirname, '..', '.auth', 'deployed.json');

setup('authenticate via Azure AD SSO', async ({ page }) => {
  const email = process.env.E2E_TEST_USER;
  const password = process.env.E2E_TEST_PASSWORD;

  if (!email || !password) {
    throw new Error(
      '[E2E setup] E2E_TEST_USER and E2E_TEST_PASSWORD must be set to run the ' +
        'deployed SSO setup project. These are the dedicated Azure AD test account ' +
        'credentials used for programmatic login against dev/staging.',
    );
  }

  // Interactive redirects to Entra and back can be slow — be generous.
  setup.setTimeout(180_000);

  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  // 1. Load the app and kick off the real Amergis SSO redirect.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /sign in with amergis sso/i })
    .click({ timeout: 30_000 });

  // 2. Entra: email / "Enter your email" step.
  //    `#i0116` is the canonical Entra email field; `input[type=email]` is the
  //    generic fallback. Adjust per-tenant if the login page is customised.
  const emailInput = page.locator('#i0116, input[type=email]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 60_000 });
  await emailInput.fill(email);
  // `#idSIButton9` is the shared Entra "Next" / "Sign in" / "Yes" primary button.
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  // 3. Entra: password step.
  const passwordInput = page.locator('#i0118, input[type=password]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: 60_000 });
  await passwordInput.fill(password);
  await page.locator('#idSIButton9, input[type=submit]').first().click();

  // 4. "Stay signed in?" (KMSI) prompt — optional; may be disabled per tenant.
  //    Click "Yes" (`#idSIButton9`) if it appears; otherwise continue. This is a
  //    best-effort step and must never fail the login.
  try {
    const staySignedIn = page.locator('#idSIButton9');
    await staySignedIn.waitFor({ state: 'visible', timeout: 15_000 });
    await staySignedIn.click();
  } catch {
    // No KMSI prompt shown — nothing to do.
  }

  // 5. Wait for the redirect back to the app in an authenticated state. The app
  //    shell renders either the project selector or the sidebar/home once the
  //    server session is established. We assert on a stable authenticated
  //    landmark rather than a URL so the check is resilient to routing.
  await page.waitForURL((url) => !/login\.microsoftonline\.com|login\.live\.com/.test(url.host), {
    timeout: 60_000,
  });
  await expect(
    page
      .getByText(/select a project to start planning/i)
      .or(page.getByTestId('nav-item-calendar'))
      .first(),
  ).toBeVisible({ timeout: 60_000 });

  // 6. Persist the authenticated session for the deployed-smoke project.
  await page.context().storageState({ path: authFile });
  console.log(`[E2E setup] Saved programmatic SSO session to ${authFile}`);
});
