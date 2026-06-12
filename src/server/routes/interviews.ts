import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { isAdminUser } from '../utils/rbacHelpers';
import { db } from '../db/drizzle';
import { eq, and, sql } from 'drizzle-orm';
import { designDocs as designDocsTable, chatThreads as chatThreadsTable, prds as prdsTable, reviewComments as reviewCommentsTable } from '../db/schema';
import { getComments } from '../services/reviewCommentService';
import { fixPrdContentWithBedrock, fixPrdBacklogWithBedrock, fixDesignDocSectionWithBedrock, BedrockModelTruncatedError } from '../services/bedrockService';
import {
  createInterview,
  deleteInterview,
  getInterview,
  listInterviews,
  updateInterviewStatus,
  updateInterviewTitle,
} from '../services/interviewService';
import { getActiveUsers } from '../services/rbacService';
import {
  createPrd,
  createPrdAdoWorkItems,
  syncPrdAdoStatus,
  deletePrd,
  getPrd,
  listPrds,
  reviewPrd,
  reopenForReview,
  startPrdWatcher,
  submitForReview,
  syncPrdContent,
  updatePrdBacklog,
  updatePrdContent,
  updatePrdDesignDocApprovers,
  withdrawFromReview,
  autoStartPrdValidation,
  cancelPrdValidation,
  syncPrdValidationResult,
  markPrdValidationReady,
  triggerFixPrdValidation,
  acceptFixPrdValidation,
  revertPrdSection,
} from '../services/prdService';
import {
  acceptFixValidation,
  cancelValidation,
  createDesignDoc,
  deleteDesignDoc,
  generateFallbackReport,
  getDesignDoc,
  listDesignDocs,
  reviewDesignDoc,
  startDesignDocWatcher,
  submitForReview as submitDesignDocForReview,
  syncDesignDocContent,
  triggerFixValidation,
  updateDesignDocContent,
  withdrawFromReview as withdrawDesignDocFromReview,
  autoStartValidation,
  markValidationReady,
  syncValidationResult,
  syncPerFeatureDesignDocs,
} from '../services/designDocService';
import { readOutputBacklog, readOutputDesignDoc, readOutputTechSpec, readOutputAssumptions, readOutputPrd, readOutputValidationScorecard, readOutputValidationScorecardMd, readAllOutputDesignDocFeatures, createThread, getThreadAsync, updateThreadKickoffContext } from '../services/chatAgentService';
import { getSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import { getAssignments, getAvailableApprovers, reassignApprovers } from '../services/documentApprovalService';
import { canCreateDesignDocAssistantThread } from '../services/threadAccessService';
import { generateDesignPlan } from '../services/designPlanService';
import { getTestCases } from '../services/testCaseService';
import { generateFallbackReport as generateFallbackValidationReport } from '../services/documentValidationService';
import type { InterviewStatus, PrdStatus, ReviewPrdRequest, DesignDocStatus, ReviewDesignDocRequest } from '../../shared/types/interview';

const router = Router();

// ── Interviews ────────────────────────────────────────────────────────────────

router.get('/', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const status = req.query.status as InterviewStatus | undefined;
    const project = req.query.project as string | undefined;
    const authorFilter = req.query.author === 'me' ? userId : undefined;
    const list = await listInterviews({ status, project, authorId: authorFilter });
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { project, repo, title, chatThreadId, prdOwnerId, designDocOwnerId, designPrototypeOwnerId, prdApproverIds, designDocApproverIds, designPrototypeApproverIds } = req.body as {
      project: string;
      repo: string;
      title?: string;
      chatThreadId: string;
      prdOwnerId?: string;
      designDocOwnerId?: string;
      designPrototypeOwnerId?: string;
      prdApproverIds?: string[];
      designDocApproverIds?: string[];
      designPrototypeApproverIds?: string[];
    };

    if (!project || !repo || !chatThreadId) {
      res.status(400).json({ error: 'project, repo, and chatThreadId are required' });
      return;
    }

    const result = await createInterview({ userId, project, repo, title, chatThreadId, prdOwnerId, designDocOwnerId, designPrototypeOwnerId, prdApproverIds, designDocApproverIds, designPrototypeApproverIds });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/active-users', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const users = await getActiveUsers();
    res.json(users);
  } catch (err) {
    next(err);
  }
});

// ── Design-system screen inventory (for route confirm/override picker) ─────────

// GET /screen-inventory — existing MaxView page routes (+ purpose) for the route picker
router.get('/screen-inventory', requirePermission('interviews:view'), async (_req, res, next) => {
  try {
    const { getScreenInventory } = await import('../services/designSystemService');
    const routes = await getScreenInventory();
    res.json(routes);
  } catch (err) {
    next(err);
  }
});

// ── PRDs ──────────────────────────────────────────────────────────────────────

router.get('/prds', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const status = req.query.status as PrdStatus | undefined;
    const project = req.query.project as string | undefined;
    const authorFilter = req.query.author === 'me' ? userId : undefined;
    const list = await listPrds({ userId: authorFilter, status, ...(project ? { project } : {}) });
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get('/prds/:prdId', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const prd = await getPrd(req.params.prdId);
    if (!prd) {
      res.status(404).json({ error: 'PRD not found' });
      return;
    }
    res.json(prd);
  } catch (err) {
    next(err);
  }
});

router.get('/prds/:prdId/test-cases', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const prd = await getPrd(req.params.prdId);
    if (!prd) {
      res.status(404).json({ error: 'PRD not found' });
      return;
    }
    const testCaseRecord = await getTestCases(req.params.prdId);
    res.json(testCaseRecord);
  } catch (err) {
    next(err);
  }
});

