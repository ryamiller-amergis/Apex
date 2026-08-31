/**
 * E2E test seed/reset endpoints.
 *
 * This router is mounted ONLY when E2E_MODE=true (see src/server/index.ts).
 * It is never available in NODE_ENV=production.
 *
 * All records created here use the "[E2E]" prefix so they can be found and
 * deleted by the /reset endpoint without touching real application data.
 */
import { randomUUID } from 'crypto';
import express from 'express';
import { and, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  adrs,
  chatThreads,
  designDocs,
  designPrototypes,
  documentApproverAssignments,
  interviews,
  notifications,
  prds,
  projectApprovalModes,
  projectApprovers,
  projectMenuSettings,
  projectSkillSettings,
  reviewComments,
  testCases,
} from '../db/schema';
import type { MenuItemKey } from '../../shared/types/menuSettings';
import type { ValidationScorecard } from '../../shared/types/interview';

const router = express.Router();

const E2E_PREFIX = '[E2E]';

/** Modules that inherit the legacy `approvalMode` payload; `adr` is always seeded as `any_one`. */
const LEGACY_APPROVAL_MODE_MODULES = ['prd', 'design_doc', 'design_prototype', 'test_case'] as const;

function e2eTitle(title: string): string {
  return title.startsWith(E2E_PREFIX) ? title : `${E2E_PREFIX} ${title}`;
}

const DEFAULT_BACKLOG = {
  epics: [
    {
      id: 'e2e-epic-1',
      title: 'E2E Epic',
      features: [
        {
          id: 'e2e-feature-1',
          title: 'E2E Feature',
          pbis: [
            {
              id: 'e2e-pbi-1',
              title: 'E2E PBI',
              acceptanceCriteria: ['Given a seeded PRD, when reviewed, then it is approvable'],
              testCaseCount: 1,
            },
          ],
        },
      ],
    },
  ],
};

function defaultScorecard(score: number, threshold = 90): ValidationScorecard {
  return {
    slug: 'e2e-scorecard',
    generated_at: new Date().toISOString(),
    review_phase: 'final',
    overall_score: score,
    ready_threshold: threshold,
    is_ready: score >= threshold,
    verdict: score >= threshold ? 'ready' : score >= 70 ? 'gaps' : 'significant_gaps',
    features: [],
    files: [],
  };
}

