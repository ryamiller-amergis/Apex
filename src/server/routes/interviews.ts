import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { db } from '../db/drizzle';
import { eq } from 'drizzle-orm';
import { designDocs as designDocsTable, chatThreads as chatThreadsTable } from '../db/schema';
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
  updatePrdContent,
  withdrawFromReview,
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
import { readOutputBacklog, readOutputDesignDoc, readOutputTechSpec, readOutputAssumptions, readOutputPrd, readOutputValidationScorecard, readOutputValidationScorecardMd, readAllOutputDesignDocFeatures, createThread, getThreadAsync } from '../services/chatAgentService';
import { getSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import { getAssignments, getAvailableApprovers, reassignApprovers } from '../services/documentApprovalService';
import { canCreateDesignDocAssistantThread } from '../services/threadAccessService';
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
    const { project, repo, title, chatThreadId, prdOwnerId, designDocOwnerId } = req.body as {
      project: string;
      repo: string;
      title?: string;
      chatThreadId: string;
      prdOwnerId?: string;
      designDocOwnerId?: string;
    };

    if (!project || !repo || !chatThreadId) {
      res.status(400).json({ error: 'project, repo, and chatThreadId are required' });
      return;
    }

    const result = await createInterview({ userId, project, repo, title, chatThreadId, prdOwnerId, designDocOwnerId });
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
    await reviewPrd(req.params.prdId, userId, body);

    if (body.action === 'approve') {
      try {
        const prd = await getPrd(req.params.prdId);
        if (!prd) {
          res.json({ ok: true });
          return;
        }

        const skillConfig = await getSkillConfig(prd.project);
        const globalModel = await getDefaultModel();

        const prdFreeformContext = [
          '# PRD Content',
          prd.content,
          ...(prd.backlogJson
            ? ['\n# Backlog', JSON.stringify(prd.backlogJson, null, 2)]
            : []),
        ].join('\n');

        if (skillConfig?.designDocQaSkillPath) {
          // ── Q&A phase: create interview thread, defer generation ──────────
          const qaModel = skillConfig.designDocQaModel ?? globalModel;
          const qaThread = await createThread(userId, {
            project: prd.project,
            repo: skillConfig.skillRepo,
            branch: skillConfig.skillBranch ?? 'main',
            skillPath: skillConfig.designDocQaSkillPath,
            freeformContext: prdFreeformContext,
            model: qaModel,
          });

          const { designDocId } = await createDesignDoc({
            prdId: req.params.prdId,
            project: prd.project,
            userId,
            qaChatThreadId: qaThread.id,
            title: prd.title,
            status: 'interviewing',
          });

          res.json({ ok: true, designDocId });
          return;
        } else {
          // ── No Q&A: go straight to generation (original behavior) ─────────
          const designDocSkillPath = skillConfig?.designDocSkillPath ?? undefined;
          const model = skillConfig?.designDocModel ?? globalModel;

          const thread = await createThread(userId, {
            project: prd.project,
            repo: skillConfig?.skillRepo ?? prd.project,
            branch: skillConfig?.skillBranch ?? 'main',
            skillPath: designDocSkillPath,
            freeformContext: prdFreeformContext,
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

          res.json({ ok: true, designDocId });
          return;
        }
      } catch {
        // Design doc creation failed — PRD is still approved
        res.json({ ok: true });
        return;
      }
    }

    res.json({ ok: true });
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

    // Rewrite the context file now that we have the real thread ID
    const contextPath = path.join(thread.workspaceDir, '.ai-pilot', 'kickoff-context.md');
    fs.writeFileSync(contextPath, buildDocContext(thread.id), 'utf-8');

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

router.put('/prds/:prdId/assignments', requirePermission('admin:roles'), async (req, res, next) => {
  try {
    const { approverUserIds } = req.body as { approverUserIds?: string[] };
    if (!approverUserIds || !Array.isArray(approverUserIds)) {
      res.status(400).json({ error: 'approverUserIds is required and must be an array' });
      return;
    }
    const userId = getUserId(req);
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
