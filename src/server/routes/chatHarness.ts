/**
 * Shared chat harness HTTP routes (S7 / TBI-010).
 *
 * Mounted at `/api/harness` with `ensureAuthenticated` — intentionally OUTSIDE
 * `/api/chat`'s `chat:view` guard so every governed chat area (Brainstorm,
 * Ask Apex, Interviews, ADRs, etc.) reaches the same command and snapshot routes
 * authorized via `resolveThreadAccess` and `canCommandThread`.
 */
import { Router, type Request, type Response } from 'express';
import type {
  HarnessPendingCommand,
  HarnessSummaryMarker,
  HarnessThreadSnapshot,
} from '../../shared/types/chatHarness';
import { getUserId } from '../utils/requestUser';
import {
  resolveThreadAccess as defaultResolveThreadAccess,
  type ThreadAccessResult,
} from '../services/threadAccessService';
import { getAdoTokenForUser as defaultGetAdoTokenForUser } from '../services/adoUserToken';
import { getAreaProfile, type AreaProfile } from '../services/chatHarness/areaProfiles';
import {
  canCommandThread as defaultCanCommandThread,
  chatHarnessCommandHandler as defaultChatHarnessCommandHandler,
  HarnessCommandError,
  inferHarnessAreaFromThread,
  type ChatHarnessCommandHandler,
} from '../services/chatHarness/chatHarnessCommandHandler';
import { chatHarnessCommandRepository } from '../services/chatHarness/chatHarnessCommandRepository';
import { buildHarnessThreadState } from '../services/chatHarness/chatHarnessStateFrame';
import { getLatestSummaryMarker as defaultGetLatestSummaryMarker } from '../services/chatHarness/chatHarnessSummaryStore';

export interface ChatHarnessRouterDeps {
  commandHandler?: Pick<ChatHarnessCommandHandler, 'handle'>;
  resolveThreadAccess?: (
    userId: string,
    threadId: string,
  ) => Promise<ThreadAccessResult | null>;
  canCommandThread?: (
    userId: string,
    threadAccess: ThreadAccessResult,
    profile: Pick<AreaProfile, 'area' | 'permission'>,
  ) => Promise<boolean>;
  getAdoTokenForUser?: (req: Request) => Promise<string | null>;
  listPendingCommands?: (threadId: string) => Promise<HarnessPendingCommand[]>;
  getLatestSummaryMarker?: (
    threadId: string,
  ) => Promise<HarnessSummaryMarker | null>;
}

export function createChatHarnessRouter(
  deps: ChatHarnessRouterDeps = {},
): Router {
  const router = Router();
  const handler = deps.commandHandler ?? defaultChatHarnessCommandHandler;
  const resolveAccess = deps.resolveThreadAccess ?? defaultResolveThreadAccess;
  const checkCanCommand = deps.canCommandThread ?? defaultCanCommandThread;
  const getAdoToken = deps.getAdoTokenForUser ?? defaultGetAdoTokenForUser;
  const listPending =
    deps.listPendingCommands ??
    ((id: string) => chatHarnessCommandRepository.listPendingCommands(id));
  const loadSummaryMarker =
    deps.getLatestSummaryMarker ?? defaultGetLatestSummaryMarker;

  /**
   * POST /api/harness/threads/:id/commands
   * HTTP fallback for any harness command (`send`, `steer`, `summarize`, `cancel`, `retry`).
   * Returns 200 with `HarnessReceipt` for every receipt status including `'rejected'`.
   */
  router.post('/threads/:id/commands', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const threadId = req.params.id;

    try {
      const access = await resolveAccess(userId, threadId);
      if (!access) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const requestAdoToken = await getAdoToken(req).catch(() => null);
      const receipt = await handler.handle({
        userId,
        threadId,
        body: req.body,
        transport: 'http',
        requestAdoToken,
      });

      return res.status(200).json(receipt);
    } catch (err: unknown) {
      if (err instanceof HarnessCommandError) {
        if (err.statusCode === 404) {
          return res.status(404).json({ error: err.message });
        }
        return res.status(400).json({ error: err.message, code: err.code });
      }
      // Never log req.body or command text (TBI-009 / TBI-010 privacy invariant).
      console.error(
        '[chatHarness] POST /threads/:id/commands failed:',
        err instanceof Error ? err.name : 'UnknownError',
      );
      return res.status(500).json({ error: 'Failed to process harness command' });
    }
  });

  /**
   * GET /api/harness/threads/:id/snapshot
   * Fast reload snapshot returning non-hidden transcript messages, current
   * `HarnessThreadState`, latest summary marker (never `summaryText`), and `canWrite`.
   */
  router.get('/threads/:id/snapshot', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const threadId = req.params.id;

    try {
      const access = await resolveAccess(userId, threadId);
      if (!access) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const { thread } = access;
      const area = inferHarnessAreaFromThread(thread);
      const [pendingCommands, latestSummary, canWrite] = await Promise.all([
        listPending(threadId),
        loadSummaryMarker(threadId),
        checkCanCommand(userId, access, getAreaProfile(area)).catch(() => false),
      ]);

      const state = buildHarnessThreadState({
        thread: {
          status: thread.status,
          activeRunId: thread.activeRunId ?? null,
          harnessArea: thread.harnessArea ?? null,
        },
        pendingCommands,
        latestSummary,
        canWrite,
      });

      const snapshot: HarnessThreadSnapshot = {
        messages: thread.messages.filter((m) => !m.hidden),
        state,
        latestSummary: state.latestSummary,
        canWrite,
      };

      return res.status(200).json(snapshot);
    } catch (err: unknown) {
      console.error(
        '[chatHarness] GET /threads/:id/snapshot failed:',
        err instanceof Error ? err.name : 'UnknownError',
      );
      return res.status(500).json({ error: 'Failed to load thread snapshot' });
    }
  });

  return router;
}

const chatHarnessRouter = createChatHarnessRouter();
export default chatHarnessRouter;