// DELETE all records created by E2E tests (idempotent, safe to call repeatedly).
router.post('/reset', async (_req, res) => {
  try {
    await db.delete(reviewComments).where(like(reviewComments.body, `${E2E_PREFIX}%`));
    await db.delete(notifications).where(like(notifications.title, `${E2E_PREFIX}%`));

    const e2ePrds = await db
      .select({ id: prds.id })
      .from(prds)
      .where(like(prds.title, `${E2E_PREFIX}%`));
    const e2eDocs = await db
      .select({ id: designDocs.id })
      .from(designDocs)
      .where(like(designDocs.title, `${E2E_PREFIX}%`));
    const e2eProtos = await db
      .select({ id: designPrototypes.id })
      .from(designPrototypes)
      .where(like(designPrototypes.featureName, `${E2E_PREFIX}%`));
    const e2eAdrs = await db
      .select({ id: adrs.id, chatThreadId: adrs.chatThreadId })
      .from(adrs)
      .where(like(adrs.title, `${E2E_PREFIX}%`));

    const documentIds = [
      ...e2ePrds.map((r) => r.id),
      ...e2eDocs.map((r) => r.id),
      ...e2eProtos.map((r) => r.id),
      ...e2eAdrs.map((r) => r.id),
    ];
    if (documentIds.length > 0) {
      await db
        .delete(documentApproverAssignments)
        .where(inArray(documentApproverAssignments.documentId, documentIds));
    }

    // design_docs / design_prototypes / test_cases cascade from PRDs
    await db.delete(prds).where(like(prds.title, `${E2E_PREFIX}%`));

    // Orphan prototypes / docs not under an E2E PRD (defensive)
    await db.delete(designDocs).where(like(designDocs.title, `${E2E_PREFIX}%`));
    await db.delete(designPrototypes).where(like(designPrototypes.featureName, `${E2E_PREFIX}%`));
    await db.delete(adrs).where(like(adrs.title, `${E2E_PREFIX}%`));

    const e2eInterviews = await db
      .select({ id: interviews.id, chatThreadId: interviews.chatThreadId })
      .from(interviews)
      .where(like(interviews.title, `${E2E_PREFIX}%`));
    await db.delete(interviews).where(like(interviews.title, `${E2E_PREFIX}%`));

    const threadIds = [
      ...e2eInterviews.map((i) => i.chatThreadId),
      ...e2eAdrs.map((adr) => adr.chatThreadId),
    ];
    const e2eThreads = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(like(chatThreads.title, `${E2E_PREFIX}%`));
    const allThreadIds = [...new Set([...threadIds, ...e2eThreads.map((t) => t.id)])];
    if (allThreadIds.length > 0) {
      await db.delete(chatThreads).where(inArray(chatThreads.id, allThreadIds));
    }

    await db
      .delete(projectSkillSettings)
      .where(like(projectSkillSettings.friendlyName, `${E2E_PREFIX}%`));

    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E reset failed: ${message}` });
  }
});

// Create an interview (+ backing chat thread) in the specified status.
router.post('/seed/interview', async (req, res) => {
  try {
    const {
      authorId,
      project,
      title,
      status = 'in_progress',
      repo = 'E2E/Repo',
      prdOwnerId,
      designDocOwnerId,
      designPrototypeOwnerId,
      testCaseOwnerId,
      prdApproverIds,
      designDocApproverIds,
      designPrototypeApproverIds,
      testCaseApproverIds,
      prototypeStageEnabled = true,
      testCasesEnabled = true,
      skillSettingsId,
    } = req.body as {
      authorId: string;
      project: string;
      title: string;
      status?: string;
      repo?: string;
      prdOwnerId?: string;
      designDocOwnerId?: string;
      designPrototypeOwnerId?: string;
      testCaseOwnerId?: string;
      prdApproverIds?: string[];
      designDocApproverIds?: string[];
      designPrototypeApproverIds?: string[];
      testCaseApproverIds?: string[];
      prototypeStageEnabled?: boolean;
      testCasesEnabled?: boolean;
      skillSettingsId?: string;
    };

    const threadId = randomUUID();
    const prefixedTitle = e2eTitle(title);

    await db.insert(chatThreads).values({
      id: threadId,
      userId: authorId,
      status: 'idle',
      title: prefixedTitle,
      kickoff: {
        project,
        repo,
        skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
        pillLabel: 'E2E Interview',
      },
    });

    const [interview] = await db
      .insert(interviews)
      .values({
        chatThreadId: threadId,
        authorId,
        project,
        repo,
        title: prefixedTitle,
        status,
        prdOwnerId: prdOwnerId ?? null,
        designDocOwnerId: designDocOwnerId ?? null,
        designPrototypeOwnerId: designPrototypeOwnerId ?? null,
        testCaseOwnerId: testCaseOwnerId ?? null,
        prdApproverIds: prdApproverIds ?? null,
        designDocApproverIds: designDocApproverIds ?? null,
        designPrototypeApproverIds: designPrototypeApproverIds ?? null,
        testCaseApproverIds: testCaseApproverIds ?? null,
        prototypeStageEnabled,
        testCasesEnabled,
        skillSettingsId: skillSettingsId ?? null,
      })
      .returning();

    res.json(interview);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/interview failed: ${message}` });
  }
});