router.delete('/prds/:prdId', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await deletePrd(req.params.prdId, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.put('/prds/:prdId/content', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { content } = req.body as { content: string };
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content must be a string' });
      return;
    }
    await updatePrdContent(req.params.prdId, userId, content);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /prds/:prdId/backlog — directly update the backlog JSON (author/owner only)
router.put('/prds/:prdId/backlog', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { backlogData } = req.body as { backlogData: unknown };
    if (backlogData === undefined || backlogData === null) {
      res.status(400).json({ error: 'backlogData is required' });
      return;
    }
    await updatePrdBacklog(req.params.prdId, userId, backlogData);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/prds/:prdId/submit', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { prdApproverIds, designDocApproverIds } = req.body as {
      prdApproverIds?: string[];
      designDocApproverIds?: string[];
    };
    await submitForReview(req.params.prdId, userId, {
      prdApproverIds: prdApproverIds ?? [],
      designDocApproverIds: designDocApproverIds ?? [],
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/prds/:prdId/withdraw', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await withdrawFromReview(req.params.prdId, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/reopen — admin-only: force any PRD back to pending_review
router.post('/prds/:prdId/reopen', requirePermission('admin:roles'), async (req, res, next) => {
  try {
    await reopenForReview(req.params.prdId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/prds/:prdId/review', requirePermission('prds:review'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as ReviewPrdRequest;
    const { approved } = await reviewPrd(req.params.prdId, userId, body);

    if (approved) {
      generateDesignPlan(req.params.prdId).catch(err => {
        console.error('[interviews] Design plan generation failed:', err);
      });
    }

    res.json({ ok: true, prdId: req.params.prdId, approved });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/sync — read PRD output from the generation thread and persist to DB
router.post('/prds/:prdId/sync', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const prd = await getPrd(req.params.prdId);
    if (!prd) {
      res.status(404).json({ error: 'PRD not found' });
      return;
    }
    if (!prd.chatThreadId) {
      res.status(400).json({ error: 'PRD has no associated chat thread' });
      return;
    }

    const content = readOutputPrd(prd.chatThreadId);
    const backlogJson = readOutputBacklog(prd.chatThreadId);

    if (!content) {
      res.status(404).json({ error: 'PRD output not yet available from generation thread' });
      return;
    }

    await syncPrdContent(req.params.prdId, content, backlogJson ?? undefined);
    res.json({ ok: true, content });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/design-docs — create a design doc from an approved PRD
router.post('/prds/:prdId/design-docs', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const prd = await getPrd(req.params.prdId);

    if (!prd) {
      res.status(404).json({ error: 'PRD not found' });
      return;
    }
    if (prd.status !== 'approved') {
      res.status(409).json({ error: 'Design docs can only be created from approved PRDs' });
      return;
    }

    const skillConfig = await getSkillConfig(prd.project);
    const designDocSkillPath = skillConfig?.designDocSkillPath ?? undefined;

    const freeformContext = [
      '# PRD Content',
      prd.content,
      ...(prd.backlogJson
        ? ['\n# Backlog', JSON.stringify(prd.backlogJson, null, 2)]
        : []),
    ].join('\n');

    const globalModel = await getDefaultModel();
    const model = skillConfig?.designDocModel ?? globalModel;

    const thread = await createThread(userId, {
      project: prd.project,
      repo: skillConfig?.skillRepo ?? prd.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillPath: designDocSkillPath,
      freeformContext,
      model,
    });

    const { designDocId } = await createDesignDoc({
      prdId: req.params.prdId,
      project: prd.project,
      userId,
      chatThreadId: thread.id,
      title: prd.title,
    });

    startDesignDocWatcher(designDocId, thread.id);

    res.status(201).json({ designDocId, threadId: thread.id });

  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/ado-work-items — push selected backlog items to Azure DevOps
router.post('/prds/:prdId/ado-work-items', requirePermission('workitems:write'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await createPrdAdoWorkItems(req.params.prdId, userId, req.body);
    res.status(201).json(result);
  } catch (err: any) {
    if (err.message?.includes('not found') || err.message?.includes('must be approved') || err.message?.includes('design doc')) {
      return res.status(422).json({ error: err.message });
    }
    next(err);
  }
});

// POST /prds/:prdId/sync-ado-status — verify stored ADO IDs, clear any that were deleted in ADO
router.post('/prds/:prdId/sync-ado-status', requirePermission('workitems:write'), async (req, res, next) => {
  try {
    const result = await syncPrdAdoStatus(req.params.prdId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── PRD Assistant thread (lazy-create, one per PRD) ──────────────────────────

router.post('/prds/:prdId/assistant-thread', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const prd = await getPrd(req.params.prdId);
    if (!prd) {
      res.status(404).json({ error: 'PRD not found' });
      return;
    }

    const skillConfig = await getSkillConfig(prd.project);
    const globalModel = await getDefaultModel();
    const model = skillConfig?.prdAssistantModel ?? globalModel;

    const comments = await getComments(req.params.prdId, 'prd');

    const buildPrdContext = (threadId: string) => {
      const parts: string[] = [
        '# PRD Assistant Context',
        `prd_id: ${req.params.prdId}`,
        `thread_id: ${threadId}`,
        '',
        '## IMPORTANT: How to Apply Changes',
        '',
        'When the user asks you to edit, add, update, refine, or change ANYTHING in the PRD content or backlog,',
        'you MUST call the `update_prd` MCP tool to save your changes. Do NOT just describe changes in chat.',
        '',
        '- To update PRD content: call `update_prd` with section="content" and the full revised markdown.',
        '- To update the backlog: call `update_prd` with section="backlog" and the full revised JSON string.',
        '- Always pass `threadId: "' + threadId + '"` and `prdId: "' + req.params.prdId + '"` when calling the tool.',
        '',
        'After you call `update_prd`, the changes will appear as a proposed diff that the PRD owner can review and accept or reject.',
        'This is the expected workflow — propose changes via the tool, then the owner reviews them.',
        '',
        '## PRD Content',
        prd.content || '(empty)',
        '',
        '## Backlog',
        JSON.stringify(prd.backlogJson, null, 2),
      ];

      if (comments.length > 0) {
        parts.push('', '## Review Comments');
        for (const comment of comments) {
          parts.push(
            '',
            `Author: ${comment.authorDisplayName ?? comment.authorUserId} | Section: ${comment.sectionKey ?? 'general'} | Status: ${comment.status}`,
            comment.selector?.exact ? `> ${comment.selector.exact}` : '',
            comment.body,
          );
          for (const reply of comment.replies ?? []) {
            parts.push(`  Reply (${reply.authorDisplayName ?? reply.authorUserId}): ${reply.body}`);
          }
        }
      }

      return parts.filter(line => line !== undefined).join('\n');
    };

    // Reuse existing thread — refresh context file with latest content
    const forceNew = req.body?.forceNew === true;
    if (prd.prdAssistantThreadId && !forceNew) {
      const [threadRow] = await db
        .select({ workspaceDir: chatThreadsTable.workspaceDir })
        .from(chatThreadsTable)
        .where(eq(chatThreadsTable.id, prd.prdAssistantThreadId))
        .limit(1);
      if (threadRow?.workspaceDir) {
        const contextPath = path.join(threadRow.workspaceDir, '.ai-pilot', 'kickoff-context.md');
        try {
          fs.writeFileSync(contextPath, buildPrdContext(prd.prdAssistantThreadId), 'utf-8');
        } catch {
          // Non-fatal: workspace may have been cleaned up
        }
      }
      res.json({ threadId: prd.prdAssistantThreadId });
      return;
    }

    const thread = await createThread(userId, {
      project: prd.project,
      repo: skillConfig?.skillRepo ?? prd.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillPath: skillConfig?.prdAssistantSkillPath ?? undefined,
      freeformContext: buildPrdContext('__THREAD_ID__'),
      model,
      assistantType: 'prd',
    }, {
      kickoffMessage:
        'Introduce yourself as Apex, the PRD assistant. ' +
        'In 3–5 short bullet points, summarize what you can help with in this context: ' +
        'editing PRD content, adding new requirements/sections, answering questions about the PRD, ' +
        'resolving review comments, and refining the backlog. ' +
        'Mention that when you make changes, they appear as a proposed diff for the owner to review and accept. ' +
        'Keep it concise and friendly — this is the first thing the user sees.',
    });

    // Rewrite context now that we have the real thread ID.
    // Also update the thread's in-memory kickoff so buildFreeChatPrompt injects
    // the correct thread_id into the system prompt (not the '__THREAD_ID__' placeholder).
    const realContext = buildPrdContext(thread.id);
    const contextPath = path.join(thread.workspaceDir, '.ai-pilot', 'kickoff-context.md');
    fs.writeFileSync(contextPath, realContext, 'utf-8');
    updateThreadKickoffContext(thread.id, realContext);

    await db
      .update(prdsTable)
      .set({ prdAssistantThreadId: thread.id, updatedAt: new Date().toISOString() })
      .where(eq(prdsTable.id, req.params.prdId));

    res.json({ threadId: thread.id });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/apply-proposed — atomically promote proposed content to live
// content and auto-resolve the comment(s) that the fix addressed.
// When triggered by a single-comment fix (fixCommentId is set) only that comment
// is resolved. When triggered by the bulk "Fix with Apex" button (fixCommentId is
// null) all open comments are resolved.
router.post('/prds/:prdId/apply-proposed', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const prdId = req.params.prdId;

    // Read the fixCommentId before the atomic update so we know which comment to resolve.
    const prdRow = await db.query.prds.findFirst({
      where: eq(prdsTable.id, prdId),
      columns: { fixCommentId: true },
    });
    const fixCommentId = prdRow?.fixCommentId ?? null;

    // Atomic update: copy proposed → live, clear proposed + fixCommentId columns.
    await db.execute(sql`
      UPDATE prds
      SET content = COALESCE(proposed_content, content),
          backlog_json = COALESCE(proposed_backlog_json, backlog_json),
          proposed_content = NULL,
          proposed_backlog_json = NULL,
          fix_comment_id = NULL,
          updated_at = NOW()
      WHERE id = ${prdId}
    `);

    // Resolve only the triggering comment (single fix) or all open comments (bulk fix).
    const now = new Date().toISOString();
    if (fixCommentId) {
      await db
        .update(reviewCommentsTable)
        .set({ status: 'resolved', resolvedBy: userId, resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(reviewCommentsTable.id, fixCommentId),
            eq(reviewCommentsTable.documentId, prdId),
            eq(reviewCommentsTable.documentType, 'prd'),
            eq(reviewCommentsTable.status, 'open'),
          ),
        );
    } else {
      await db
        .update(reviewCommentsTable)
        .set({ status: 'resolved', resolvedBy: userId, resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(reviewCommentsTable.documentId, prdId),
            eq(reviewCommentsTable.documentType, 'prd'),
            eq(reviewCommentsTable.status, 'open'),
          ),
        );
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/reject-proposed — discard proposed content
router.post('/prds/:prdId/reject-proposed', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const prd = await getPrd(req.params.prdId);
    if (!prd) {
      res.status(404).json({ error: 'PRD not found' });
      return;
    }

    await db
      .update(prdsTable)
      .set({ proposedContent: null, proposedBacklogJson: null, updatedAt: new Date().toISOString() } as any)
      .where(eq(prdsTable.id, req.params.prdId));

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/fix-with-ai — ask Bedrock to apply all open review comments
// and stage the result as proposedContent/proposedBacklogJson for the owner to accept/reject.
router.post('/prds/:prdId/fix-with-ai', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const prd = await getPrd(req.params.prdId);
    if (!prd) {
      res.status(404).json({ error: 'PRD not found' });
      return;
    }

    const allComments = await getComments(req.params.prdId, 'prd');
    const openComments = allComments.filter((c) => c.status === 'open');

    if (openComments.length === 0) {
      res.status(400).json({ error: 'No open comments to fix' });
      return;
    }

    const projectConfig = await getSkillConfig(prd.project);
    const bedrockModelId = projectConfig?.prdReviewBedrockModelId ?? null;
    const bedrockMaxTokens = projectConfig?.prdReviewBedrockMaxTokens ?? null;

    const mapComment = (c: typeof openComments[number]) => ({
      sectionKey: c.sectionKey,
      exact: c.selector?.exact ?? null,
      body: c.body,
      authorName: c.authorDisplayName ?? undefined,
      replies: c.replies.map((r) => ({
        authorName: r.authorDisplayName ?? undefined,
        body: r.body,
      })),
    });

    const prdComments = openComments.filter((c) => c.sectionKey === 'prd');
    const backlogComments = openComments.filter((c) => c.sectionKey === 'backlog');

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString(), fixCommentId: null };

    if (prdComments.length > 0) {
      const fixedContent = await fixPrdContentWithBedrock(
        prd.content ?? '',
        prdComments.map(mapComment),
        bedrockModelId,
        bedrockMaxTokens,
      );
      updates['proposedContent'] = fixedContent;
    }

    if (backlogComments.length > 0 && prd.backlogJson) {
      const fixedBacklog = await fixPrdBacklogWithBedrock(
        prd.backlogJson,
        backlogComments.map(mapComment),
        bedrockModelId,
        bedrockMaxTokens,
      );
      if (fixedBacklog != null) {
        updates['proposedBacklogJson'] = fixedBacklog;
      }
    }

    await db
      .update(prdsTable)
      .set(updates as any)
      .where(eq(prdsTable.id, req.params.prdId));

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof BedrockModelTruncatedError) {
      res.status(422).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// POST /prds/:prdId/fix-comment-with-ai — fix a SINGLE PRD comment
router.post('/prds/:prdId/fix-comment-with-ai', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const { commentId } = req.body as { commentId: string };

    const prd = await getPrd(req.params.prdId);
    if (!prd) {
      res.status(404).json({ error: 'PRD not found' });
      return;
    }

    const allComments = await getComments(req.params.prdId, 'prd');
    const comment = allComments.find((c) => c.id === commentId && c.status === 'open');
    if (!comment) {
      res.status(404).json({ error: 'Comment not found or not open' });
      return;
    }

    const projectConfig = await getSkillConfig(prd.project);
    const bedrockModelId = projectConfig?.prdReviewBedrockModelId ?? null;
    const bedrockMaxTokens = projectConfig?.prdReviewBedrockMaxTokens ?? null;

    const mapped = {
      sectionKey: comment.sectionKey,
      exact: comment.selector?.exact ?? null,
      body: comment.body,
      authorName: comment.authorDisplayName ?? undefined,
      replies: comment.replies.map((r) => ({
        authorName: r.authorDisplayName ?? undefined,
        body: r.body,
      })),
    };

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString(), fixCommentId: commentId };

    await db
      .update(prdsTable)
      .set({ fixCommentId: commentId, updatedAt: new Date().toISOString() })
      .where(eq(prdsTable.id, req.params.prdId));

    try {
      if (comment.sectionKey === 'prd') {
        updates['proposedContent'] = await fixPrdContentWithBedrock(
          prd.content ?? '',
          [mapped],
          bedrockModelId,
          bedrockMaxTokens,
        );
      } else if (comment.sectionKey === 'backlog') {
        const fixedBacklog = await fixPrdBacklogWithBedrock(
          prd.backlogJson,
          [mapped],
          bedrockModelId,
          bedrockMaxTokens,
        );
        if (fixedBacklog != null) {
          updates['proposedBacklogJson'] = fixedBacklog;
        }
      } else {
        await db
          .update(prdsTable)
          .set({ fixCommentId: null, updatedAt: new Date().toISOString() })
          .where(eq(prdsTable.id, req.params.prdId));
        res.status(400).json({ error: `Unknown PRD section key: ${comment.sectionKey}` });
        return;
      }

      await db
        .update(prdsTable)
        .set(updates as any)
        .where(eq(prdsTable.id, req.params.prdId));

      res.json({ ok: true });
    } catch (innerErr) {
      await db
        .update(prdsTable)
        .set({ fixCommentId: null, updatedAt: new Date().toISOString() })
        .where(eq(prdsTable.id, req.params.prdId));
      throw innerErr;
    }
  } catch (err) {
    if (err instanceof BedrockModelTruncatedError) {
      res.status(422).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ── PRD Validation ────────────────────────────────────────────────────────────

// POST /prds/:prdId/validation-thread — start (or re-run) PRD validation
router.post('/prds/:prdId/validation-thread', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const prd = await getPrd(req.params.prdId);
    if (!prd) { res.status(404).json({ error: 'PRD not found' }); return; }

    await autoStartPrdValidation(req.params.prdId);
    const updated = await getPrd(req.params.prdId);
    res.json({ threadId: updated?.validationThreadId ?? null });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/validation/cancel — cancel PRD validation
router.post('/prds/:prdId/validation/cancel', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await cancelPrdValidation(req.params.prdId, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/validation/refresh — sync PRD validation scorecard
router.post('/prds/:prdId/validation/refresh', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const prd = await getPrd(req.params.prdId);
    if (!prd) { res.status(404).json({ error: 'PRD not found' }); return; }

    const result = await syncPrdValidationResult(req.params.prdId);
    if (result) {
      res.json({ ok: true, score: result.score, is_ready: result.is_ready });
      return;
    }

    if (prd.status === 'validating') {
      res.json({ ok: true, still_validating: true, score: null, is_ready: false });
      return;
    }

    res.status(404).json({ error: 'Scorecard not yet available' });
  } catch (err) {
    next(err);
  }
});

// GET /prds/:prdId/validation/report — get PRD validation report markdown
router.get('/prds/:prdId/validation/report', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const prd = await getPrd(req.params.prdId);
    if (!prd) { res.status(404).json({ error: 'PRD not found' }); return; }

    let md = prd.validationReportMd;
    if (!md && prd.validationScorecard) {
      md = generateFallbackValidationReport(prd.validationScorecard);
    }
    if (!md) {
      if (prd.status === 'validating') {
        res.json({ markdown: null, still_validating: true });
        return;
      }
      res.status(404).json({ error: 'Validation report not yet available' });
      return;
    }

    res.json({ markdown: md });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/validation/mark-ready — mark PRD as ready (score >= 90)
router.post('/prds/:prdId/validation/mark-ready', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await markPrdValidationReady(req.params.prdId, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/fix-validation — trigger AI fix for PRD validation gaps
router.post('/prds/:prdId/fix-validation', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await triggerFixPrdValidation(req.params.prdId, userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /prds/:prdId/fix-validation/accept — accept fix + re-validate
router.post('/prds/:prdId/fix-validation/accept', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    await acceptFixPrdValidation(req.params.prdId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /prds/:prdId/revert-section — revert to baseline
router.patch('/prds/:prdId/revert-section', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await revertPrdSection(req.params.prdId, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Design Docs ───────────────────────────────────────────────────────────────

router.get('/design-docs', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const status = req.query.status as DesignDocStatus | undefined;
    const project = req.query.project as string | undefined;
    const prdId = req.query.prdId as string | undefined;
    const authorFilter = req.query.author === 'me' ? userId : undefined;
    const list = await listDesignDocs({
      ...(prdId ? { prdId } : {}),
      ...(authorFilter ? { userId: authorFilter } : {}),
      status,
      ...(project ? { project } : {}),
    });
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.get('/design-docs/:id', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const doc = await getDesignDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Design doc not found' });
      return;
    }
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

router.put('/design-docs/:id/content', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { designContent, techSpecContent, assumptionsContent } = req.body as {
      designContent?: string;
      techSpecContent?: string;
      assumptionsContent?: string;
    };

    if (
      designContent !== undefined && typeof designContent !== 'string' ||
      techSpecContent !== undefined && typeof techSpecContent !== 'string' ||
      assumptionsContent !== undefined && typeof assumptionsContent !== 'string'
    ) {
      res.status(400).json({ error: 'content fields must be strings' });
      return;
    }

    if (designContent === undefined && techSpecContent === undefined && assumptionsContent === undefined) {
      res.status(400).json({ error: 'at least one content field must be provided' });
      return;
    }

    await updateDesignDocContent(req.params.id, userId, { designContent, techSpecContent, assumptionsContent });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/design-docs/:id/submit', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { approverIds } = req.body as { approverIds?: string[] };
    await submitDesignDocForReview(req.params.id, userId, {
      approverIds: approverIds ?? undefined,
    });
    // Auto-start validation in the background if a validation skill is configured.
    // This takes the doc directly from pending_review → validating without requiring
    // the user to manually click "Run Validation".
    autoStartValidation(req.params.id).catch((err) => {
      console.error(`[submit] autoStartValidation failed (docId=${req.params.id})`, err);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/design-docs/:id/withdraw', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await withdrawDesignDocFromReview(req.params.id, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/design-docs/:id/review', requirePermission('design-docs:review'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as ReviewDesignDocRequest;
    await reviewDesignDoc(req.params.id, userId, body);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/design-docs/:id/sync', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const doc = await getDesignDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Design doc not found' });
      return;
    }
    if (!doc.chatThreadId) {
      res.status(400).json({ error: 'Design doc has no associated chat thread' });
      return;
    }

    const designContent = readOutputDesignDoc(doc.chatThreadId);
    const techSpecContent = readOutputTechSpec(doc.chatThreadId);
    const assumptionsContent = readOutputAssumptions(doc.chatThreadId);

    if (!designContent && !techSpecContent && !assumptionsContent) {
      res.status(404).json({ error: 'Design doc output not yet available from generation thread' });
      return;
    }

    const syncOpts: Parameters<typeof syncDesignDocContent>[1] = {};
    if (designContent) syncOpts.designContent = designContent;
    if (techSpecContent) syncOpts.techSpecContent = techSpecContent;
    if (assumptionsContent) syncOpts.assumptionsContent = assumptionsContent;
    const allPresent = !!designContent && !!techSpecContent && !!assumptionsContent;
    if (allPresent) syncOpts.finalStatus = 'draft';

    await syncDesignDocContent(req.params.id, syncOpts);
    res.json({ ok: true, designContent, techSpecContent, assumptionsContent });
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/retry-generate — re-trigger generation for a stuck seed doc
router.post('/design-docs/:id/retry-generate', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const doc = await getDesignDoc(req.params.id);
    if (!doc) { res.status(404).json({ error: 'Design doc not found' }); return; }
    if (doc.status !== 'generating') {
      res.status(409).json({ error: `Design doc is not in generating status (current: ${doc.status})` });
      return;
    }

    const skillConfig = await getSkillConfig(doc.project);
    const prd = await getPrd(doc.prdId);
    const freeformContext = [
      '# PRD Content',
      prd?.content ?? '(empty)',
      ...(prd?.backlogJson ? ['\n# Backlog', JSON.stringify(prd.backlogJson, null, 2)] : []),
    ].join('\n');

    const globalModel = await getDefaultModel();
    const model = skillConfig?.designDocModel ?? globalModel;

    const thread = await createThread(userId, {
      project: doc.project,
      repo: skillConfig?.skillRepo ?? doc.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillPath: skillConfig?.designDocSkillPath ?? undefined,
      freeformContext,
      model,
    });

    await db
      .update(designDocsTable)
      .set({ chatThreadId: thread.id, updatedAt: new Date().toISOString() })
      .where(eq(designDocsTable.id, req.params.id));

    startDesignDocWatcher(req.params.id, thread.id);

    res.json({ ok: true, threadId: thread.id });
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/generate — finish Q&A phase, create generation thread, start watcher
router.post('/design-docs/:id/generate', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const doc = await getDesignDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Design doc not found' });
      return;
    }
    if (doc.status !== 'interviewing') {
      res.status(409).json({ error: `Design doc is not in interviewing status (current: ${doc.status})` });
      return;
    }
    if (!doc.qaChatThreadId) {
      res.status(400).json({ error: 'Design doc has no Q&A thread' });
      return;
    }

    // Check if the Q&A thread already produced the output artifacts.
    // Multi-feature check first: if the agent wrote multiple feature triplets,
    // create separate design doc rows for each instead of writing to the seed row.
    const qaFeatures = readAllOutputDesignDocFeatures(doc.qaChatThreadId);
    if (qaFeatures.length > 1) {
      console.log(`[designDoc] Q&A produced ${qaFeatures.length} feature triplets — creating per-feature rows (designDocId=${req.params.id})`);
      await syncPerFeatureDesignDocs(req.params.id, doc.prdId, doc.project, doc.authorId, doc.qaChatThreadId);
      res.json({ ok: true });
      return;
    }

    // Single-feature fast path: check workspace files then fall back to DB content
    const qaDesign = readOutputDesignDoc(doc.qaChatThreadId);
    const qaTechSpec = readOutputTechSpec(doc.qaChatThreadId);
    const qaAssumptions = readOutputAssumptions(doc.qaChatThreadId);

    const hasAllInWorkspace = qaDesign !== null && qaTechSpec !== null && qaAssumptions !== null;
    const hasAllInDb = !!doc.designContent && !!doc.techSpecContent && !!doc.assumptionsContent;

    if (hasAllInWorkspace || hasAllInDb) {
      const designContent = qaDesign ?? doc.designContent!;
      const techSpecContent = qaTechSpec ?? doc.techSpecContent!;
      const assumptionsContent = qaAssumptions ?? doc.assumptionsContent!;

      console.log(`[designDoc] Q&A already produced all artifacts (source=${hasAllInWorkspace ? 'workspace' : 'db'}) — syncing directly (designDocId=${req.params.id})`);
      const skillConfig = await getSkillConfig(doc.project);
      const finalStatus = skillConfig?.designDocValidationSkillPath ? 'validating' : 'pending_review';
      await syncDesignDocContent(req.params.id, {
        designContent,
        techSpecContent,
        assumptionsContent,
        finalStatus,
      });
      if (finalStatus === 'validating') {
        autoStartValidation(req.params.id).catch((err) => {
          console.error(`[designDoc] autoStartValidation failed on fast-path generate (designDocId=${req.params.id})`, err);
        });
      }
      res.json({ ok: true });
      return;
    }

    // Read Q&A thread messages to build transcript
    const qaThread = await getThreadAsync(doc.qaChatThreadId);
    const transcriptLines: string[] = ['# Design Doc Q&A Transcript', ''];
    if (qaThread) {
      for (const msg of qaThread.messages) {
        if (msg.role === 'user' && msg.text !== 'Begin.') {
          transcriptLines.push(`**User:** ${msg.text}`, '');
        } else if (msg.role === 'agent') {
          transcriptLines.push(`**Agent:** ${msg.text}`, '');
        }
      }
    }
    const transcript = transcriptLines.join('\n');

    const skillConfig = await getSkillConfig(doc.project);
    const designDocSkillPath = skillConfig?.designDocSkillPath ?? undefined;
    const globalModel = await getDefaultModel();
    const model = skillConfig?.designDocModel ?? globalModel;

    const thread = await createThread(userId, {
      project: doc.project,
      repo: skillConfig?.skillRepo ?? doc.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillPath: designDocSkillPath,
      transcript,
      model,
    });

    // Update design doc: set generation thread ID and transition to generating
    await db
      .update(designDocsTable)
      .set({
        chatThreadId: thread.id,
        status: 'generating',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(designDocsTable.id, req.params.id));

    startDesignDocWatcher(req.params.id, thread.id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Design Doc Assistant thread (lazy-create, one per doc) ───────────────────

router.post('/design-docs/:id/assistant-thread', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const doc = await getDesignDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Design doc not found' });
      return;
    }

    const skillConfig = await getSkillConfig(doc.project);
    const globalModel = await getDefaultModel();
    const model = skillConfig?.designDocAssistantModel ?? globalModel;

    // Fetch the source PRD for additional context
    const prd = await getPrd(doc.prdId);

    const buildDocContext = (threadId: string) => [
      '# Design Doc Assistant Context',
      `doc_id: ${req.params.id}`,
      `thread_id: ${threadId}`,
      `status: ${doc.status}`,
      '',
      '> Use the `update_design_doc` MCP tool to apply edits back to the database.',
      '> Pass the doc_id and thread_id values above when calling the tool.',
      '',
      ...(prd ? [
        '## Source PRD',
        prd.content || '(empty)',
        '',
      ] : []),
      '## Design',
      doc.designContent || '(empty)',
      '',
      '## Tech Spec',
      doc.techSpecContent || '(empty)',
      '',
      '## Assumptions',
      doc.assumptionsContent || '(empty)',
    ].join('\n');

    // Return existing thread if already created, but refresh kickoff context
    // so the assistant always sees the latest doc content from the database.
    // If forceNew is set, skip reuse and create a fresh thread below.
    if (doc.docAssistantThreadId && !req.body?.forceNew) {
      const [threadRow] = await db
        .select({ workspaceDir: chatThreadsTable.workspaceDir })
        .from(chatThreadsTable)
        .where(eq(chatThreadsTable.id, doc.docAssistantThreadId))
        .limit(1);
      if (threadRow?.workspaceDir) {
        const contextPath = path.join(threadRow.workspaceDir, '.ai-pilot', 'kickoff-context.md');
        try {
          fs.writeFileSync(contextPath, buildDocContext(doc.docAssistantThreadId), 'utf-8');
        } catch {
          // Non-fatal: workspace may have been cleaned up; the thread can still run
        }
      }
      res.json({ threadId: doc.docAssistantThreadId });
      return;
    }

    const mayCreate = await canCreateDesignDocAssistantThread(userId, req.params.id);
    if (!mayCreate) {
      res.status(403).json({
        error: 'Only the document author, an admin, or an assigned approver can create the assistant thread',
      });
      return;
    }

    const thread = await createThread(userId, {
      project: doc.project,
      repo: skillConfig?.skillRepo ?? doc.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillPath: skillConfig?.designDocAssistantSkillPath ?? undefined,
      freeformContext: buildDocContext('__THREAD_ID__'),
      model,
    }, { skipAutoKickoff: true });

    // Rewrite the context file now that we have the real thread ID.
    // Also update the thread's in-memory kickoff so buildFreeChatPrompt injects
    // the correct thread_id into the system prompt (not the '__THREAD_ID__' placeholder).
    const realDocContext = buildDocContext(thread.id);
    const contextPath = path.join(thread.workspaceDir, '.ai-pilot', 'kickoff-context.md');
    fs.writeFileSync(contextPath, realDocContext, 'utf-8');
    updateThreadKickoffContext(thread.id, realDocContext);

    await db
      .update(designDocsTable)
      .set({ docAssistantThreadId: thread.id, updatedAt: new Date().toISOString() })
      .where(eq(designDocsTable.id, req.params.id));

    res.json({ threadId: thread.id });
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/validation-thread — start (or re-start) a validation run
router.post('/design-docs/:id/validation-thread', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const doc = await getDesignDoc(req.params.id);
    if (!doc) { res.status(404).json({ error: 'Design doc not found' }); return; }

    await autoStartValidation(req.params.id);
    const updated = await getDesignDoc(req.params.id);
    res.json({ threadId: updated?.validationThreadId ?? null });
  } catch (err) {
    next(err);
  }
});

// GET /design-docs/:id/validation — get validation state
router.get('/design-docs/:id/validation', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const doc = await getDesignDoc(req.params.id);
    if (!doc) { res.status(404).json({ error: 'Design doc not found' }); return; }
    res.json({
      validationThreadId: doc.validationThreadId ?? null,
      validationScore: doc.validationScore ?? null,
      validationScorecard: doc.validationScorecard ?? null,
      validationPhase: doc.validationPhase ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/validation/refresh — re-read scorecard from workspace (or DB) and sync status
router.post('/design-docs/:id/validation/refresh', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const doc = await getDesignDoc(req.params.id);
    if (!doc) { res.status(404).json({ error: 'Design doc not found' }); return; }
    if (!doc.validationThreadId) { res.status(400).json({ error: 'No validation thread exists' }); return; }

    const scorecardRaw = readOutputValidationScorecard(doc.validationThreadId);
    if (scorecardRaw) {
      const scorecard = JSON.parse(scorecardRaw);
      const reportMd = readOutputValidationScorecardMd(doc.validationThreadId) ?? undefined;
      await syncValidationResult(req.params.id, scorecard, reportMd);
      res.json({ ok: true, score: scorecard.overall_score, is_ready: scorecard.is_ready });
      return;
    }

    if (doc.validationScorecard && doc.status !== 'validating') {
      await syncValidationResult(req.params.id, doc.validationScorecard, doc.validationReportMd ?? undefined);
      res.json({ ok: true, score: doc.validationScorecard.overall_score, is_ready: doc.validationScorecard.is_ready });
      return;
    }

    if (doc.status === 'validating') {
      res.json({ ok: true, still_validating: true, score: null, is_ready: false });
      return;
    }

    res.status(404).json({ error: 'Scorecard not yet available' });
  } catch (err) {
    next(err);
  }
});

// GET /design-docs/:id/validation/report — return human-readable scorecard markdown
router.get('/design-docs/:id/validation/report', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const doc = await getDesignDoc(req.params.id);
    if (!doc) { res.status(404).json({ error: 'Design doc not found' }); return; }

    let md = doc.validationReportMd;
    if (!md && doc.validationScorecard) {
      md = generateFallbackReport(doc.validationScorecard);
      await syncValidationResult(req.params.id, doc.validationScorecard, md);
    }
    if (!md) {
      if (doc.status === 'validating') {
        res.json({ markdown: null, still_validating: true });
        return;
      }
      res.status(404).json({ error: 'Validation report not yet available' });
      return;
    }

    res.json({ markdown: md });
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/validation/cancel — stop validation and return to draft
router.post('/design-docs/:id/validation/cancel', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await cancelValidation(req.params.id, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/validation/mark-ready — manually transition validating → draft when score >= 90
router.post('/design-docs/:id/validation/mark-ready', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await markValidationReady(req.params.id, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/fix-validation — trigger AI fix for validation gaps
router.post('/design-docs/:id/fix-validation', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const result = await triggerFixValidation(req.params.id, userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/fix-validation/accept — clear baseline and re-run validation
router.post('/design-docs/:id/fix-validation/accept', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    await acceptFixValidation(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/design-docs/:id', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await deleteDesignDoc(req.params.id, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ── Approver Assignments ──────────────────────────────────────────────────────

router.get('/prds/:prdId/assignments', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const assignments = await getAssignments(req.params.prdId, 'prd');
    res.json(assignments);
  } catch (err) {
    next(err);
  }
});

router.get('/design-docs/:id/assignments', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const assignments = await getAssignments(req.params.id, 'design_doc');
    res.json(assignments);
  } catch (err) {
    next(err);
  }
});

router.put('/prds/:prdId/assignments', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const { approverUserIds, designDocApproverIds } = req.body as { approverUserIds?: string[]; designDocApproverIds?: string[] };
    if (!approverUserIds || !Array.isArray(approverUserIds)) {
      res.status(400).json({ error: 'approverUserIds is required and must be an array' });
      return;
    }
    const userId = getUserId(req);
    const prd = await getPrd(req.params.prdId);
    if (!prd) {
      res.status(404).json({ error: 'PRD not found' });
      return;
    }
    const isOwnerOrAuthor = prd.authorId === userId || prd.ownerId === userId;
    if (!isOwnerOrAuthor && !(await isAdminUser(userId))) {
      res.status(403).json({ error: 'Only the document owner, author, or admin can reassign approvers' });
      return;
    }
    if (Array.isArray(designDocApproverIds)) {
      await updatePrdDesignDocApprovers(req.params.prdId, designDocApproverIds);
    }
    const assignments = await reassignApprovers(req.params.prdId, 'prd', approverUserIds, userId);
    res.json(assignments);
  } catch (err) {
    next(err);
  }
});

router.put('/design-docs/:id/assignments', requirePermission('admin:roles'), async (req, res, next) => {
  try {
    const { approverUserIds } = req.body as { approverUserIds?: string[] };
    if (!approverUserIds || !Array.isArray(approverUserIds)) {
      res.status(400).json({ error: 'approverUserIds is required and must be an array' });
      return;
    }
    const userId = getUserId(req);
    const assignments = await reassignApprovers(req.params.id, 'design_doc', approverUserIds, userId);
    res.json(assignments);
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/fix-with-ai — fix ALL open comments across all sections
router.post('/design-docs/:id/fix-with-ai', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const doc = await getDesignDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Design doc not found' });
      return;
    }

    const allComments = await getComments(req.params.id, 'design_doc');
    const openComments = allComments.filter((c) => c.status === 'open');

    if (openComments.length === 0) {
      res.status(400).json({ error: 'No open comments to fix' });
      return;
    }

    const projectConfig = await getSkillConfig(doc.project);
    const bedrockModelId = projectConfig?.prdReviewBedrockModelId ?? null;
    const bedrockMaxTokens = projectConfig?.prdReviewBedrockMaxTokens ?? null;

    const mapComment = (c: typeof openComments[number]) => ({
      sectionKey: c.sectionKey,
      exact: c.selector?.exact ?? null,
      body: c.body,
      authorName: c.authorDisplayName ?? undefined,
      replies: c.replies.map((r) => ({
        authorName: r.authorDisplayName ?? undefined,
        body: r.body,
      })),
    });

    const designComments = openComments.filter((c) => c.sectionKey === 'design');
    const techSpecComments = openComments.filter((c) => c.sectionKey === 'tech_spec');
    const assumptionsComments = openComments.filter((c) => c.sectionKey === 'assumptions');

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString(), fixCommentId: null };

    if (designComments.length > 0) {
      const fixed = await fixDesignDocSectionWithBedrock(
        doc.designContent ?? '',
        'Design',
        designComments.map(mapComment),
        bedrockModelId,
        bedrockMaxTokens,
      );
      updates['proposedDesignContent'] = fixed;
    }

    if (techSpecComments.length > 0) {
      const fixed = await fixDesignDocSectionWithBedrock(
        doc.techSpecContent ?? '',
        'Tech Spec',
        techSpecComments.map(mapComment),
        bedrockModelId,
        bedrockMaxTokens,
      );
      updates['proposedTechSpecContent'] = fixed;
    }

    if (assumptionsComments.length > 0) {
      const fixed = await fixDesignDocSectionWithBedrock(
        doc.assumptionsContent ?? '',
        'Assumptions',
        assumptionsComments.map(mapComment),
        bedrockModelId,
        bedrockMaxTokens,
      );
      updates['proposedAssumptionsContent'] = fixed;
    }

    await db
      .update(designDocsTable)
      .set(updates as any)
      .where(eq(designDocsTable.id, req.params.id));

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof BedrockModelTruncatedError) {
      res.status(422).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// POST /design-docs/:id/fix-comment-with-ai — fix a SINGLE comment
router.post('/design-docs/:id/fix-comment-with-ai', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const { commentId } = req.body as { commentId: string };

    const doc = await getDesignDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Design doc not found' });
      return;
    }

    const allComments = await getComments(req.params.id, 'design_doc');
    const comment = allComments.find((c) => c.id === commentId && c.status === 'open');
    if (!comment) {
      res.status(404).json({ error: 'Comment not found or not open' });
      return;
    }

    const projectConfig = await getSkillConfig(doc.project);
    const bedrockModelId = projectConfig?.prdReviewBedrockModelId ?? null;
    const bedrockMaxTokens = projectConfig?.prdReviewBedrockMaxTokens ?? null;

    const mapped = {
      sectionKey: comment.sectionKey,
      exact: comment.selector?.exact ?? null,
      body: comment.body,
      authorName: comment.authorDisplayName ?? undefined,
      replies: comment.replies.map((r) => ({
        authorName: r.authorDisplayName ?? undefined,
        body: r.body,
      })),
    };

    const sectionKey = comment.sectionKey;
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString(), fixCommentId: commentId };

    await db
      .update(designDocsTable)
      .set({ fixCommentId: commentId, updatedAt: new Date().toISOString() })
      .where(eq(designDocsTable.id, req.params.id));

    try {
      if (sectionKey === 'design') {
        updates['proposedDesignContent'] = await fixDesignDocSectionWithBedrock(
          doc.designContent ?? '',
          'Design',
          [mapped],
          bedrockModelId,
          bedrockMaxTokens,
        );
      } else if (sectionKey === 'tech_spec') {
        updates['proposedTechSpecContent'] = await fixDesignDocSectionWithBedrock(
          doc.techSpecContent ?? '',
          'Tech Spec',
          [mapped],
          bedrockModelId,
          bedrockMaxTokens,
        );
      } else if (sectionKey === 'assumptions') {
        updates['proposedAssumptionsContent'] = await fixDesignDocSectionWithBedrock(
          doc.assumptionsContent ?? '',
          'Assumptions',
          [mapped],
          bedrockModelId,
          bedrockMaxTokens,
        );
      } else {
        await db
          .update(designDocsTable)
          .set({ fixCommentId: null, updatedAt: new Date().toISOString() })
          .where(eq(designDocsTable.id, req.params.id));
        res.status(400).json({ error: `Unknown section key: ${sectionKey}` });
        return;
      }

      await db
        .update(designDocsTable)
        .set(updates as any)
        .where(eq(designDocsTable.id, req.params.id));

      res.json({ ok: true });
    } catch (innerErr) {
      await db
        .update(designDocsTable)
        .set({ fixCommentId: null, updatedAt: new Date().toISOString() })
        .where(eq(designDocsTable.id, req.params.id));
      throw innerErr;
    }
  } catch (err) {
    if (err instanceof BedrockModelTruncatedError) {
      res.status(422).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// POST /design-docs/:id/apply-proposed — atomically promote proposed → live and auto-resolve
// the comment(s) that the fix addressed.
// When triggered by a single-comment fix (fixCommentId is set) only that comment is resolved.
// When triggered by the bulk "Fix with Apex" button (fixCommentId is null) all open comments
// are resolved.
router.post('/design-docs/:id/apply-proposed', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const docId = req.params.id;

    // Read the fixCommentId before the atomic update so we know which comment to resolve.
    const docRow = await db.query.designDocs.findFirst({
      where: eq(designDocsTable.id, docId),
      columns: { fixCommentId: true },
    });
    const fixCommentId = docRow?.fixCommentId ?? null;

    await db.execute(sql`
      UPDATE design_docs
      SET design_content = COALESCE(proposed_design_content, design_content),
          tech_spec_content = COALESCE(proposed_tech_spec_content, tech_spec_content),
          assumptions_content = COALESCE(proposed_assumptions_content, assumptions_content),
          proposed_design_content = NULL,
          proposed_tech_spec_content = NULL,
          proposed_assumptions_content = NULL,
          fix_comment_id = NULL,
          updated_at = NOW()
      WHERE id = ${docId}
    `);

    // Resolve only the triggering comment (single fix) or all open comments (bulk fix).
    const now = new Date().toISOString();
    if (fixCommentId) {
      await db
        .update(reviewCommentsTable)
        .set({ status: 'resolved', resolvedBy: userId, resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(reviewCommentsTable.id, fixCommentId),
            eq(reviewCommentsTable.documentId, docId),
            eq(reviewCommentsTable.documentType, 'design_doc'),
            eq(reviewCommentsTable.status, 'open'),
          ),
        );
    } else {
      await db
        .update(reviewCommentsTable)
        .set({ status: 'resolved', resolvedBy: userId, resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(reviewCommentsTable.documentId, docId),
            eq(reviewCommentsTable.documentType, 'design_doc'),
            eq(reviewCommentsTable.status, 'open'),
          ),
        );
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /design-docs/:id/reject-proposed — discard proposed changes
router.post('/design-docs/:id/reject-proposed', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const doc = await getDesignDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Design doc not found' });
      return;
    }

    await db
      .update(designDocsTable)
      .set({ proposedDesignContent: null, proposedTechSpecContent: null, proposedAssumptionsContent: null, updatedAt: new Date().toISOString() } as any)
      .where(eq(designDocsTable.id, req.params.id));

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/available-approvers/:project/:documentType', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const { project, documentType } = req.params;
    if (documentType !== 'prd' && documentType !== 'design_doc') {
      res.status(400).json({ error: 'documentType must be "prd" or "design_doc"' });
      return;
    }
    const userId = getUserId(req);
    const excludeSelf = req.query.excludeSelf === 'true';
    const approvers = await getAvailableApprovers(project, documentType, excludeSelf ? userId : undefined);
    res.json(approvers);
  } catch (err) {
    next(err);
  }
});

// ── Interview detail/update/delete ────────────────────────────────────────────

router.get('/:id', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const interview = await getInterview(req.params.id);
    if (!interview) {
      res.status(404).json({ error: 'Interview not found' });
      return;
    }
    res.json(interview);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { status, title } = req.body as { status?: string; title?: string };
    if (status) await updateInterviewStatus(req.params.id, userId, status as InterviewStatus);
    if (title) await updateInterviewTitle(req.params.id, userId, title);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    await deleteInterview(req.params.id, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/:interviewId/prds', requirePermission('interviews:manage'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { chatThreadId, title } = req.body as { chatThreadId: string; title?: string };

    if (!chatThreadId) {
      res.status(400).json({ error: 'chatThreadId is required' });
      return;
    }

    const interview = await getInterview(req.params.interviewId);
    if (!interview) {
      res.status(404).json({ error: 'Interview not found' });
      return;
    }

    const result = await createPrd({
      interviewId: req.params.interviewId,
      project: interview.project,
      userId,
      chatThreadId,
      title,
    });
    startPrdWatcher(result.prdId, chatThreadId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
