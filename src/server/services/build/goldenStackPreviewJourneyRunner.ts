import AxeBuilder from '@axe-core/playwright';
import { chromium, type Page } from '@playwright/test';

import type {
  BrowserA11yViolation,
  BrowserJourneyResult,
  BrowserJourneyRunner,
  BrowserJourneyStep,
  BrowserNetworkFailure,
} from './buildPreviewBrowserVerifier';

const MAX_FINDINGS = 50;
const TEST_IDS = {
  displayName: 'profile-display-name',
  email: 'profile-email',
  emailEmpty: 'profile-email-empty',
  editButton: 'profile-edit-button',
  displayNameInput: 'profile-display-name-input',
  emailInput: 'profile-email-input',
  saveButton: 'profile-save-button',
} as const;

interface OriginalProfile {
  displayName: string;
  email: string | null;
}

export function createGoldenStackPreviewJourneyRunner(options?: {
  timeoutMs?: number;
}): BrowserJourneyRunner {
  const timeoutMs = options?.timeoutMs ?? 30_000;

  return {
    async run(input): Promise<BrowserJourneyResult> {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const networkFailures: BrowserNetworkFailure[] = [];
      const a11yViolations: BrowserA11yViolation[] = [];
      const steps: BrowserJourneyStep[] = [];
      let screenshot: Buffer | null = null;
      let failure: string | undefined;
      let original: OriginalProfile | null = null;
      const browser = await chromium.launch({ headless: true });
      const context = await browser
        .newContext({
          baseURL: input.targetUrl,
          reducedMotion: 'reduce',
        })
        .catch(async (error: unknown) => {
          await browser.close();
          throw error;
        });
      const page = await context.newPage().catch(async (error: unknown) => {
        await context.close();
        await browser.close();
        throw error;
      });
      page.setDefaultTimeout(timeoutMs);
      observePage(page, { consoleErrors, pageErrors, networkFailures });

      const runStep = async (
        name: string,
        action: () => Promise<void>
      ): Promise<void> => {
        const started = Date.now();
        try {
          await action();
          steps.push({
            name,
            status: 'passed',
            durationMs: Date.now() - started,
          });
        } catch (error) {
          steps.push({
            name,
            status: 'failed',
            durationMs: Date.now() - started,
            detail: safeError(error),
          });
          throw error;
        }
      };

      try {
        await runStep('seeded-read', async () => {
          const profileResponse = page.waitForResponse(
            (response) =>
              response.request().method() === 'GET' &&
              new URL(response.url()).pathname === '/api/v1/me'
          );
          await page.goto('/profile', { waitUntil: 'domcontentloaded' });
          const response = await profileResponse;
          if (!response.ok()) {
            throw new Error(
              `Seeded profile returned HTTP ${response.status()}.`
            );
          }
          original = await readProfile(response, 'Seeded profile');
          await assertText(page, TEST_IDS.displayName, original.displayName);
          await assertText(
            page,
            original.email ? TEST_IDS.email : TEST_IDS.emailEmpty,
            original.email ?? 'No email on file'
          );
        });

        const suffix = input.checkId.replace(/[^a-zA-Z0-9]/g, '').slice(-12);
        const updated = {
          displayName: `Preview verifier ${suffix}`,
          email: `preview-${suffix.toLowerCase()}@example.test`,
        };

        await runStep('edit-save', async () => {
          await page.getByTestId(TEST_IDS.editButton).click();
          await page
            .getByTestId(TEST_IDS.displayNameInput)
            .fill(updated.displayName);
          await page.getByTestId(TEST_IDS.emailInput).fill(updated.email);
          const saveResponse = page.waitForResponse(
            (response) =>
              response.request().method() === 'PUT' &&
              new URL(response.url()).pathname === '/api/v1/me'
          );
          await page.getByTestId(TEST_IDS.saveButton).click();
          const response = await saveResponse;
          if (!response.ok()) {
            throw new Error(`Profile save returned HTTP ${response.status()}.`);
          }
          await assertText(page, TEST_IDS.displayName, updated.displayName);
          await assertText(page, TEST_IDS.email, updated.email);
        });

        await runStep('reload-persistence', async () => {
          const profileResponse = page.waitForResponse(
            (response) =>
              response.request().method() === 'GET' &&
              new URL(response.url()).pathname === '/api/v1/me'
          );
          await page.reload({ waitUntil: 'domcontentloaded' });
          const persisted = await readProfile(
            await profileResponse,
            'Reloaded profile'
          );
          if (
            persisted.displayName !== updated.displayName ||
            persisted.email !== updated.email
          ) {
            throw new Error(
              'Reloaded profile API did not return the saved values.'
            );
          }
          await assertText(page, TEST_IDS.displayName, updated.displayName);
          await assertText(page, TEST_IDS.email, updated.email);
        });

        await runStep('accessibility', async () => {
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze();
          a11yViolations.push(
            ...results.violations.slice(0, MAX_FINDINGS).map((violation) => ({
              id: violation.id,
              impact: violation.impact ?? null,
              nodeCount: violation.nodes.length,
            }))
          );
          if (results.violations.length > 0) {
            throw new Error(
              `Accessibility scan found ${results.violations.length} violation(s).`
            );
          }
        });

        await runStep('screenshot', async () => {
          screenshot = await page.screenshot({
            fullPage: true,
            type: 'png',
          });
        });
      } catch (error) {
        failure = safeError(error);
        if (!screenshot) {
          screenshot = await page
            .screenshot({ fullPage: true, type: 'png' })
            .catch(() => null);
        }
      } finally {
        if (original) {
          try {
            await runStep('restore-seed', async () => {
              const restore = await context.request.put('/api/v1/me', {
                data: original,
                failOnStatusCode: false,
              });
              if (!restore.ok()) {
                throw new Error(
                  `Profile restoration returned HTTP ${restore.status()}.`
                );
              }
              const restored = await readProfile(
                await context.request.get('/api/v1/me'),
                'Restored profile'
              );
              if (
                restored.displayName !== original!.displayName ||
                restored.email !== original!.email
              ) {
                throw new Error(
                  'Profile restoration did not restore the seeded values.'
                );
              }
            });
          } catch (error) {
            const restoreFailure = safeError(error);
            failure = failure
              ? `${failure} Restoration also failed: ${restoreFailure}`
              : restoreFailure;
          }
        }
        await context.close();
        await browser.close();
      }

      const passed =
        !failure &&
        steps.every((step) => step.status === 'passed') &&
        consoleErrors.length === 0 &&
        pageErrors.length === 0 &&
        networkFailures.length === 0 &&
        a11yViolations.length === 0 &&
        screenshot !== null;

      return {
        passed,
        screenshot,
        steps,
        consoleErrors,
        pageErrors,
        networkFailures,
        a11yViolations,
        ...(failure ? { failure } : {}),
      };
    },
  };
}