// Create an ADR (+ backing chat thread) in a deterministic review state.
router.post('/seed/adr', async (req, res) => {
  try {
    const {
      authorId,
      project,
      title,
      status = 'proposed',
      repo = 'E2E/Repo',
      content = '# E2E ADR\n\n## Decision\n\nUse the deterministic owner-only path.',
      reviewerIds = [],
      proposedContent,
      skillSettingsId,
    } = req.body as {
      authorId: string;
      project: string;
      title: string;
      status?: string;
      repo?: string;
      content?: string;
      reviewerIds?: string[];
      proposedContent?: string | null;
      skillSettingsId?: string;
    };

    const threadId = randomUUID();
    const prefixedTitle = e2eTitle(title);
    await db.insert(chatThreads).values({
      id: threadId,
      userId: authorId,
      status: 'idle',
      title: prefixedTitle,
      kickoff: {
        project,
        repo,
        skillPath: '.cursor/skills/adr-interview/SKILL.md',
        pillLabel: 'E2E ADR',
      },
    });

    const [adr] = await db
      .insert(adrs)
      .values({
        chatThreadId: threadId,
        authorId,
        reviewerIds,
        title: prefixedTitle,
        project,
        repo,
        status,
        content,
        proposedContent: proposedContent ?? null,
        skillSettingsId: skillSettingsId ?? null,
      })
      .returning();

    res.json(adr);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/adr failed: ${message}` });
  }
});

// Create a PRD in the specified status for testing approval / validation flows.
router.post('/seed/prd', async (req, res) => {
  try {
    const {
      authorId,
      project,
      title,
      status = 'pending_review',
      reviewerId,
      interviewId,
      content,
      backlogJson,
      validationScore,
      validationScorecard,
      validationPhase,
      readinessOverride,
      withReadyTestCases = false,
      designDocApproverIds,
      designPrototypeApproverIds,
    } = req.body as {
      authorId: string;
      project: string;
      title: string;
      status?: string;
      reviewerId?: string;
      interviewId?: string;
      content?: string;
      backlogJson?: unknown;
      validationScore?: number | null;
      validationScorecard?: ValidationScorecard | null;
      validationPhase?: string | null;
      readinessOverride?: unknown;
      withReadyTestCases?: boolean;
      designDocApproverIds?: string[];
      designPrototypeApproverIds?: string[];
    };

    const scorecard =
      validationScorecard ??
      (typeof validationScore === 'number' ? defaultScorecard(validationScore) : null);

    const [prd] = await db
      .insert(prds)
      .values({
        authorId,
        project,
        title: e2eTitle(title),
        status,
        reviewerId: reviewerId ?? null,
        interviewId: interviewId ?? null,
        content: content ?? '# E2E Test PRD\n\nThis document was created by Playwright tests.',
        backlogJson: backlogJson ?? DEFAULT_BACKLOG,
        validationScore: validationScore ?? null,
        validationScorecard: scorecard,
        validationPhase: validationPhase ?? null,
        readinessOverride: (readinessOverride as never) ?? null,
        designDocApproverIds: designDocApproverIds ?? null,
        designPrototypeApproverIds: designPrototypeApproverIds ?? null,
      })
      .returning();

    let testCase: typeof testCases.$inferSelect | null = null;
    if (withReadyTestCases) {
      const [tc] = await db
        .insert(testCases)
        .values({
          prdId: prd.id,
          status: 'ready',
          testCasesJson: { cases: [{ id: 'tc-1', title: 'E2E seeded test case' }] },
          testCasesMd: '# E2E Test Cases\n\n- Seeded case',
          coverageSummary: {
            totalCases: 1,
            pbisCovered: 1,
            acCovered: '1/1',
            brCovered: '0/0',
            gaps: 0,
          },
        })
        .returning();
      testCase = tc;
    }

    res.json({ ...prd, testCase });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/prd failed: ${message}` });
  }
});

