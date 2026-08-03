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
    await this.page.waitForSelector('[data-testid="prd-review"]', {
      timeout: 15_000,
    });
  }

  root() {
    return this.page.getByTestId('prd-review');
  }

  statusBadge() {
    return this.page.getByTestId('prd-status-badge');
  }

  readinessPanel() {
    return this.page.getByTestId('prd-readiness-panel');
  }

  // ── Approval buttons ──────────────────────────────────────────────────────

  approveButton() {
    return this.page.getByTestId('approve-prd-btn');
  }

  approveQaButton() {
    return this.page.getByTestId('approve-qa-btn');
  }

  approveOwnerButton() {
    return this.page.getByTestId('approve-owner-btn');
  }

  submitReviewButton() {
    return this.page.getByTestId('submit-review-btn');
  }

  /** The Request Revision button. */
  requestRevisionButton() {
    return this.page.getByRole('button', { name: /request.{0,8}revision/i });
  }

  tab(name: 'preview' | 'backlog' | 'validation') {
    return this.page.getByTestId(`prd-tab-${name}`);
  }

  /** Returns true when the Approve button is enabled (no open comments). */
  async isApproveEnabled(): Promise<boolean> {
    const btn = this.approveButton();
    return btn.isEnabled();
  }

  /** Click Approve and wait for the status to update. */
  async clickApprove(): Promise<void> {
    await this.approveButton().click();
    const confirm = this.page.getByRole('button', { name: /confirm|yes|submit/i });
    if (await confirm.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await confirm.click();
    }
  }

  async clickApproveOwner(): Promise<void> {
    await this.approveOwnerButton().click();
    // Owner approve is async; wait until the control leaves the pending_review chrome.
    await this.approveOwnerButton().waitFor({ state: 'hidden', timeout: 15_000 });
  }

  async clickApproveQa(): Promise<void> {
    await this.approveQaButton().click();
  }

  // ── Status badge ──────────────────────────────────────────────────────────

  /** Returns the text of the status badge (e.g. "Pending Review", "Approved"). */
  async getStatusText(): Promise<string> {
    return ((await this.statusBadge().textContent()) ?? '').trim();
  }

  // ── Review comments panel ─────────────────────────────────────────────────

  /** Returns the number of visible open review comment threads. */
  async getOpenCommentCount(): Promise<number> {
    const comments = this.page.locator('[data-testid^="comment-thread-"][data-status="open"]');
    return comments.count();
  }

  /**
   * Resolve the first visible open comment (clicks its "Resolve" action).
   * Assumes the comment sidebar is open.
   */
  async resolveFirstOpenComment(): Promise<void> {
    const resolveBtn = this.page.getByTestId('comment-resolve-btn').first();
    await resolveBtn.click();
  }

  /** Open the review comments sidebar if it is not already open. */
  async openCommentsSidebar(): Promise<void> {
    const sidebar = this.page.getByTestId('comment-sidebar');
    if (await sidebar.isVisible().catch(() => false)) return;
    await this.page.getByRole('button', { name: /comments/i }).first().click();
  }
}
