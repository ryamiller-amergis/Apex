import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for the PRD review view (/backlog/prd/:id).
 * Covers the approval state machine: open comments block approval,
 * reviewer approve, owner final approve.
 */
export class PrdReviewPage {
  constructor(private readonly page: Page) {}

  /** Navigate directly to a PRD by ID. */
  async goto(prdId: string): Promise<void> {
    await this.page.goto(`/backlog/prd/${prdId}`);
    await this.waitForReady();
  }

  /** Wait until the PRD document content is visible. */
  async waitForReady(): Promise<void> {
    await dismissOverlays(this.page);
    // The PRD view renders either the PRD content or a loading state.
    await this.page.waitForSelector('h1, [data-testid="prd-content"], [data-testid="prd-review"]', {
      timeout: 15_000,
    });
  }

  // ── Approval buttons ──────────────────────────────────────────────────────

  /** The Approve button used by a reviewer to give their sign-off. */
  approveButton() {
    return this.page.getByRole('button', { name: /^approve$/i });
  }

  /** The Request Revision button. */
  requestRevisionButton() {
    return this.page.getByRole('button', { name: /request.{0,8}revision/i });
  }

  /** Returns true when the Approve button is enabled (no open comments). */
  async isApproveEnabled(): Promise<boolean> {
    const btn = this.approveButton();
    const disabled = await btn.getAttribute('disabled');
    return disabled === null;
  }

  /** Click Approve and wait for the status to update. */
  async clickApprove(): Promise<void> {
    await this.approveButton().click();
    // If a confirmation dialog appears, confirm it.
    const confirm = this.page.getByRole('button', { name: /confirm|yes|submit/i });
    if (await confirm.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await confirm.click();
    }
  }

  // ── Status badge ──────────────────────────────────────────────────────────

  /** Returns the text of the status badge (e.g. "Pending Review", "Approved"). */
  async getStatusText(): Promise<string> {
    const badge = this.page
      .getByText(/pending.review|approved|draft|rejected/i)
      .first();
    return (await badge.textContent()) ?? '';
  }

  // ── Review comments panel ─────────────────────────────────────────────────

  /** Returns the number of visible open review comment threads. */
  async getOpenCommentCount(): Promise<number> {
    const comments = this.page.locator('[data-testid^="comment-"][data-status="open"]');
    return comments.count();
  }

  /**
   * Resolve the first visible open comment (clicks its "Resolve" action).
   * Assumes the comment sidebar is open.
   */
  async resolveFirstOpenComment(): Promise<void> {
    const resolveBtn = this.page
      .getByRole('button', { name: /resolve/i })
      .first();
    await resolveBtn.click();
  }

  /** Open the review comments sidebar if it is not already open. */
  async openCommentsSidebar(): Promise<void> {
    const sidebar = this.page.getByRole('complementary', { name: /comments/i });
    if (!(await sidebar.isVisible().catch(() => false))) {
      await this.page.getByRole('button', { name: /comments/i }).first().click();
    }
  }
}