// Update a seeded PRD's status (e.g., after reviewer approves).
router.patch('/seed/prd/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      reviewerId,
      reviewedAt,
      reviewComment,
      validationScore,
      validationScorecard,
      validationPhase,
      readinessOverride,
      proposedContent,
    } = req.body as {
      status?: string;
      reviewerId?: string;
      reviewedAt?: string;
      reviewComment?: string;
      validationScore?: number | null;
      validationScorecard?: ValidationScorecard | null;
      validationPhase?: string | null;
      readinessOverride?: unknown;
      proposedContent?: string | null;
    };

    const [updated] = await db
      .update(prds)
      .set({
        ...(status !== undefined && { status }),
        ...(reviewerId !== undefined && { reviewerId }),
        ...(reviewedAt !== undefined && { reviewedAt }),
        ...(reviewComment !== undefined && { reviewComment }),
        ...(validationScore !== undefined && { validationScore }),
        ...(validationScorecard !== undefined && { validationScorecard }),
        ...(validationPhase !== undefined && { validationPhase }),
        ...(readinessOverride !== undefined && { readinessOverride: readinessOverride as never }),
        ...(proposedContent !== undefined && { proposedContent }),
      })
      .where(and(eq(prds.id, id), like(prds.title, `${E2E_PREFIX}%`)))
      .returning();

    if (!updated) return res.status(404).json({ error: 'PRD not found or not an E2E record' });
    res.json(updated);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E patch/prd failed: ${message}` });
  }
});

// Seed a design prototype under a PRD.
router.post('/seed/design-prototype', async (req, res) => {
  try {
    const {
      prdId,
      authorId,
      featureName = 'E2E Feature',
      featureIndex = 0,
      status = 'pending_review',
      mockHtml,
      reviewerId,
    } = req.body as {
      prdId: string;
      authorId: string;
      featureName?: string;
      featureIndex?: number;
      status?: string;
      mockHtml?: string;
      reviewerId?: string;
    };

    const [proto] = await db
      .insert(designPrototypes)
      .values({
        prdId,
        authorId,
        featureName: e2eTitle(featureName),
        featureIndex,
        status,
        mockHtml:
          mockHtml ??
          '<!DOCTYPE html><html><body><h1>E2E Prototype</h1><p>Seeded by Playwright.</p></body></html>',
        reviewerId: reviewerId ?? null,
      })
      .returning();

    res.json(proto);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/design-prototype failed: ${message}` });
  }
});

// Seed a design doc under a PRD.
router.post('/seed/design-doc', async (req, res) => {
  try {
    const {
      prdId,
      authorId,
      project,
      title,
      status = 'pending_review',
      designPrototypeId,
      featureIndex = 0,
      validationScore,
      validationScorecard,
      validationPhase,
      validationOverride,
      designContent,
      techSpecContent,
      assumptionsContent,
      reviewerId,
      proposedDesignContent,
      validationThreadId,
      skillSettingsId,
    } = req.body as {
      prdId: string;
      authorId: string;
      project: string;
      title: string;
      status?: string;
      designPrototypeId?: string;
      featureIndex?: number;
      validationScore?: number | null;
      validationScorecard?: ValidationScorecard | null;
      validationPhase?: string | null;
      validationOverride?: unknown;
      designContent?: string;
      techSpecContent?: string;
      assumptionsContent?: string;
      reviewerId?: string;
      proposedDesignContent?: string | null;
      validationThreadId?: string | null;
      skillSettingsId?: string | null;
    };

    const scorecard =
      validationScorecard ??
      (typeof validationScore === 'number' ? defaultScorecard(validationScore) : null);

    // Validation side-dock only renders when validationThreadId is set.
    const resolvedValidationThreadId =
      validationThreadId ??
      (typeof validationScore === 'number' ? randomUUID() : null);

    const [doc] = await db
      .insert(designDocs)
      .values({
        prdId,
        authorId,
        project,
        title: e2eTitle(title),
        status,
        designPrototypeId: designPrototypeId ?? null,
        featureIndex,
        validationScore: validationScore ?? null,
        validationScorecard: scorecard,
        validationPhase: validationPhase ?? (typeof validationScore === 'number' ? 'final' : null),
        validationOverride: (validationOverride as never) ?? null,
        validationThreadId: resolvedValidationThreadId,
        skillSettingsId: skillSettingsId ?? null,
        designContent: designContent ?? '# E2E Design\n\nSeeded design content.',
        techSpecContent: techSpecContent ?? '# E2E Tech Spec\n\nSeeded tech spec.',
        assumptionsContent: assumptionsContent ?? '# E2E Assumptions\n\nSeeded assumptions.',
        reviewerId: reviewerId ?? null,
        proposedDesignContent: proposedDesignContent ?? null,
      })
      .returning();

    res.json(doc);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/design-doc failed: ${message}` });
  }
});

// Add a review comment to a seeded document (prd | design_doc | design_prototype).
router.post('/seed/review-comment', async (req, res) => {
  try {
    const {
      documentId,
      documentType = 'prd',
      authorUserId,
      body,
      status = 'open',
      sectionKey,
      selectorExact = 'E2E Test PRD',
      selectorStart = 0,
      selectorEnd,
    } = req.body as {
      documentId?: string;
      prdId?: string;
      documentType?: 'prd' | 'design_doc' | 'design_prototype';
      authorUserId: string;
      body: string;
      status?: 'open' | 'resolved';
      sectionKey?: string;
      selectorExact?: string;
      selectorStart?: number;
      selectorEnd?: number;
    };

    const resolvedDocumentId = documentId ?? (req.body as { prdId?: string }).prdId;
    if (!resolvedDocumentId) {
      return res.status(400).json({ error: 'documentId is required' });
    }

    const resolvedType = documentType ?? 'prd';
    const resolvedSectionKey =
      sectionKey ??
      (resolvedType === 'design_doc' ? 'design' : resolvedType === 'prd' ? 'prd' : 'e2e-section');

    const [comment] = await db
      .insert(reviewComments)
      .values({
        documentId: resolvedDocumentId,
        documentType: resolvedType,
        sectionKey: resolvedSectionKey,
        authorUserId,
        body: e2eTitle(body),
        selectorExact,
        selectorPrefix: '',
        selectorSuffix: '',
        selectorStart,
        selectorEnd: selectorEnd ?? selectorExact.length,
        status,
      })
      .returning();

    res.json(comment);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/review-comment failed: ${message}` });
  }
});