async function readProfile(
  response: {
    ok(): boolean;
    status(): number;
    json(): Promise<unknown>;
  },
  label: string
): Promise<OriginalProfile> {
  if (!response.ok()) {
    throw new Error(`${label} returned HTTP ${response.status()}.`);
  }
  const profile = (await response.json()) as {
    displayName?: unknown;
    email?: unknown;
  };
  if (
    typeof profile.displayName !== 'string' ||
    profile.displayName.trim() === '' ||
    (profile.email !== null &&
      profile.email !== undefined &&
      typeof profile.email !== 'string')
  ) {
    throw new Error(`${label} did not match the expected shape.`);
  }
  return {
    displayName: profile.displayName,
    email: typeof profile.email === 'string' ? profile.email : null,
  };
}

async function assertText(
  page: Page,
  testId: string,
  expected: string
): Promise<void> {
  const locator = page.getByTestId(testId);
  await locator.waitFor({ state: 'visible' });
  const actual = (await locator.textContent())?.trim();
  if (actual !== expected) {
    throw new Error(`Expected ${testId} to contain the persisted value.`);
  }
}

function observePage(
  page: Page,
  findings: {
    consoleErrors: string[];
    pageErrors: string[];
    networkFailures: BrowserNetworkFailure[];
  }
): void {
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      findings.consoleErrors.length < MAX_FINDINGS
    ) {
      findings.consoleErrors.push(safeText(message.text()));
    }
  });
  page.on('pageerror', (error) => {
    if (findings.pageErrors.length < MAX_FINDINGS) {
      findings.pageErrors.push(safeText(error.message));
    }
  });
  page.on('requestfailed', (request) => {
    if (findings.networkFailures.length < MAX_FINDINGS) {
      findings.networkFailures.push({
        method: request.method(),
        path: safePath(request.url()),
        failure: safeText(request.failure()?.errorText ?? 'Request failed'),
      });
    }
  });
  page.on('response', (response) => {
    if (
      response.status() >= 400 &&
      findings.networkFailures.length < MAX_FINDINGS
    ) {
      findings.networkFailures.push({
        method: response.request().method(),
        path: safePath(response.url()),
        status: response.status(),
      });
    }
  });
}

function safePath(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.pathname.slice(0, 300);
  } catch {
    return '/invalid-url';
  }
}

function safeText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => safePath(url))
    .replace(
      /\b(authorization|token|password|secret)\b\s*[:=]?\s*(?:bearer\s+)?[^,\s;]*/gi,
      '$1=[redacted]'
    )
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function safeError(error: unknown): string {
  return safeText(
    error instanceof Error ? error.message : 'Browser journey failed.'
  );
}
