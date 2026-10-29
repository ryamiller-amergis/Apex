import { expect, test, type Page, type Route } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe.ts';

const PROFILE = {
  displayName: 'test-name-loaded',
  email: 'test-loaded@example.test',
  status: 'active',
};

function problem(status: number) {
  return {
    type:
      status === 401
        ? 'urn:problem-type:authentication-required'
        : 'urn:problem-type:internal-error',
    title:
      status === 401 ? 'Authentication is required' : 'Unexpected server error',
    status,
    detail:
      status === 401
        ? 'Authentication is required.'
        : 'The server could not complete the request.',
    requestId: 'test-request-id',
  };
}

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
  problemBody = false
) {
  await route.fulfill({
    status,
    contentType: problemBody ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });
}

async function holdMe(page: Page): Promise<() => Promise<void>> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/me', async (route) => {
    await gate;
    await route.continue();
  });
  return async () => {
    release();
    await page.unroute('**/api/v1/me');
  };
}

test('VT-24 TBI-025 DoD-0 view, edit, save, and a save failure keeps the typed values', async ({
  page,
}) => {
  await page.goto('/profile');
  await expect(page.getByTestId('profile-display-name')).toBeVisible();
  await page.getByTestId('profile-edit-button').click();
  await page.getByTestId('profile-display-name-input').fill('test-name-saved');
  await page.getByTestId('profile-email-input').fill('test-saved@example.test');
  await page.getByTestId('profile-save-button').click();
  await expect(page.getByTestId('profile-display-name')).toHaveText(
    'test-name-saved'
  );
  await expect(page.getByTestId('profile-email')).toHaveText(
    'test-saved@example.test'
  );

  await page.route('**/api/v1/me', async (route) => {
    if (route.request().method() === 'PUT') {
      await fulfillJson(route, 500, problem(500), true);
      return;
    }
    await route.continue();
  });
  await page.getByTestId('profile-edit-button').click();
  await page.getByTestId('profile-display-name-input').fill('test-name-kept');
  await page.getByTestId('profile-email-input').fill('test-kept@example.test');
  await page.getByTestId('profile-save-button').click();
  await expect(page.getByTestId('profile-save-error')).toBeVisible();
  await expect(page.getByTestId('profile-save-retry')).toBeVisible();
  await expect(page.getByTestId('profile-display-name-input')).toHaveValue(
    'test-name-kept'
  );
  await expect(page.getByTestId('profile-email-input')).toHaveValue(
    'test-kept@example.test'
  );
});

test('VT-25 TBI-025 DoD-1 @a11y axe reports no violations for every profile state', async ({
  page,
}) => {
  const release = await holdMe(page);
  await page.goto('/profile');
  await expect(page.getByTestId('profile-loading')).toBeVisible();
  await expectNoAxeViolations(page, 'loading');
  await release();

  await page.unroute('**/api/v1/me');
  await page.route('**/api/v1/me', async (route) => {
    await fulfillJson(route, 200, PROFILE);
  });
  await page.goto('/profile');
  await expect(page.getByTestId('profile-display-name')).toHaveText(
    PROFILE.displayName
  );
  await expectNoAxeViolations(page, 'loaded');

  await page.unroute('**/api/v1/me');
  await page.route('**/api/v1/me', async (route) => {
    await fulfillJson(route, 200, { ...PROFILE, email: null });
  });
  await page.goto('/profile');
  await expect(page.getByTestId('profile-email-empty')).toBeVisible();
  await expectNoAxeViolations(page, 'loaded-without-email');

  await page.unroute('**/api/v1/me');
  await page.route('**/api/v1/me', async (route) => {
    await fulfillJson(route, 200, PROFILE);
  });
  await page.goto('/profile/details/edit');
  await expect(page.getByTestId('profile-form')).toBeVisible();
  await expectNoAxeViolations(page, 'edit');

  await page.getByTestId('profile-display-name-input').fill('');
  await page.getByTestId('profile-save-button').click();
  await expect(page.getByTestId('profile-display-name-input')).toHaveAttribute(
    'aria-invalid',
    'true'
  );
  await expectNoAxeViolations(page, 'validation-error');

  await page.unroute('**/api/v1/me');
  await page.route('**/api/v1/me', async (route) => {
    if (route.request().method() === 'PUT') {
      await fulfillJson(route, 500, problem(500), true);
      return;
    }
    await fulfillJson(route, 200, PROFILE);
  });
  await page.goto('/profile/details/edit');
  await page.getByTestId('profile-display-name-input').fill('test-name-kept');
  await page.getByTestId('profile-save-button').click();
  await expect(page.getByTestId('profile-save-error')).toBeVisible();
  await expectNoAxeViolations(page, 'save-error');

  await page.unroute('**/api/v1/me');
  await page.route('**/api/v1/me', async (route) => {
    await fulfillJson(route, 500, problem(500), true);
  });
  await page.goto('/profile');
  await expect(page.getByTestId('profile-error')).toBeVisible();
  await expectNoAxeViolations(page, 'load-error');

  await page.unroute('**/api/v1/me');
  await page.route('**/api/v1/me', async (route) => {
    await fulfillJson(route, 401, problem(401), true);
  });
  await page.goto('/profile');
  await expect(page.getByTestId('profile-unauthenticated')).toBeVisible();
  await expectNoAxeViolations(page, 'unauthenticated');
});

test('VT-26 TBI-025 DoD-1 the axe helper names the rule id for an unlabeled input', async ({
  page,
}) => {
  await page.setContent('<main><input /></main>');
  await expect(expectNoAxeViolations(page, 'planted')).rejects.toThrow(/label/);
});