// Legacy alias — keep existing specs working.
router.post('/seed/prd-comment', async (req, res) => {
  try {
    const {
      prdId,
      authorUserId,
      body,
      status = 'open',
    } = req.body as {
      prdId: string;
      authorUserId: string;
      body: string;
      status?: 'open' | 'resolved';
    };

    const [comment] = await db
      .insert(reviewComments)
      .values({
        documentId: prdId,
        documentType: 'prd',
        sectionKey: 'prd',
        authorUserId,
        body: e2eTitle(body),
        selectorExact: 'E2E Test PRD',
        selectorPrefix: '',
        selectorSuffix: '',
        selectorStart: 0,
        selectorEnd: 14,
        status,
      })
      .returning();

    res.json(comment);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/prd-comment failed: ${message}` });
  }
});

// Seed document_approver_assignments rows for deterministic reviewer gating.
router.post('/seed/approver-assignments', async (req, res) => {
  try {
    const {
      documentId,
      documentType,
      approverUserIds,
      assignedBy,
      status = 'pending',
    } = req.body as {
      documentId: string;
      documentType: 'prd' | 'design_doc' | 'design_prototype' | 'test_case';
      approverUserIds: string[];
      assignedBy: string;
      status?: 'pending' | 'approved' | 'rejected';
    };

    if (!Array.isArray(approverUserIds) || approverUserIds.length === 0) {
      return res.status(400).json({ error: 'approverUserIds required' });
    }

    const rows = await db
      .insert(documentApproverAssignments)
      .values(
        approverUserIds.map((approverUserId) => ({
          documentId,
          documentType,
          approverUserId,
          assignedBy,
          status,
          respondedAt: status === 'pending' ? null : new Date().toISOString(),
        })),
      )
      .onConflictDoNothing()
      .returning();

    res.json(rows);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/approver-assignments failed: ${message}` });
  }
});

