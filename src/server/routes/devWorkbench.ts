import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requirePermission, requireGroupMembership } from '../middleware/rbac';
import { AzureDevOpsService } from '../services/azureDevOps';
import { getSkillConfig } from '../services/projectSettingsService';
import { adoWriteForRequest, isAdoUserAuthError } from '../services/adoFactory';
import { createThread } from '../services/chatAgentService';
import {
  checkoutDefaultBranch,
  createFeatureBranch,
  computeDiff,
  pushBranch,
  pushMergedBranch,
  syncWithBase,
  listConflicts,
  writeResolvedFile,
  completeMerge,
  abortMerge,
  getWorkspaceDir,
  cleanupWorkspace,
} from '../services/repoCheckoutService';
import { db } from '../db/drizzle';
import { devSessions, prds, designDocs } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { getUserId } from '../utils/requestUser';
import type { StartDevSessionRequest, ApexBacklogGroup, BacklogFeatureItem } from '../../shared/types/devWorkbench';

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

// GET /backlog-features?project=<project> — Apex PRD-sourced feature backlog
router.get('/backlog-features', async (req: Request, res: Response) => {
  try {
    const project = req.query.project as string;
    if (!project) {
      res.status(400).json({ error: 'project query parameter is required' });
      return;
    }

    const approvedPrds = await db
      .select()
      .from(prds)
      .where(and(eq(prds.project, project), eq(prds.status, 'approved')));

    const result: ApexBacklogGroup[] = [];

    for (const prd of approvedPrds) {
      const backlog = prd.backlogJson as any;
      if (!backlog?.epics) continue;

      const docs = await db
        .select({ id: designDocs.id, featureIndex: designDocs.featureIndex, status: designDocs.status })
        .from(designDocs)
        .where(eq(designDocs.prdId, prd.id));

      const docByFeatureIndex = new Map(docs.map(d => [d.featureIndex, d]));

      let globalFeatureIdx = 0;
      const epics: ApexBacklogGroup['epics'] = [];

      for (const epic of backlog.epics) {
        const features: BacklogFeatureItem[] = [];

        for (const feat of epic.features ?? []) {
          const doc = docByFeatureIndex.get(globalFeatureIdx);
          const items = feat.items ?? [];
          const pbiCount = items.filter((i: any) => i.type === 'PBI' || i.type === 'Product Backlog Item').length;
          const tbiCount = items.filter((i: any) => i.type === 'TBI' || i.type === 'Technical Backlog Item').length;

          features.push({
            featureId: feat.id ?? `FEAT-${String(globalFeatureIdx + 1).padStart(3, '0')}`,
            featureTitle: feat.title ?? 'Untitled Feature',
            featurePriority: feat.priority ?? 'Should',
            epicTitle: epic.title ?? 'Untitled Epic',
            prdId: prd.id,
            prdTitle: prd.title,
            dependsOn: feat.dependsOn ?? [],
            designDocId: doc?.id ?? undefined,
            designDocStatus: doc?.status ?? undefined,
            itemCount: items.length,
            pbiCount,
            tbiCount,
          });

          globalFeatureIdx++;
        }

        if (features.length > 0) {
          epics.push({ epicTitle: epic.title ?? 'Untitled Epic', features });
        }
      }

      if (epics.length > 0) {
        result.push({ prdId: prd.id, prdTitle: prd.title, epics });
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[dev-workbench] getBacklogFeatures failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch backlog features' });
  }
});

// POST /start — creates a session record immediately, then clones + sets up the thread async
router.post('/start', async (req: Request, res: Response) => {
  try {
    const { workItemId, project, model, prdId, featureId } = req.body as StartDevSessionRequest;

    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }

    const hasAdoPath = !!workItemId;
    const hasApexPath = !!prdId && !!featureId;

    if (!hasAdoPath && !hasApexPath) {
      res.status(400).json({ error: 'Either workItemId or prdId + featureId are required' });
      return;
    }

    const userId = getUserId(req);
    const sessionId = uuidv4();

    await db.insert(devSessions).values({
      id: sessionId,
      workItemId: workItemId ?? null,
      project,
      authorId: userId,
      prdId: prdId ?? null,
      featureId: featureId ?? null,
      status: 'setting_up',
    });

    res.json({ sessionId });

    // Async setup — clone repo, create branch, create chat thread
    (async () => {
      try {
        const skillConfig = await getSkillConfig(project);
        const developmentSkillPath = skillConfig?.developmentSkillPath ?? undefined;
        const developmentModel = model ?? skillConfig?.developmentModel ?? undefined;
        const repo = skillConfig?.skillRepo ?? project;

        if (hasApexPath) {
          // Apex PRD-sourced path — skip ADO
          const prdRow = await db.query.prds.findFirst({ where: eq(prds.id, prdId!) });
          let featureTitle = featureId!;
          if (prdRow?.backlogJson) {
            const backlog = prdRow.backlogJson as any;
            for (const epic of backlog.epics ?? []) {
              for (const feat of epic.features ?? []) {
                if (feat.id === featureId) {
                  featureTitle = feat.title ?? featureId!;
                }
              }
            }
          }

          const kebabTitle = featureTitle
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40);

          const adoService = new AzureDevOpsService(project);
          const defaultBranch = await adoService.getDefaultBranch(repo, project);

          const workspaceDir = await checkoutDefaultBranch({
            project,
            repo,
            branch: defaultBranch,
            sessionId,
          });

          const branchName = `feature/apex-${featureId!.toLowerCase()}-${kebabTitle}`;
          createFeatureBranch(workspaceDir, 0, branchName);

          const thread = await createThread(userId, {
            project,
            repo,
            branch: branchName,
            skillPath: developmentSkillPath,
            model: developmentModel,
            mode: 'development',
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

          console.log('[dev-workbench] apex session ready:', sessionId);
        } else {
          // Existing ADO path
          const adoService = new AzureDevOpsService(project);
          const defaultBranch = await adoService.getDefaultBranch(repo, project);

          let workItemTitle = `wi-${workItemId}`;
          try {
            const wiResult = await adoService.queryWorkItemsByWiql({
              wiql: `SELECT [System.Id],[System.Title] FROM WorkItems WHERE [System.Id] = ${workItemId}`,
              fields: ['System.Id', 'System.Title'],
            });
            const firstItem = wiResult.items[0];
            if (firstItem?.fields?.['System.Title']) {
              workItemTitle = firstItem.fields['System.Title'] as string;
            }
          } catch {
            // Non-fatal — fall back to numeric slug
          }

          const workspaceDir = await checkoutDefaultBranch({
            project,
            repo,
            branch: defaultBranch,
            sessionId,
          });

          const branchName = createFeatureBranch(workspaceDir, workItemId!, workItemTitle);

          try {
            await adoService.setWorkItemState(workItemId!, 'In Progress');
          } catch (adoErr) {
            console.warn('[dev-workbench] setWorkItemState(In Progress) failed (non-fatal):', (adoErr as Error).message);
          }

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
        }
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

    const conditions = [
      eq(devSessions.authorId, userId),
      inArray(devSessions.status, ['setting_up', 'in_progress', 'conflict']),
    ];
    if (project) conditions.push(eq(devSessions.project, project));

    const rows = await db
      .select({
        id: devSessions.id,
        workItemId: devSessions.workItemId,
        chatThreadId: devSessions.chatThreadId,
        branchName: devSessions.branchName,
        status: devSessions.status,
        prUrl: devSessions.prUrl,
        createdAt: devSessions.createdAt,
        prdId: devSessions.prdId,
        featureId: devSessions.featureId,
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
      prUrl: session.prUrl,
      createdAt: session.createdAt,
      prdId: session.prdId,
      featureId: session.featureId,
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

// POST /sessions/:id/push — commit agent changes, merge latest base, then push + open PR
// If the base merge produces conflicts, returns { status: 'conflict', conflictedFiles: [...] }
// and the push/PR are blocked until the conflicts are resolved.
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

    const skillConfig = await getSkillConfig(session.project);
    // Attribute the PR (and the ADO state/hyperlink updates) to the logged-in
    // user — who is the work item's assignee in My Work — instead of the shared
    // PAT identity, so ADO shows the PR as "proposed by" that user.
    const adoService = await adoWriteForRequest(req, session.project);
    const repo = skillConfig?.skillRepo ?? session.project;
    const baseBranch = await adoService.getDefaultBranch(repo, session.project);

    const workspaceDir = getWorkspaceDir(sessionId);

    // Sync with the latest base branch (commits agent edits + merges base).
    const syncResult = syncWithBase(workspaceDir, baseBranch);

    if (syncResult.status === 'conflict') {
      await db
        .update(devSessions)
        .set({ status: 'conflict', updatedAt: new Date().toISOString() })
        .where(eq(devSessions.id, sessionId));

      res.json({
        ok: false,
        status: 'conflict',
        conflictedFiles: syncResult.conflictedFiles,
      });
      return;
    }

    // Clean merge — push and open PR.
    await finalisePush(sessionId, session.branchName, baseBranch, repo, session.project, session.workItemId, adoService);

    const updated = await db.query.devSessions.findFirst({ where: eq(devSessions.id, sessionId) });
    res.json({ ok: true, status: 'clean', branch: session.branchName, prUrl: updated?.prUrl ?? null });
  } catch (err) {
    if (isAdoUserAuthError(err)) {
      res.status(403).json({ error: (err as Error).message });
      return;
    }
    const message = (err as Error).message;
    console.error('[dev-workbench] pushBranch failed:', message);
    res.status(500).json({ error: `Failed to push branch: ${message}` });
  }
});

// GET /sessions/:id/conflicts — list current conflicted files + their content
router.get('/sessions/:id/conflicts', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const userId = getUserId(req);

    const session = await db.query.devSessions.findFirst({
      where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
    });

    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    if (session.status !== 'conflict') { res.status(400).json({ error: 'Session is not in conflict status' }); return; }

    const workspaceDir = getWorkspaceDir(sessionId);
    const files = listConflicts(workspaceDir);
    res.json({ files });
  } catch (err) {
    console.error('[dev-workbench] listConflicts failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to list conflicts' });
  }
});

// PUT /sessions/:id/conflicts — write a resolved file and stage it
router.put('/sessions/:id/conflicts', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const userId = getUserId(req);
    const { path: filePath, content } = req.body as { path: string; content: string };

    if (!filePath || content == null) {
      res.status(400).json({ error: 'path and content are required' });
      return;
    }

    const session = await db.query.devSessions.findFirst({
      where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
    });

    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    if (session.status !== 'conflict') { res.status(400).json({ error: 'Session is not in conflict status' }); return; }

    const workspaceDir = getWorkspaceDir(sessionId);
    writeResolvedFile(workspaceDir, filePath, content);
    res.json({ ok: true });
  } catch (err) {
    console.error('[dev-workbench] writeResolvedFile failed:', (err as Error).message);
    res.status(500).json({ error: `Failed to write resolved file: ${(err as Error).message}` });
  }
});

// POST /sessions/:id/conflicts/complete — finalise the merge, push, and open PR
router.post('/sessions/:id/conflicts/complete', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const userId = getUserId(req);

    const session = await db.query.devSessions.findFirst({
      where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
    });

    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    if (session.status !== 'conflict') { res.status(400).json({ error: 'Session is not in conflict status' }); return; }
    if (!session.branchName) { res.status(400).json({ error: 'Session has no branch' }); return; }

    const workspaceDir = getWorkspaceDir(sessionId);
    completeMerge(workspaceDir);

    const skillConfig = await getSkillConfig(session.project);
    // Attribute the PR to the logged-in user (the assignee), not the shared PAT.
    const adoService = await adoWriteForRequest(req, session.project);
    const repo = skillConfig?.skillRepo ?? session.project;
    const baseBranch = await adoService.getDefaultBranch(repo, session.project);

    await finalisePush(sessionId, session.branchName, baseBranch, repo, session.project, session.workItemId, adoService);

    const updated = await db.query.devSessions.findFirst({ where: eq(devSessions.id, sessionId) });
    res.json({ ok: true, prUrl: updated?.prUrl ?? null });
  } catch (err) {
    if (isAdoUserAuthError(err)) {
      res.status(403).json({ error: (err as Error).message });
      return;
    }
    const message = (err as Error).message;
    console.error('[dev-workbench] completeMerge failed:', message);
    res.status(500).json({ error: `Failed to complete merge: ${message}` });
  }
});

