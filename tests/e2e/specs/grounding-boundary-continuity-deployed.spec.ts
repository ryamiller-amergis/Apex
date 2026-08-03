/**
 * PBI-003 AC-0 / AC-1 / AC-2 / VT-08 — deployed grounding-boundary continuity.
 *
 * Preconditions:
 * - E2E_BASE_URL and authenticated E2E credentials target the deployed runtime.
 * - E2E_GROUNDING_BOUNDARY_INTERVIEW_ID identifies an owned in-progress interview
 *   whose Cursor agent has a persisted local binding while grounding resolves remote.
 * - repo-grounding-lifecycle-binding is targeted ON for the test caller/project.
 *
 * The first turn proves boundary recreation from PostgreSQL history. The second
 * turn proves the newly persisted matching remote binding resumes transparently.
 */
import { expect, test } from '../support/fixtures';
import { InterviewChatPage } from '../pages/interview-chat.page';

const interviewId = process.env.E2E_GROUNDING_BOUNDARY_INTERVIEW_ID;
const deployedEnvReady = Boolean(
  process.env.E2E_BASE_URL
  && interviewId
  && (
    (process.env.E2E_TEST_USER && process.env.E2E_TEST_PASSWORD)
    || process.env.E2E_STORAGE_STATE
  ),
);

test(
  'PBI-003 AC-0 / AC-1 / VT-08 transparently recreates once then resumes @deployed-smoke',
  async ({ page, loginAsPersona }) => {
    // DEFERRED: Playwright env unavailable — requires the deployed, pre-bound
    // interview fixture and authenticated environment documented above.
    test.skip(
      !deployedEnvReady,
      '// DEFERRED: Playwright env unavailable',
    );

    await loginAsPersona('qa');
    const interview = new InterviewChatPage(page);
    await interview.goto(interviewId!);

    const input = page.getByTestId('interview-message-input');
    const send = page.getByTestId('interview-send-message');

    await input.fill('Reply with exactly FEAT003_BOUNDARY_RECREATED.');
    await send.click();
    await expect(input).toBeDisabled();
    await expect(
      page.getByText('FEAT003_BOUNDARY_RECREATED.', { exact: true }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(input).toBeEnabled({ timeout: 120_000 });

    await input.fill('Reply with exactly FEAT003_MATCHING_BINDING_RESUMED.');
    await send.click();
    await expect(input).toBeDisabled();
    await expect(
      page.getByText('FEAT003_MATCHING_BINDING_RESUMED.', { exact: true }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(input).toBeEnabled({ timeout: 120_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  },
);
