import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { requirePermission, requireGroupMembership } from '../middleware/rbac';
import { AzureDevOpsService } from '../services/azureDevOps';
import { getSkillConfig } from '../services/projectSettingsService';
import { adoWriteForRequest, isAdoUserAuthError } from '../services/adoFactory';
import { createThread } from '../services/chatAgentService';
import * as githubCatalog from '../services/skillCatalogGitHub';
import {
  checkoutDefaultBranch,
  checkoutFeatureBranch,
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
import { devSessions, prds, designDocs, testCases } from '../db/schema';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { injectDevContextFiles } from '../services/devContextService';
import { resolveGitRemote, type GitRemote } from '../services/repoCacheService';
import { getUserId } from '../utils/requestUser';
import type { StartDevSessionRequest, ApexBacklogGroup, BacklogFeatureItem } from '../../shared/types/devWorkbench';
import type { ProjectSkillConfig, SkillProvider } from '../../shared/types/projectSettings';

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

// POST /features/complete — mark a feature as complete by inserting a synthetic
// completed session, which unblocks any downstream features that depend on it.
router.post('/features/complete', async (req: Request, res: Response) => {
  try {
    const { prdId, featureId, project } = req.body as { prdId: string; featureId: string; project: string };
    if (!prdId || !featureId || !project) {
      res.status(400).json({ error: 'prdId, featureId, and project are required' });
      return;
    }

    const userId = getUserId(req);

    const existing = await db.query.devSessions.findFirst({
      where: and(
        eq(devSessions.prdId, prdId),
        eq(devSessions.featureId, featureId),
        eq(devSessions.status, 'completed'),
      ),
    });

    if (existing) {
      res.json({ ok: true, sessionId: existing.id });
      return;
    }

    const sessionId = uuidv4();
    const now = new Date().toISOString();

    await db.insert(devSessions).values({
      id: sessionId,
      project,
      authorId: userId,
      prdId,
      featureId,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
    });

    res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('[dev-workbench] completeFeature failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to mark feature as complete' });
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
        const { provider, repo, baseBranch } = await resolveCheckoutContext(skillConfig, project);
        const remote = resolveGitRemote(provider, project, repo);

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

          const workspaceDir = await checkoutDefaultBranch({
            project,
            repo,
            branch: baseBranch,
            sessionId,
            provider,
          });

          const branchName = `feature/apex-${featureId!.toLowerCase()}-${kebabTitle}`;
          await checkoutFeatureBranch(workspaceDir, branchName, baseBranch, remote);

          await injectDevContextFiles(workspaceDir, prdId!, featureId!);

          const thread = await createThread(userId, {
            project,
            repo,
            branch: branchName,
            skillBranch: baseBranch,
            skillProvider: provider,
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

          let workItemTitle = `wi-${workItemId}`;
          let workItemType = '';
          try {
            const wiResult = await adoService.queryWorkItemsByWiql({
              wiql: `SELECT [System.Id],[System.Title],[System.WorkItemType] FROM WorkItems WHERE [System.Id] = ${workItemId}`,
              fields: ['System.Id', 'System.Title', 'System.WorkItemType'],
            });
            const firstItem = wiResult.items[0];
            if (firstItem?.fields?.['System.Title']) {
              workItemTitle = firstItem.fields['System.Title'] as string;
            }
            if (firstItem?.fields?.['System.WorkItemType']) {
              workItemType = firstItem.fields['System.WorkItemType'] as string;
            }
          } catch {
            // Non-fatal — fall back to numeric slug
          }

          const workspaceDir = await checkoutDefaultBranch({
            project,
            repo,
            branch: baseBranch,
            sessionId,
            provider,
          });

          const branchName = await createFeatureBranch(
            workspaceDir,
            workItemId!,
            workItemTitle,
            baseBranch,
            remote,
          );

          // Inject design-doc attachments from the Feature work item (Gap 4 fix).
          try {
            await injectAdoAttachments(adoService, workItemId!, workItemTitle, workspaceDir);
          } catch (attachErr) {
            console.warn('[dev-workbench] attachment injection failed (non-fatal):', (attachErr as Error).message);
          }

          try {
            await adoService.setWorkItemState(workItemId!, 'In Progress');
          } catch (adoErr) {
            console.warn('[dev-workbench] setWorkItemState(In Progress) failed (non-fatal):', (adoErr as Error).message);
          }

          // Features have their child PBIs/TBIs/Bugs carry the working state.
          // Move not-yet-started children into "In Progress" alongside the Feature.
          if (workItemType === 'Feature') {
            await cascadeChildStates(adoService, workItemId!, ['New', 'Approved', 'Committed'], 'In Progress');
          }

          const thread = await createThread(userId, {
            project,
            repo,
            branch: branchName,
            skillBranch: baseBranch,
            skillProvider: provider,
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
        try {
          cleanupWorkspace(sessionId);
        } catch (cleanupErr) {
          console.warn(
            '[dev-workbench] failed setup workspace cleanup failed (non-fatal):',
            (cleanupErr as Error).message,
          );
        }
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
      inArray(devSessions.status, ['setting_up', 'in_progress', 'conflict', 'closed', 'completed']),
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
      .where(and(...conditions))
      .orderBy(desc(devSessions.createdAt));

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
      branchPushed: session.branchPushed ?? false,
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
    const { provider, repo, baseBranch } = await resolveCheckoutContext(skillConfig, session.project);
    const remote = resolveGitRemote(provider, session.project, repo);
    const adoService = provider === 'ado' ? await adoWriteForRequest(req, session.project) : null;

    const workspaceDir = getWorkspaceDir(sessionId);
    const workspaceExists = fs.existsSync(workspaceDir);

    if (workspaceExists) {
      // Workspace is available — do the full sync + merge + push flow
      const syncResult = await syncWithBase(workspaceDir, baseBranch, remote);

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

      // Clean merge — push only (no PR).
      await pushFeatureBranch(sessionId, session.branchName, remote);
    } else if (session.branchPushed) {
      // Workspace gone but branch already pushed — nothing more to do for push.
      // The /pr endpoint will create the PR when the user clicks "Create PR".
    } else {
      res.status(409).json({
        error: 'Workspace is no longer available and branch was not pushed to remote. The changes have been lost.',
      });
      return;
    }

    res.json({ ok: true, status: 'clean', branch: session.branchName, branchPushed: true });
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
    const files = await listConflicts(workspaceDir);
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
    await writeResolvedFile(workspaceDir, filePath, content);
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
    await completeMerge(workspaceDir);

    const skillConfig = await getSkillConfig(session.project);
    const { provider, repo } = await resolveCheckoutContext(skillConfig, session.project);
    const remote = resolveGitRemote(provider, session.project, repo);
    await pushFeatureBranch(sessionId, session.branchName, remote);

    res.json({ ok: true, branchPushed: true });
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
    await abortMerge(workspaceDir);

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

// POST /sessions/:id/pr — create a PR for an already-pushed branch (idempotent)
router.post('/sessions/:id/pr', async (req: Request, res: Response) => {
  try {
    const sessionId = req.params.id;
    const userId = getUserId(req);

    const session = await db.query.devSessions.findFirst({
      where: and(eq(devSessions.id, sessionId), eq(devSessions.authorId, userId)),
    });

    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    if (!session.branchName) { res.status(400).json({ error: 'Session has no branch' }); return; }
    if (!session.branchPushed) { res.status(400).json({ error: 'Branch has not been pushed yet' }); return; }
    if (session.prUrl) {
      // Idempotent — PR already created
      res.json({ prUrl: session.prUrl });
      return;
    }

    const skillConfig = await getSkillConfig(session.project);
    const { provider, repo, baseBranch } = await resolveCheckoutContext(skillConfig, session.project);
    const adoService = provider === 'ado' ? await adoWriteForRequest(req, session.project) : null;

    await createSessionPr(
      sessionId,
      session.branchName,
      baseBranch,
      repo,
      session.project,
      session.workItemId,
      provider,
      adoService,
    );

    const updated = await db.query.devSessions.findFirst({ where: eq(devSessions.id, sessionId) });
    res.json({ prUrl: updated?.prUrl ?? null });
  } catch (err) {
    if (isAdoUserAuthError(err)) {
      res.status(403).json({ error: (err as Error).message });
      return;
    }
    const message = (err as Error).message;
    console.error('[dev-workbench] createPr failed:', message);
    res.status(500).json({ error: `Failed to create pull request: ${message}` });
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
    const workspaceExists = fs.existsSync(workspaceDir);

    if (workspaceExists) {
      const { diffText, changedFiles } = await computeDiff(workspaceDir);

      // Always persist diff to DB (even when empty) so the UI panel
      // doesn't show stale "No changes" from a previous run.
      await db
        .update(devSessions)
        .set({
          cachedDiffText: diffText,
          cachedChangedFiles: changedFiles,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(devSessions.id, session.id));

      res.json({
        diffText,
        changedFiles,
        branch: session.branchName ?? '',
      });
      return;
    }

    // Workspace gone — serve cached diff from DB
    const cachedFiles = (session.cachedChangedFiles as string[] | null) ?? [];
    res.json({
      diffText: session.cachedDiffText ?? '',
      changedFiles: cachedFiles,
      branch: session.branchName ?? '',
      branchPushed: session.branchPushed ?? false,
    });
  } catch (err) {
    console.error('[dev-workbench] computeDiff failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to compute diff' });
  }
});

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Fetches design-doc attachments from the ADO Feature work item (or its parent
 * Feature if the assigned item is a PBI/TBI) and writes them into
 * `.ai-pilot/output/{slug}-design-spec/` in the workspace, so the dev prompt's
 * "pre-loaded design context" claim is true for ADO sessions.
 *
 * Non-fatal — caller wraps in try/catch.
 */
/**
 * Maps a raw ADO attachment file name to the canonical design-spec file name the
 * dev prompt/skill expects, or returns null if the attachment is not a design doc.
 *
 * Tolerant of real-world naming: case, singular/typo variants of "assumptions",
 * and an optional leading `{slug}-` prefix (e.g. `blackout-design.md`).
 */
function canonicalizeDesignAttachmentName(rawName: string): string | null {
  const base = (rawName.split(/[\\/]/).pop() ?? '').toLowerCase().trim();
  if (!base) return null;
  if (base.endsWith('design.md')) return 'design.md';
  if (base.endsWith('tech-spec.md') || base.endsWith('techspec.md')) return 'tech-spec.md';
  if (
    base.endsWith('assumptions.md') || base.endsWith('assumption.md') ||
    base.endsWith('asumptions.md') || base.endsWith('asumption.md')
  ) {
    return 'assumptions.md';
  }
  if (base.endsWith('prototype.html') || base.endsWith('prototype.htm')) return 'prototype.html';
  return null;
}

async function injectAdoAttachments(
  adoService: AzureDevOpsService,
  workItemId: number,
  workItemTitle: string,
  workspaceDir: string,
): Promise<void> {
  // Query the assigned work item with relations to get attachments + type.
  const wiResult = await adoService.queryWorkItemsByWiql({
    wiql: `SELECT [System.Id],[System.Title],[System.WorkItemType],[System.Parent] FROM WorkItems WHERE [System.Id] = ${workItemId}`,
    fields: ['System.Id', 'System.Title', 'System.WorkItemType', 'System.Parent'],
    includeRelations: true,
  });

  let targetItem = wiResult.items[0];
  if (!targetItem) return;

  const workItemType: string = targetItem.fields['System.WorkItemType'] ?? '';

  // If not a Feature, walk up to the parent Feature for attachments.
  if (workItemType !== 'Feature') {
    const parentId: number | undefined = targetItem.fields['System.Parent'];
    if (parentId) {
      const parentResult = await adoService.queryWorkItemsByWiql({
        wiql: `SELECT [System.Id],[System.Title],[System.WorkItemType] FROM WorkItems WHERE [System.Id] = ${parentId}`,
        fields: ['System.Id', 'System.Title', 'System.WorkItemType'],
        includeRelations: true,
      });
      if (parentResult.items[0]) {
        targetItem = parentResult.items[0];
      }
    }
  }

  const relations = targetItem.relations ?? [];
  const attachments = relations
    .map((rel) => {
      if (rel.rel !== 'AttachedFile' || !rel.url) return null;
      const rawName = rel.attributes?.['name'] as string | undefined;
      if (!rawName) return null;
      const canonicalName = canonicalizeDesignAttachmentName(rawName);
      if (!canonicalName) return null;
      return { url: rel.url, rawName, canonicalName };
    })
    .filter((a): a is { url: string; rawName: string; canonicalName: string } => a !== null);

  const featureTitleForLog = (targetItem.fields['System.Title'] as string | undefined) ?? workItemTitle;
  if (attachments.length === 0) {
    console.warn(
      `[dev-workbench] injectAdoAttachments: no design-doc attachments found on work item ${workItemId} ` +
        `("${featureTitleForLog}") — .ai-pilot/output will have no design spec`,
    );
    return;
  }

  // Derive slug from the Feature title or fall back to the work item ID.
  const featureTitle: string = (targetItem.fields['System.Title'] as string | undefined) ?? workItemTitle;
  const slug = featureTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `feature-${workItemId}`;

  const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
  const specDir = path.join(outputDir, `${slug}-design-spec`);
  fs.mkdirSync(specDir, { recursive: true });

  let written = 0;
  for (const att of attachments) {
    try {
      const content = await adoService.getAttachmentText(att.url);
      if (content) {
        fs.writeFileSync(path.join(specDir, att.canonicalName), content, 'utf-8');
        written++;
      } else {
        console.warn(`[dev-workbench] injectAdoAttachments: empty content for attachment ${att.rawName}`);
      }
    } catch (fileErr) {
      console.warn(`[dev-workbench] failed to write attachment ${att.rawName}:`, (fileErr as Error).message);
    }
  }
  console.log(
    `[dev-workbench] injectAdoAttachments: wrote ${written}/${attachments.length} design-doc attachment(s) ` +
      `for work item ${workItemId} to ${specDir}`,
  );

  // Write placeholder PRD and backlog so the prompt's references to those files don't fail silently.
  const prdPath = path.join(outputDir, `${slug}.prd.md`);
  if (!fs.existsSync(prdPath)) {
    const featureWiTitle = featureTitle;
    fs.writeFileSync(prdPath, `# ${featureWiTitle}\n\n_Work item #${workItemId}_\n`, 'utf-8');
  }
  const backlogPath = path.join(outputDir, `${slug}.backlog.json`);
  if (!fs.existsSync(backlogPath)) {
    fs.writeFileSync(backlogPath, '{}', 'utf-8');
  }
}

async function resolveCheckoutContext(
  skillConfig: ProjectSkillConfig | null,
  project: string,
): Promise<{ provider: SkillProvider; repo: string; baseBranch: string }> {
  const provider = skillConfig?.skillProvider ?? 'ado';
  const repo = skillConfig?.skillRepo ?? project;

  if (provider === 'github') {
    const baseBranch = skillConfig?.skillBranch
      ?? await githubCatalog.getDefaultBranch(repo);
    return { provider, repo, baseBranch };
  }

  const adoService = new AzureDevOpsService(project);
  const baseBranch = skillConfig?.skillBranch
    ?? await adoService.getDefaultBranch(repo, project);
  return { provider, repo, baseBranch };
}

/**
 * Cascades a work-item state transition to a Feature's child PBIs/TBIs/Bugs.
 * Only children whose current state is in `fromStates` are moved to `toState`.
 * Fully non-throwing — every failure (child lookup or an individual transition)
 * is logged and swallowed so it never aborts PR creation or session setup.
 */
async function cascadeChildStates(
  adoService: AzureDevOpsService,
  featureId: number,
  fromStates: string[],
  toState: string,
): Promise<void> {
  try {
    const children = await adoService.getFeatureChildren(featureId);
    for (const child of children) {
      if (!fromStates.includes(child.state)) continue;
      try {
        await adoService.setWorkItemState(child.id, toState);
      } catch (err) {
        console.warn(
          `[dev-workbench] cascade setWorkItemState(${child.id} -> ${toState}) failed (non-fatal):`,
          (err as Error).message,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[dev-workbench] cascadeChildStates for feature ${featureId} failed (non-fatal):`,
      (err as Error).message,
    );
  }
}

/**
 * Pushes the feature branch (commit + merge + push) and sets branchPushed = true
 * on the session. Does NOT create a PR.
 */
async function pushFeatureBranch(
  sessionId: string,
  branchName: string,
  remote?: GitRemote,
): Promise<void> {
  const workspaceDir = getWorkspaceDir(sessionId);
  await pushMergedBranch(workspaceDir, branchName, remote);

  await db
    .update(devSessions)
    .set({
      status: 'in_progress',
      branchPushed: true,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(devSessions.id, sessionId));
}

/**
 * Creates a PR from an already-pushed branch, transitions the work item
 * to "In Pull Request" (ADO only), attaches the PR hyperlink, and persists
 * the PR URL on the session record. Used by both the /pr endpoint and the
 * remote-only fallback (workspace gone but branch already pushed).
 */
async function createSessionPr(
  sessionId: string,
  branchName: string,
  baseBranch: string,
  repo: string,
  project: string,
  workItemId: number | null,
  provider: SkillProvider,
  adoService: AzureDevOpsService | null,
): Promise<void> {
  let prUrl: string | null = null;
  try {
    const description = workItemId
      ? `Automated implementation via APEX dev workbench.\n\nWork item: AB#${workItemId}`
      : `Automated implementation via APEX dev workbench.`;
    const title = `[APEX] ${branchName.replace('feature/', '')}`;

    if (provider === 'github') {
      prUrl = await githubCatalog.createPullRequest({
        repo,
        sourceBranch: branchName,
        targetBranch: baseBranch,
        title,
        description,
      });
    } else if (adoService) {
      prUrl = await adoService.createPullRequest({
        repo,
        project,
        sourceBranch: branchName,
        targetBranch: baseBranch,
        title,
        description,
        workItemId: workItemId ?? undefined,
      });

      if (workItemId) {
        let workItemType = '';
        try {
          const wiResult = await adoService.queryWorkItemsByWiql({
            wiql: `SELECT [System.Id],[System.WorkItemType] FROM WorkItems WHERE [System.Id] = ${workItemId}`,
            fields: ['System.Id', 'System.WorkItemType'],
          });
          workItemType = (wiResult.items[0]?.fields?.['System.WorkItemType'] as string) ?? '';
        } catch {
          // Non-fatal — fall back to treating it as a leaf work item.
        }

        if (workItemType === 'Feature') {
          // Features have no "In Pull Request" state. Keep the Feature "In Progress"
          // and move the children currently "In Progress" to "In Pull Request".
          await cascadeChildStates(adoService, workItemId, ['In Progress'], 'In Pull Request');
        } else {
          await adoService.setWorkItemState(workItemId, 'In Pull Request');
        }
        await adoService.addWorkItemHyperlink(workItemId, prUrl, 'Implementation PR');
      }
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
