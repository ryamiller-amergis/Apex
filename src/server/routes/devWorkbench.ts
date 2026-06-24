import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requirePermission, requireGroupMembership } from '../middleware/rbac';
import { AzureDevOpsService } from '../services/azureDevOps';
import { getSkillConfig } from '../services/projectSettingsService';
import { createThread } from '../services/chatAgentService';
import {
  checkoutDefaultBranch,
  createFeatureBranch,
  computeDiff,
  pushBranch,
  getWorkspaceDir,
  cleanupWorkspace,
} from '../services/repoCheckoutService';
import { db } from '../db/drizzle';
import { devSessions } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getUserId } from '../utils/requestUser';
import type { StartDevSessionRequest } from '../../shared/types/devWorkbench';

const router = Router();

router.use(requirePermission('dev-workbench:view'));
router.use(requireGroupMembership('Developer'));

// GET /workitems?project=<project>
router.get('/workitems', async (req: Request, res: Response) => {
  try {
    const project = req.query.project as string;
    if (!project) {
      res.status(400).json({ error: 'project query parameter is required' });
      return;
    }

    const userId = getUserId(req);
    const displayName = (req.user as any)?.profile?.displayName;
    if (!displayName) {
      res.status(400).json({ error: 'Could not determine user display name' });
      return;
    }

    const adoService = new AzureDevOpsService(project);
    const items = await adoService.getWorkItemsAssignedToUser(displayName, project, { activeOnly: true });

    res.json(items);
  } catch (err) {
    console.error('[dev-workbench] getWorkItems failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch assigned work items' });
  }
});

// POST /start — creates a session record immediately, then clones + sets up the thread async
router.post('/start', async (req: Request, res: Response) => {
  try {
    const { workItemId, project, model } = req.body as StartDevSessionRequest;

    if (!workItemId || !project) {
      res.status(400).json({ error: 'workItemId and project are required' });
      return;
    }

    const userId = getUserId(req);
    const sessionId = uuidv4();

    await db.insert(devSessions).values({
      id: sessionId,
      workItemId,
      project,
      authorId: userId,
      status: 'setting_up',
    });

    res.json({ sessionId });

    // Async setup — clone repo, create branch, create chat thread
    (async () => {
      try {
        const skillConfig = await getSkillConfig(project);
        const developmentSkillPath = skillConfig?.developmentSkillPath ?? undefined;
        const developmentModel = model ?? skillConfig?.developmentModel ?? undefined;

        const adoService = new AzureDevOpsService(project);
        const repo = skillConfig?.skillRepo ?? project;
        const defaultBranch = await adoService.getDefaultBranch(repo, project);

        const workspaceDir = await checkoutDefaultBranch({
          project,
          repo,
          branch: defaultBranch,
          sessionId,
        });

        const branchName = createFeatureBranch(workspaceDir, workItemId);

        const thread = await createThread(userId, {
          project,
          repo,
          branch: branchName,
          skillPath: developmentSkillPath,
          model: developmentModel,
          mode: 'development',
          workItemId,
        }, {
          workspaceDirOverride: workspaceDir,
        });

        await db
          .update(devSessions)
          .set({
            chatThreadId: thread.id,
            branchName,
            status: 'in_progress',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(devSessions.id, sessionId));

        console.log('[dev-workbench] session ready:', sessionId);
      } catch (err) {
        const message = (err as Error).message;
        console.error('[dev-workbench] async setup failed:', message);
        console.error('[dev-workbench] stack:', (err as Error).stack);
        await db
          .update(devSessions)
          .set({
            status: 'failed',
            setupError: message,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(devSessions.id, sessionId));
      }
    })();
  } catch (err) {
    const message = (err as Error).message;
    console.error('[dev-workbench] start session failed:', message);
    res.status(500).json({ error: `Failed to start development session: ${message}` });
  }
});

// GET /sessions — active sessions for the current user
router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const project = req.query.project as string | undefined;

    const conditions = [eq(devSessions.authorId, userId), inArray(devSessions.status, ['setting_up', 'in_progress'])];
    if (project) conditions.push(eq(devSessions.project, project));

    const rows = await db
      .select({
        id: devSessions.id,
        workItemId: devSessions.workItemId,
        chatThreadId: devSessions.chatThreadId,
        branchName: devSessions.branchName,
        status: devSessions.status,
        createdAt: devSessions.createdAt,
      })
      .from(devSessions)
      .where(and(...conditions));

    res.json(rows);
  } catch (err) {
    console.error('[dev-workbench] getSessions failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /sessions/:id — poll a single session's status
router.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const userId = getUserId(req);

    const session = await db.query.devSessions.findFirst({
      where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json({
      id: session.id,
      workItemId: session.workItemId,
      chatThreadId: session.chatThreadId,
      branchName: session.branchName,
      status: session.status,
      setupError: session.setupError,
      createdAt: session.createdAt,
    });
  } catch (err) {
    console.error('[dev-workbench] getSession failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// POST /sessions/:id/close — mark session closed and clean up workspace
router.post('/sessions/:id/close', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const userId = getUserId(req);

    const session = await db.query.devSessions.findFirst({
      where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await db
      .update(devSessions)
      .set({ status: 'closed', updatedAt: new Date().toISOString() })
      .where(eq(devSessions.id, sessionId));

    try {
      cleanupWorkspace(sessionId);
    } catch (cleanupErr) {
      console.warn('[dev-workbench] workspace cleanup failed (non-fatal):', (cleanupErr as Error).message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[dev-workbench] closeSession failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to close session' });
  }
});

// POST /sessions/:id/push — commit & push the feature branch to origin
router.post('/sessions/:id/push', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const userId = getUserId(req);

    const session = await db.query.devSessions.findFirst({
      where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (!session.branchName) {
      res.status(400).json({ error: 'Session has no branch to push' });
      return;
    }

    const workspaceDir = getWorkspaceDir(sessionId);
    pushBranch(workspaceDir, session.branchName);

    res.json({ ok: true, branch: session.branchName });
  } catch (err) {
    const message = (err as Error).message;
    console.error('[dev-workbench] pushBranch failed:', message);
    res.status(500).json({ error: `Failed to push branch: ${message}` });
  }
});

// GET /threads/:id/diff
router.get('/threads/:id/diff', async (req: Request, res: Response) => {
  try {
    const threadId = req.params.id;

    const session = await db.query.devSessions.findFirst({
      where: eq(devSessions.chatThreadId, threadId),
    });

    if (!session) {
      res.status(404).json({ error: 'Dev session not found for this thread' });
      return;
    }

    const workspaceDir = getWorkspaceDir(session.id);
    const { diffText, changedFiles } = computeDiff(workspaceDir);

    res.json({
      diffText,
      changedFiles,
      branch: session.branchName ?? '',
    });
  } catch (err) {
    console.error('[dev-workbench] computeDiff failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to compute diff' });
  }
});

export default router;
