import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for the interview chat view (/backlog/interview/:id).
 */
export class InterviewChatPage {
  constructor(private readonly page: Page) {}

  async goto(interviewId: string): Promise<void> {
    await this.page.goto(`/backlog/interview/${interviewId}`);
    await this.waitForReady();
  }

  async waitForReady(): Promise<void> {
    await dismissOverlays(this.page);
    await this.page.waitForSelector(
      '[data-testid="interview-status-badge"], h1',
      { timeout: 15_000 }
    );
  }

  statusBadge() {
    return this.page.getByTestId('interview-status-badge');
  }

  completeButton() {
    return this.page.getByTestId('complete-interview-btn');
  }

  reopenButton() {
    return this.page.getByTestId('reopen-interview-btn');
  }

  archiveButton() {
    return this.page.getByTestId('archive-interview-btn');
  }

  generatePrdButton() {
    return this.page.getByTestId('generate-prd-btn');
  }

  prdTriggerStatus() {
    return this.page.getByTestId('interview-prd-trigger-status');
  }

  retryPrdFromPhaseButton(interviewId: string) {
    return this.page.getByTestId(`retry-prd-from-phase-${interviewId}`);
  }

  openPrdFromPhaseButton(interviewId: string) {
    return this.page.getByTestId(`open-prd-from-phase-${interviewId}`);
  }

  ownerChips() {
    return this.page.getByTestId('interview-owner-chips');
  }

  phaseBadge() {
    return this.page.getByTestId('interview-phase-badge');
  }

  technicalTab() {
    return this.page.getByTestId('interview-phase-tab-technical');
  }

  technicalPhaseBadge() {
    return this.page.getByTestId('technical-phase-badge');
  }

  technicalSeededContext() {
    return this.page.getByTestId('technical-phase-seeded-context');
  }

  technicalOriginalPromptDisclosure() {
    return this.page.getByTestId('technical-phase-seeded-context-prompt');
  }

  technicalOriginalPromptBody() {
    return this.page.locator('#technical-phase-seeded-context-prompt-body');
  }

  technicalRequirementsDisclosure() {
    return this.page.getByTestId('technical-phase-seeded-context-requirements');
  }

  technicalRequirementsBody() {
    return this.page.locator(
      '#technical-phase-seeded-context-requirements-body'
    );
  }

  technicalReadOnlyNotice() {
    return this.page.getByTestId('technical-phase-readonly-notice');
  }

  technicalAmendmentBubble() {
    return this.page.getByTestId('technical-phase-amendment-bubble');
  }

  composer() {
    return this.page.getByTestId('interview-chat-composer');
  }

  phaseReadOnlyNotice() {
    return this.page.getByTestId('interview-phase-readonly-notice');
  }

  messageInput() {
    return this.page.getByTestId('interview-message-input');
  }

  sendMessageButton() {
    return this.page.getByTestId('interview-send-message');
  }

  phaseSummaryContent(phase: 'requirements' | 'technical') {
    return this.page.getByTestId(`phase-summary-${phase}-content`);
  }

  phaseSummaryApproved(phase: 'requirements' | 'technical') {
    return this.page.getByTestId(`phase-summary-${phase}-approved`);
  }

  phaseSummaryApproveButton(phase: 'requirements' | 'technical') {
    return this.page.getByTestId(`phase-summary-${phase}-approve`);
  }

  phaseSummaryAmendButton() {
    return this.page.getByTestId('phase-summary-requirements-amend');
  }

  phaseSummaryAmendContent() {
    return this.page.getByTestId('phase-summary-requirements-amend-content');
  }

  phaseSummarySaveAmendmentButton() {
    return this.page.getByTestId('phase-summary-requirements-save-amendment');
  }

  async getStatusText(): Promise<string> {
    return ((await this.statusBadge().textContent()) ?? '').trim();
  }

  async clickComplete(): Promise<void> {
    await this.completeButton().click();
  }

  async clickReopen(): Promise<void> {
    await this.reopenButton().click();
  }

  async clickArchive(): Promise<void> {
    await this.archiveButton().click();
  }

  async clickGeneratePrd(): Promise<void> {
    await this.generatePrdButton().click();
  }

  async openTechnicalPhase(): Promise<void> {
    await this.technicalTab().click();
  }

  async sendMessage(text: string): Promise<void> {
    await this.messageInput().fill(text);
    await this.sendMessageButton().click();
  }

  async approvePhaseSummary(
    phase: 'requirements' | 'technical',
    content: string
  ): Promise<void> {
    await this.phaseSummaryContent(phase).fill(content);
    await this.phaseSummaryApproveButton(phase).click();
  }

  async amendRequirementsSummary(content: string): Promise<void> {
    await this.phaseSummaryAmendButton().click();
    await this.phaseSummaryAmendContent().fill(content);
    await this.phaseSummarySaveAmendmentButton().click();
  }
}
