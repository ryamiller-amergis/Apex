import type { Page } from '@playwright/test';

/**
 * Page object for the review comment sidebar (PRD / design doc / prototype).
 */
export class ReviewCommentsPage {
  constructor(private readonly page: Page) {}

  sidebar() {
    return this.page.getByTestId('comment-sidebar');
  }

  fixAllButton() {
    return this.page.getByTestId('fix-all-comments-btn');
  }

  fixSingleButton() {
    return this.page.getByTestId('fix-single-comment-btn');
  }

  thread(commentId: string) {
    return this.page.getByTestId(`comment-thread-${commentId}`);
  }

  resolveButton() {
    return this.page.getByTestId('comment-resolve-btn');
  }

  async openCommentsSidebar(): Promise<void> {
    const sidebar = this.sidebar();
    if (await sidebar.isVisible().catch(() => false)) return;

    const commentsBtn = this.page.getByRole('button', { name: /comments/i }).first();
    if (await commentsBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await commentsBtn.click();
    }

    // Design-doc side dock
    const dockTab = this.page.getByTestId('dd-dock-comments-tab');
    if (await dockTab.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await dockTab.click();
    }
  }

  async resolveFirstOpenComment(): Promise<void> {
    await this.openCommentsSidebar();
    await this.resolveButton().first().click();
  }

  async getOpenCommentCount(): Promise<number> {
    await this.openCommentsSidebar();
    return this.page.locator('[data-testid^="comment-thread-"][data-status="open"]').count();
  }

  async clickFixAll(): Promise<void> {
    await this.openCommentsSidebar();
    await this.fixAllButton().click();
  }

  async clickFixSingle(): Promise<void> {
    await this.openCommentsSidebar();
    await this.fixSingleButton().first().click();
  }
}
