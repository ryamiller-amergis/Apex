import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { db } from '../db/drizzle';
import { adrs as adrsTable, chatThreads } from '../db/schema';
import {
  applyAdrProposedContent,
  createAdr,
  deleteAdr,
  getAdr,
  listAdrs,
  markAdrGenerating,
  rejectAdrProposedContent,
  setAdrAssistantThread,
  stageAdrReviewFix,
  startAdrWatcher,
  updateAdrStatus,
  updateAdrTitle,
} from '../services/adrService';
import { createThread, getThread, updateThreadKickoffContext } from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import type { AdrStatus } from '../../shared/types/adr';
import { listGroupsWithMembers } from '../services/groupService';
import {
  getAssignments,
  isApprovalComplete,
  isAssignedApprover,
  removeApproverAssignments,
  reassignApprovers,
  recordApproverResponse,
} from '../services/documentApprovalService';
import { getOwnerApproval, recordOwnerApproval } from '../services/ownerApprovalService';
import { getComments, getUnresolvedCount } from '../services/reviewCommentService';
import { createNotification } from '../services/notificationService';
import { fixAdrContentWithBedrock, BedrockModelTruncatedError } from '../services/bedrockService';
import type { OwnerApproveRequest } from '../../shared/types/approvals';

const router = Router();

router.get('/', requirePermission('adr:view'), async (req, res, next) => {
  try {
    const status = req.query.status as AdrStatus | undefined;
    const project = req.query.project as string | undefined;
    const authorId = req.query.author === 'me' ? getUserId(req) : undefined;
    res.json(await listAdrs({ status, project, authorId }));
  } catch (error) {
    next(error);
  }
});

router.get('/reviewer-candidates', requirePermission('adr:create'), async (req, res, next) => {
  try {
    const project = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    const groups = await listGroupsWithMembers(project);
    const developerGroup = groups.find((group) => group.name === 'Developer');
    const ownerId = getUserId(req);
    res.json((developerGroup?.members ?? [])
      .filter((member) => member.userId !== ownerId)
      .map((member) => ({
        id: member.userId,
        displayName: member.displayName ?? member.email ?? member.userId,
        email: member.email,
      })));
  } catch (error) {
    next(error);
  }
});

