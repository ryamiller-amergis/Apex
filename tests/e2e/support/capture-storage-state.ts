/**
 * One-time SSO storageState capture for deployed-smoke runs.
 *
 * Staging and prod (and any NODE_ENV=production deployment) do NOT expose
 * /auth/dev-login, so authenticated smoke tests there must reuse a real,
 * interactively-obtained SSO session. This script opens a HEADED browser to
 * E2E_BASE_URL, lets a human complete the real Azure/Entra SSO login for the
 * dedicated test account, then saves the resulting cookies/localStorage to a
 * gitignored storageState JSON file.
 *
 * The agent cannot perform interactive SSO — a human runs this once per
 * environment and re-runs it whenever the session expires.
 *
 * Usage (PowerShell):
 *   $env:E2E_BASE_URL="https://app-apex-prd.azurewebsites.net"
 *   $env:E2E_STORAGE_STATE="tests/e2e/.auth/prod.storageState.json"   # optional
 *   npm run test:e2e:auth:capture
 *
 * Then run smoke against that env:
 *   $env:E2E_STORAGE_STATE="tests/e2e/.auth/prod.storageState.json"
 *   npx playwright test --project=deployed-smoke --grep "@prod-safe"
 */
import { chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import readline from 'readline';

const DEFAULT_OUTPUT = path.join('tests', 'e2e', '.auth', 'storageState.json');

function waitForEnter(promptText: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const baseURL = process.env.E2E_BASE_URL;
  if (!baseURL) {
    console.error(
      '[capture] E2E_BASE_URL is required. Set it to the deployed site you want to ' +
        'authenticate against, e.g. https://app-apex-prd.azurewebsites.net',
    );
    process.exit(1);
  }

  const outputPath = path.resolve(process.env.E2E_STORAGE_STATE || DEFAULT_OUTPUT);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  console.log(`[capture] Opening a headed browser to ${baseURL}`);
  console.log('[capture] Complete the Amergis SSO login for the E2E test account in the window.');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

  await waitForEnter(
    '\n[capture] After you are fully logged in (the app shell is visible), ' +
      'press ENTER here to save the session... ',
  );

  await context.storageState({ path: outputPath });
  console.log(`[capture] storageState saved to ${outputPath}`);
  console.log('[capture] This file is gitignored — never commit it or share it.');

  await browser.close();
}

main().catch((err) => {
  console.error('[capture] Failed:', err);
  process.exit(1);
});
