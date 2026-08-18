import type { Page } from '@playwright/test';

export async function selectObservabilityActor(page: Page, actorId: string): Promise<void> {
  await page.getByTestId('observability-actor-input').click();
  await page.getByTestId(`observability-actor-option-${actorId}`).click();
}