router.post('/', requirePermission('adr:create'), async (req, res, next) => {
  try {
    const { project, repo, title, chatThreadId, model, skillSettingsId, reviewerIds } = req.body as {
      project?: string;
      repo?: string;
      title?: string;
      chatThreadId?: string;
      model?: string;
      skillSettingsId?: string;
      reviewerIds?: string[];
    };
    if (!project || !repo || !title?.trim() || !chatThreadId) {
      res.status(400).json({ error: 'project, repo, title, and chatThreadId are required' });
      return;
    }
    if (reviewerIds !== undefined && (!Array.isArray(reviewerIds) || reviewerIds.some((id) => typeof id !== 'string'))) {
      res.status(400).json({ error: 'reviewerIds must be an array of user IDs' });
      return;
    }
    const result = await createAdr({
      userId: getUserId(req),
      project,
      repo,
      title: title.trim(),
      chatThreadId,
      model,
      skillSettingsId,
      reviewerIds,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', requirePermission('adr:view'), async (req, res, next) => {
  try {
    const adr = await getAdr(req.params.id);
    if (!adr) {
      res.status(404).json({ error: 'ADR not found' });
      return;
    }
    res.json(adr);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', requirePermission('adr:edit'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { title, status } = req.body as { title?: string; status?: AdrStatus };
    if (title !== undefined) {
      if (!title.trim()) {
        res.status(400).json({ error: 'title must not be empty' });
        return;
      }
      await updateAdrTitle(req.params.id, userId, title.trim());
    }
    if (status !== undefined) await updateAdrStatus(req.params.id, userId, status);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requirePermission('adr:delete'), async (req, res, next) => {
  try {
    await deleteAdr(req.params.id, getUserId(req));
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.post('/:id/generate', requirePermission('adr:edit'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const adr = await getAdr(req.params.id);
    if (!adr) {
      res.status(404).json({ error: 'ADR not found' });
      return;
    }
    if (adr.authorId !== userId) {
      res.status(403).json({ error: 'Only the author can generate this ADR' });
      return;
    }

    const sourceThread = await getThread(adr.chatThreadId);
    if (!sourceThread) {
      res.status(409).json({ error: 'ADR conversation thread is unavailable' });
      return;
    }
    const transcript = [
      '# ADR Interview Transcript',
      '',
      ...sourceThread.messages
        .filter((message) => message.role === 'user' || message.role === 'agent')
        .map((message) => `**${message.role === 'user' ? 'User' : 'Architect'}:** ${message.text}\n`),
    ].join('\n');

    const skillConfig = await resolveSkillConfig({
      project: adr.project,
      settingsId: adr.skillSettingsId ?? undefined,
    });
    const model = skillConfig?.adrModel ?? adr.model ?? await getDefaultModel();
    const thread = await createThread(userId, {
      project: adr.project,
      repo: skillConfig?.skillRepo ?? adr.repo,
      branch: skillConfig?.skillBranch ?? 'main',
      skillProvider: skillConfig?.skillProvider,
      skillPath: skillConfig?.adrFinalizeSkillPath ?? '.cursor/skills/adr-finalize/SKILL.md',
      transcript,
      model,
      skillSettingsId: skillConfig?.id ?? adr.skillSettingsId ?? undefined,
    }, {
      kickoffMessage: 'Generate the ADR from `.ai-pilot/kickoff-transcript.md`. Do not ask questions. Write exactly one `.ai-pilot/output/{slug}.adr.md` file.',
    });

    await markAdrGenerating(adr.id, userId);
    startAdrWatcher(adr.id, thread.id);
    res.status(201).json({ adrId: adr.id, threadId: thread.id });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/assignments', requirePermission('adr:view'), async (req, res, next) => {
  try {
    res.json(await getAssignments(req.params.id, 'adr'));
  } catch (error) {
    next(error);
  }
});

router.put('/:id/assignments', requirePermission('adr:edit'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const adr = await getAdr(req.params.id);
    if (!adr) {
      res.status(404).json({ error: 'ADR not found' });
      return;
    }
    if (adr.authorId !== userId) {
      res.status(403).json({ error: 'Only the owner can update ADR reviewers' });
      return;
    }
    if (adr.status !== 'proposed') {
      res.status(409).json({ error: 'Reviewers can only be updated while the ADR is proposed' });
      return;
    }
    const { reviewerIds } = req.body as { reviewerIds?: string[] };
    if (!Array.isArray(reviewerIds) || reviewerIds.some((id) => typeof id !== 'string')) {
      res.status(400).json({ error: 'reviewerIds must be an array of user IDs' });
      return;
    }
    const uniqueReviewerIds = [...new Set(reviewerIds)];
    if (uniqueReviewerIds.includes(userId)) {
      res.status(400).json({ error: 'The ADR owner cannot also be assigned as a reviewer' });
      return;
    }
    const removedReviewerIds = adr.reviewerIds.filter((id) => !uniqueReviewerIds.includes(id));
    await reassignApprovers(req.params.id, 'adr', uniqueReviewerIds, userId);
    await removeApproverAssignments(req.params.id, 'adr', removedReviewerIds);
    await db.update(adrsTable).set({
      reviewerIds: uniqueReviewerIds,
      updatedAt: new Date().toISOString(),
    }).where(eq(adrsTable.id, req.params.id));
    res.json(await getAssignments(req.params.id, 'adr'));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/review', requirePermission('adr:review'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const adr = await getAdr(req.params.id);
    if (!adr) {
      res.status(404).json({ error: 'ADR not found' });
      return;
    }
    if (adr.status !== 'proposed') {
      res.status(409).json({ error: 'Only proposed ADRs can be reviewed' });
      return;
    }
    const assigned = await isAssignedApprover(adr.id, 'adr', userId);
    if (!assigned) {
      res.status(403).json({ error: 'You are not an assigned reviewer for this ADR' });
      return;
    }
    const { status, comment } = req.body as {
      status?: 'approved' | 'revision_requested';
      comment?: string;
    };
    if (status !== 'approved' && status !== 'revision_requested') {
      res.status(400).json({ error: 'status must be approved or revision_requested' });
      return;
    }
    if (status === 'approved' && await getUnresolvedCount(adr.id, 'adr') > 0) {
      res.status(409).json({ error: 'Resolve all review comments before approving the ADR' });
      return;
    }
    await recordApproverResponse(adr.id, 'adr', userId, status, comment);
    const completion = await isApprovalComplete(adr.id, 'adr', adr.project);
    await createNotification(adr.authorId, {
      type: 'user-action',
      title: status === 'approved' ? 'ADR reviewer approved' : 'ADR reviewer requested revisions',
      body: `A reviewer responded to "${adr.title}"`,
      link: `/adr/${adr.id}`,
    });
    res.json({ ok: true, approvalComplete: completion.complete });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/owner-approval', requirePermission('adr:view'), async (req, res, next) => {
  try {
    res.json(await getOwnerApproval(req.params.id, 'adr'));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/owner-approve', requirePermission('adr:review'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const adr = await getAdr(req.params.id);
    if (!adr) {
      res.status(404).json({ error: 'ADR not found' });
      return;
    }
    if (adr.authorId !== userId) {
      res.status(403).json({ error: 'Only the ADR owner can give final approval' });
      return;
    }
    if (adr.status !== 'proposed') {
      res.status(409).json({ error: `Cannot owner-approve ADR from status '${adr.status}'` });
      return;
    }
    const { status, comment } = req.body as OwnerApproveRequest;
    if (status !== 'approved' && status !== 'revision_requested') {
      res.status(400).json({ error: 'status must be approved or revision_requested' });
      return;
    }
    if (status === 'approved') {
      await updateAdrStatus(adr.id, userId, 'accepted');
    } else {
      await recordOwnerApproval(adr.id, 'adr', userId, status, comment);
    }
    await Promise.allSettled(adr.reviewerIds.map((reviewerId) =>
      createNotification(reviewerId, {
        type: 'user-action',
        title: status === 'approved' ? 'ADR accepted by owner' : 'ADR owner requested revisions',
        body: `"${adr.title}" has an owner response`,
        link: `/adr/${adr.id}`,
      }),
    ));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/assistant-thread', requirePermission('adr:view'), requirePermission('adr:edit'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const adr = await getAdr(req.params.id);
    if (!adr) {
      res.status(404).json({ error: 'ADR not found' });
      return;
    }
    if (adr.authorId !== userId) {
      res.status(403).json({ error: 'Only the author can use the ADR Assistant' });
      return;
    }
    if (adr.status !== 'proposed') {
      res.status(409).json({ error: 'ADR Assistant is available only while the ADR is proposed' });
      return;
    }

    const sourceThread = await getThread(adr.chatThreadId);
    const transcript = sourceThread
      ? sourceThread.messages
        .filter((message) => message.role === 'user' || message.role === 'agent')
        .map((message) => `**${message.role === 'user' ? 'User' : 'Architect'}:** ${message.text}`)
        .join('\n\n')
      : '(Original interview transcript unavailable)';
    const buildContext = (threadId: string) => [
      '# ADR Assistant Context',
      `adr_id: ${adr.id}`,
      `thread_id: ${threadId}`,
      `project: ${adr.project}`,
      `repo: ${adr.repo}`,
      `status: ${adr.status}`,
      '',
      'Use repository sandbox/MCP tools to inspect relevant code and documentation before making claims or proposing edits.',
      'To stage an edit, call `update_adr` with the identifiers above and the complete revised ADR markdown.',
      'The tool writes only proposed content. Never modify live ADR content or workflow status.',
      '',
      '## Current ADR',
      adr.content || '(empty)',
      '',
      '## Original Interview Transcript',
      transcript,
    ].join('\n');

    const forceNew = req.body?.forceNew === true;
    if (adr.adrAssistantThreadId && !forceNew) {
      const [threadRow] = await db.select({ workspaceDir: chatThreads.workspaceDir })
        .from(chatThreads)
        .where(eq(chatThreads.id, adr.adrAssistantThreadId))
        .limit(1);
      if (threadRow?.workspaceDir) {
        try {
          fs.writeFileSync(
            path.join(threadRow.workspaceDir, '.ai-pilot', 'kickoff-context.md'),
            buildContext(adr.adrAssistantThreadId),
            'utf-8',
          );
          updateThreadKickoffContext(adr.adrAssistantThreadId, buildContext(adr.adrAssistantThreadId));
        } catch {
          // The persisted thread remains usable even if its old workspace was cleaned.
        }
      }
      res.json({ threadId: adr.adrAssistantThreadId });
      return;
    }

    const skillConfig = await resolveSkillConfig({
      project: adr.project,
      settingsId: adr.skillSettingsId ?? undefined,
    });
    const model = skillConfig?.adrModel ?? adr.model ?? await getDefaultModel();
    const thread = await createThread(userId, {
      project: adr.project,
      repo: skillConfig?.skillRepo ?? adr.repo,
      branch: skillConfig?.skillBranch ?? 'main',
      skillProvider: skillConfig?.skillProvider,
      skillPath: skillConfig?.adrAssistantSkillPath ?? '.cursor/skills/adr-assistant/SKILL.md',
      freeformContext: buildContext('__THREAD_ID__'),
      model,
      assistantType: 'adr',
      skillSettingsId: skillConfig?.id ?? adr.skillSettingsId ?? undefined,
    }, {
      kickoffMessage: 'Introduce yourself briefly as the ADR Apex Assistant and explain that you can investigate repository evidence, discuss refinements and trade-offs, and stage edits for explicit apply or reject review.',
    });

    const context = buildContext(thread.id);
    fs.writeFileSync(path.join(thread.workspaceDir, '.ai-pilot', 'kickoff-context.md'), context, 'utf-8');
    updateThreadKickoffContext(thread.id, context);
    await setAdrAssistantThread(adr.id, userId, thread.id);
    res.status(201).json({ threadId: thread.id });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/fix-with-ai', requirePermission('adr:edit'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const adr = await getAdr(req.params.id);
    if (!adr) {
      res.status(404).json({ error: 'ADR not found' });
      return;
    }
    if (adr.authorId !== userId) {
      res.status(403).json({ error: 'Only the ADR owner can fix comments with AI' });
      return;
    }
    if (adr.status !== 'proposed') {
      res.status(409).json({ error: 'ADR review fixes are available only while the ADR is proposed' });
      return;
    }
    const comments = (await getComments(adr.id, 'adr')).filter((comment) => comment.status === 'open');
    if (comments.length === 0) {
      res.status(400).json({ error: 'No open comments to fix' });
      return;
    }
    const projectConfig = await resolveSkillConfig({
      project: adr.project,
      settingsId: adr.skillSettingsId ?? undefined,
    });
    const fixedContent = await fixAdrContentWithBedrock(
      adr.content,
      comments.map((comment) => ({
        sectionKey: comment.sectionKey,
        exact: comment.selector.exact,
        body: comment.body,
        authorName: comment.authorDisplayName,
        replies: comment.replies.map((reply) => ({
          authorName: reply.authorDisplayName,
          body: reply.body,
        })),
      })),
      projectConfig?.prdReviewBedrockModelId,
      projectConfig?.prdReviewBedrockMaxTokens,
      { feature: 'other', project: adr.project, entityType: 'adr', entityId: adr.id, userId },
    );
    await stageAdrReviewFix(adr.id, userId, fixedContent, null);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof BedrockModelTruncatedError) {
      res.status(422).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.post('/:id/fix-comment-with-ai', requirePermission('adr:edit'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const adr = await getAdr(req.params.id);
    if (!adr) {
      res.status(404).json({ error: 'ADR not found' });
      return;
    }
    if (adr.authorId !== userId) {
      res.status(403).json({ error: 'Only the ADR owner can fix comments with AI' });
      return;
    }
    if (adr.status !== 'proposed') {
      res.status(409).json({ error: 'ADR review fixes are available only while the ADR is proposed' });
      return;
    }
    const { commentId } = req.body as { commentId?: string };
    if (!commentId) {
      res.status(400).json({ error: 'commentId is required' });
      return;
    }
    const comment = (await getComments(adr.id, 'adr'))
      .find((candidate) => candidate.id === commentId && candidate.status === 'open');
    if (!comment) {
      res.status(404).json({ error: 'Comment not found or not open' });
      return;
    }
    const projectConfig = await resolveSkillConfig({
      project: adr.project,
      settingsId: adr.skillSettingsId ?? undefined,
    });
    const fixedContent = await fixAdrContentWithBedrock(
      adr.content,
      [{
        sectionKey: comment.sectionKey,
        exact: comment.selector.exact,
        body: comment.body,
        authorName: comment.authorDisplayName,
        replies: comment.replies.map((reply) => ({
          authorName: reply.authorDisplayName,
          body: reply.body,
        })),
      }],
      projectConfig?.prdReviewBedrockModelId,
      projectConfig?.prdReviewBedrockMaxTokens,
      { feature: 'other', project: adr.project, entityType: 'adr', entityId: adr.id, userId },
    );
    await stageAdrReviewFix(adr.id, userId, fixedContent, comment.id);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof BedrockModelTruncatedError) {
      res.status(422).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.post('/:id/apply-proposed', requirePermission('adr:view'), requirePermission('adr:edit'), async (req, res, next) => {
  try {
    await applyAdrProposedContent(req.params.id, getUserId(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/reject-proposed', requirePermission('adr:view'), requirePermission('adr:edit'), async (req, res, next) => {
  try {
    await rejectAdrProposedContent(req.params.id, getUserId(req));
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

export default router;
