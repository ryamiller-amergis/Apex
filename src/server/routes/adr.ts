import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { db } from '../db/drizzle';
import { chatThreads } from '../db/schema';
import {
  applyAdrProposedContent,
  createAdr,
  deleteAdr,
  getAdr,
  listAdrs,
  markAdrGenerating,
  rejectAdrProposedContent,
  setAdrAssistantThread,
  startAdrWatcher,
  updateAdrStatus,
  updateAdrTitle,
} from '../services/adrService';
import { createThread, getThread, updateThreadKickoffContext } from '../services/chatAgentService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import type { AdrStatus } from '../../shared/types/adr';

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

router.post('/', requirePermission('adr:create'), async (req, res, next) => {
  try {
    const { project, repo, title, chatThreadId, model, skillSettingsId } = req.body as {
      project?: string;
      repo?: string;
      title?: string;
      chatThreadId?: string;
      model?: string;
      skillSettingsId?: string;
    };
    if (!project || !repo || !title?.trim() || !chatThreadId) {
      res.status(400).json({ error: 'project, repo, title, and chatThreadId are required' });
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