// Upsert project skill settings for settings-toggle tests.
router.post('/seed/project-settings', async (req, res) => {
  try {
    const {
      project,
      friendlyName = 'E2E Settings',
      skillRepo = 'E2E/skills',
      skillBranch = 'main',
      isDefault = false,
      approvalMode,
      prototypeStageEnabled,
      prdValidationSkillPath,
      designDocValidationSkillPath,
      prdValidationScoreThreshold,
      designDocValidationScoreThreshold,
      interviewSkillPath,
      prdSkillPath,
      designDocSkillPath,
      designPrototypeSkillPath,
      testCaseSkillPath,
      updatedBy,
      designDocApprovers,
      prdApprovers,
      designPrototypeApprovers,
      testCaseApprovers,
      adrApprovers,
    } = req.body as {
      project: string;
      friendlyName?: string;
      skillRepo?: string;
      skillBranch?: string;
      isDefault?: boolean;
      approvalMode?: 'any_one' | 'all_required';
      prototypeStageEnabled?: boolean;
      prdValidationSkillPath?: string | null;
      designDocValidationSkillPath?: string | null;
      prdValidationScoreThreshold?: number | null;
      designDocValidationScoreThreshold?: number | null;
      interviewSkillPath?: string | null;
      prdSkillPath?: string | null;
      designDocSkillPath?: string | null;
      designPrototypeSkillPath?: string | null;
      testCaseSkillPath?: string | null;
      updatedBy?: string;
      designDocApprovers?: string[];
      prdApprovers?: string[];
      designPrototypeApprovers?: string[];
      testCaseApprovers?: string[];
      adrApprovers?: string[];
    };

    const prefixedName = e2eTitle(friendlyName);

    const existing = await db
      .select()
      .from(projectSkillSettings)
      .where(
        and(
          eq(projectSkillSettings.project, project),
          eq(projectSkillSettings.friendlyName, prefixedName),
        ),
      )
      .limit(1);

    let row: typeof projectSkillSettings.$inferSelect;
    if (existing[0]) {
      const [updated] = await db
        .update(projectSkillSettings)
        .set({
          ...(approvalMode !== undefined && { approvalMode }),
          ...(prototypeStageEnabled !== undefined && { prototypeStageEnabled }),
          ...(prdValidationSkillPath !== undefined && { prdValidationSkillPath }),
          ...(designDocValidationSkillPath !== undefined && { designDocValidationSkillPath }),
          ...(prdValidationScoreThreshold !== undefined && { prdValidationScoreThreshold }),
          ...(designDocValidationScoreThreshold !== undefined && {
            designDocValidationScoreThreshold,
          }),
          ...(interviewSkillPath !== undefined && { interviewSkillPath }),
          ...(prdSkillPath !== undefined && { prdSkillPath }),
          ...(designDocSkillPath !== undefined && { designDocSkillPath }),
          ...(designPrototypeSkillPath !== undefined && { designPrototypeSkillPath }),
          ...(testCaseSkillPath !== undefined && { testCaseSkillPath }),
          ...(updatedBy !== undefined && { updatedBy }),
          ...(isDefault ? { isDefault: true } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(projectSkillSettings.id, existing[0].id))
        .returning();
      row = updated;
    } else {
      // If marking default, clear other defaults for this project first
      if (isDefault) {
        await db
          .update(projectSkillSettings)
          .set({ isDefault: false })
          .where(eq(projectSkillSettings.project, project));
      }

      const [inserted] = await db
        .insert(projectSkillSettings)
        .values({
          project,
          friendlyName: prefixedName,
          skillRepo,
          skillBranch,
          isDefault,
          approvalMode: approvalMode ?? 'any_one',
          prototypeStageEnabled: prototypeStageEnabled ?? true,
          prdValidationSkillPath: prdValidationSkillPath ?? null,
          designDocValidationSkillPath: designDocValidationSkillPath ?? null,
          prdValidationScoreThreshold: prdValidationScoreThreshold ?? 90,
          designDocValidationScoreThreshold: designDocValidationScoreThreshold ?? 90,
          interviewSkillPath: interviewSkillPath ?? null,
          prdSkillPath: prdSkillPath ?? null,
          designDocSkillPath: designDocSkillPath ?? null,
          designPrototypeSkillPath: designPrototypeSkillPath ?? null,
          testCaseSkillPath: testCaseSkillPath ?? null,
          updatedBy: updatedBy ?? 'e2e',
        })
        .returning();
      row = inserted;
    }

    // resolveSkillConfig may read any settings row for the project, so propagate
    // gating fields across all of them. Approval completion reads per-module rows
    // from project_approval_modes, which only exist for the seeded row.
    if (approvalMode !== undefined) {
      await db
        .update(projectSkillSettings)
        .set({ approvalMode, updatedAt: sql`now()` })
        .where(eq(projectSkillSettings.project, project));
      row = { ...row, approvalMode };

      await db
        .insert(projectApprovalModes)
        .values([
          ...LEGACY_APPROVAL_MODE_MODULES.map((documentType) => ({
            settingsId: row.id,
            documentType,
            mode: approvalMode,
          })),
          { settingsId: row.id, documentType: 'adr', mode: 'any_one' as const },
        ])
        .onConflictDoUpdate({
          target: [projectApprovalModes.settingsId, projectApprovalModes.documentType],
          set: { mode: sql`excluded.mode`, updatedAt: sql`now()` },
        });
    }
    if (designDocValidationSkillPath !== undefined) {
      await db
        .update(projectSkillSettings)
        .set({
          designDocValidationSkillPath,
          updatedAt: sql`now()`,
        })
        .where(eq(projectSkillSettings.project, project));
      row = { ...row, designDocValidationSkillPath };
    }
    if (prdValidationSkillPath !== undefined) {
      await db
        .update(projectSkillSettings)
        .set({
          prdValidationSkillPath,
          updatedAt: sql`now()`,
        })
        .where(eq(projectSkillSettings.project, project));
      row = { ...row, prdValidationSkillPath };
    }

    const poolEntries: Array<{ documentType: string; userIds: string[] }> = [
      { documentType: 'design_doc', userIds: designDocApprovers ?? [] },
      { documentType: 'prd', userIds: prdApprovers ?? [] },
      { documentType: 'design_prototype', userIds: designPrototypeApprovers ?? [] },
      { documentType: 'test_case', userIds: testCaseApprovers ?? [] },
      { documentType: 'adr', userIds: adrApprovers ?? [] },
    ];

    for (const { documentType, userIds } of poolEntries) {
      if (userIds.length === 0) continue;
      await db
        .insert(projectApprovers)
        .values(
          userIds.map((userId) => ({
            settingsId: row.id,
            userId,
            documentType,
            assignedBy: 'e2e',
          })),
        )
        .onConflictDoNothing();
    }

    // Ensure this settings row is the default when we seed pools / gating fields,
    // so getSkillConfig(project) resolves to it during assignApprovers.
    if (
      isDefault ||
      designDocApprovers?.length ||
      prdApprovers?.length ||
      designPrototypeApprovers?.length ||
      testCaseApprovers?.length ||
      adrApprovers?.length ||
      approvalMode !== undefined
    ) {
      await db
        .update(projectSkillSettings)
        .set({ isDefault: false })
        .where(
          and(eq(projectSkillSettings.project, project), ne(projectSkillSettings.id, row.id)),
        );
      await db
        .update(projectSkillSettings)
        .set({ isDefault: true, updatedAt: sql`now()` })
        .where(eq(projectSkillSettings.id, row.id));
      row = { ...row, isDefault: true };
    }

    res.json(row);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/project-settings failed: ${message}` });
  }
});

// Create an in-app notification for a user.
router.post('/seed/notification', async (req, res) => {
  try {
    const {
      userId,
      type = 'system',
      title,
      body,
      link,
    } = req.body as {
      userId: string;
      type?: string;
      title: string;
      body?: string;
      link?: string;
    };

    const [notif] = await db
      .insert(notifications)
      .values({
        userId,
        type,
        title: e2eTitle(title),
        body: body ?? null,
        link: link ?? null,
        read: false,
      })
      .returning();

    res.json(notif);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/notification failed: ${message}` });
  }
});

// Override project menu visibility for a test.
router.post('/seed/menu-settings', async (req, res) => {
  try {
    const { project, enabledViews } = req.body as {
      project: string;
      enabledViews: MenuItemKey[];
    };

    await db
      .insert(projectMenuSettings)
      .values({ project, enabledViews })
      .onConflictDoUpdate({
        target: projectMenuSettings.project,
        set: { enabledViews },
      });

    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `E2E seed/menu-settings failed: ${message}` });
  }
});

export default router;