// POST /sessions/:id/conflicts/abort — abort the merge, return to in_progress
router.post('/sessions/:id/conflicts/abort', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const userId = getUserId(req);

    const session = await db.query.devSessions.findFirst({
      where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
    });

    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    if (session.status !== 'conflict') { res.status(400).json({ error: 'Session is not in conflict status' }); return; }

    const workspaceDir = getWorkspaceDir(sessionId);
    abortMerge(workspaceDir);

    await db
      .update(devSessions)
      .set({ status: 'in_progress', updatedAt: new Date().toISOString() })
      .where(eq(devSessions.id, sessionId));

    res.json({ ok: true });
  } catch (err) {
    console.error('[dev-workbench] abortMerge failed:', (err as Error).message);
    res.status(500).json({ error: `Failed to abort merge: ${(err as Error).message}` });
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

// ── Internal helper ───────────────────────────────────────────────────────────

/**
 * Pushes the feature branch, opens an ADO PR, transitions the work item
 * to "In Pull Request", attaches the PR hyperlink, and persists the PR URL
 * on the session record. Shared by the clean-push and conflict-complete paths.
 */
async function finalisePush(
  sessionId: string,
  branchName: string,
  baseBranch: string,
  repo: string,
  project: string,
  workItemId: number | null,
  adoService: AzureDevOpsService,
): Promise<void> {
  const workspaceDir = getWorkspaceDir(sessionId);

  pushMergedBranch(workspaceDir, branchName);

  let prUrl: string | null = null;
  try {
    const description = workItemId
      ? `Automated implementation via APEX dev workbench.\n\nWork item: AB#${workItemId}`
      : `Automated implementation via APEX dev workbench.`;

    prUrl = await adoService.createPullRequest({
      repo,
      project,
      sourceBranch: branchName,
      targetBranch: baseBranch,
      title: `[APEX] ${branchName.replace('feature/', '')}`,
      description,
      workItemId: workItemId ?? undefined,
    });

    if (workItemId) {
      await adoService.setWorkItemState(workItemId, 'In Pull Request');
      await adoService.addWorkItemHyperlink(workItemId, prUrl, 'Implementation PR');
    }
  } catch (prErr) {
    console.warn('[dev-workbench] PR creation failed (non-fatal):', (prErr as Error).message);
  }

  await db
    .update(devSessions)
    .set({
      status: 'in_progress',
      prUrl,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(devSessions.id, sessionId));
}

export default router;
