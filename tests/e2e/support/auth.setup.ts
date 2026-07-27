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
 * The Entra login page markup varies slightly per tenant and over time. Selectors
 * live in `sso-login.ts` (well-known Entra ids `#i0116`, `#i0118`, `#idSIButton9`
 * with generic fallbacks). If Amergis's tenant customises the login page, update
 * the locators there and nowhere else.
 */
import { test as setup } from '@playwright/test';
import {
  assertStorageStateAuthenticates,
  hasDeployedSsoCreds,
  performEntraSsoLogin,
  saveDeployedStorageState,
} from './sso-login';

setup('authenticate via Azure AD SSO', async ({ page, browser }) => {
  if (!hasDeployedSsoCreds()) {
    throw new Error(
      '[E2E setup] E2E_TEST_USER and E2E_TEST_PASSWORD must be set to run the ' +
        'deployed SSO setup project. These are the dedicated Azure AD test account ' +
        'credentials used for programmatic login against dev/staging.',
    );
  }

  // Interactive redirects to Entra and back can be slow — be generous.
  setup.setTimeout(180_000);

  let lastVerifyError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await performEntraSsoLogin(page);
    await saveDeployedStorageState(page.context());

    // Confirm a *fresh* context can authenticate with the saved blob. Catches the
    // failure mode where the setup page looked logged-in but the FileStore session
    // was already empty/missing (connect.sid sent → /auth/status authenticated:false).
    try {
      await assertStorageStateAuthenticates(browser);
      lastVerifyError = undefined;
      break;
    } catch (err) {
      lastVerifyError = err;
      console.warn(
        `[E2E setup] storageState verification failed on attempt ${attempt}/2 — retrying Entra login.`,
      );
      await page.context().clearCookies();
    }
  }

  if (lastVerifyError) {
    throw lastVerifyError;
  }
});
