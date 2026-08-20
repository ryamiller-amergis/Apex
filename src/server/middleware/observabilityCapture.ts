/**
 * Authenticated-request Observability capture middleware.
 * Enqueues on response completion; never awaits persistence or calls next(err).
 */
import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { CaptureDisposition, ServerTraceCandidate } from '../../shared/types/observability';
import { getUserId } from '../utils/requestUser';
import { isObservabilityCaptureEnabled } from '../services/observabilityCaptureFlagSnapshot';
import { getObservabilityCaptureService } from '../services/observabilityCaptureService';
import {
  isCaptureExcludedPath,
  isPollRoute,
  parseTraceIdFromTraceparent,
  resolveCaptureProject,
  resolveRouteTemplate,
} from './observabilityCapturePolicy';

export interface ObservabilityCaptureMiddlewareDeps {
  isEnabled?: () => boolean;
  capture?: (candidate: ServerTraceCandidate) => CaptureDisposition;
  now?: () => number;
  createTraceId?: () => string;
}

function createTraceId(): string {
  return randomBytes(16).toString('hex');
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.get?.(name) ?? req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function isEventStream(res: Response): boolean {
  const contentType = res.getHeader?.('Content-Type') ?? res.getHeader?.('content-type');
  return typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream');
}

function resolveTraceId(req: Request, createId: () => string): string {
  return parseTraceIdFromTraceparent(headerValue(req, 'traceparent')) ?? createId();
}

function resolveSessionId(req: Request): string | undefined {
  const sessionID = (req as Request & { sessionID?: string }).sessionID;
  return typeof sessionID === 'string' && sessionID ? sessionID : undefined;
}

function buildCandidate(
  req: Request,
  res: Response,
  extras: Partial<ServerTraceCandidate>,
  startedAt: number,
  now: () => number,
  createId: () => string,
): ServerTraceCandidate | null {
  const actorUserId = getUserId(req);
  if (!actorUserId || actorUserId === 'anonymous') return null;

  const routeTemplate = resolveRouteTemplate(req);
  const trigger = extras.trigger ?? (isPollRoute(routeTemplate) ? 'poll' : 'human');

  return {
    eventType: extras.eventType ?? 'api_request',
    occurredAt: new Date(now()).toISOString(),
    actorUserId,
    projectId: resolveCaptureProject(req),
    sessionId: resolveSessionId(req),
    traceId: resolveTraceId(req, createId),
    routeTemplate,
    httpMethod: req.method,
    statusCode: extras.statusCode ?? res.statusCode,
    durationMs: Math.max(0, now() - startedAt),
    severity: extras.severity ?? (res.statusCode >= 500 ? 'error' : 'info'),
    trigger,
    ssePhase: extras.ssePhase,
    headers: req.headers,
    details: extras.details,
    error: extras.error,
  };
}

function safeCapture(
  capture: (candidate: ServerTraceCandidate) => CaptureDisposition,
  candidate: ServerTraceCandidate | null,
): void {
  if (!candidate) return;
  try {
    capture(candidate);
  } catch {
    // Capture failures never reach Express.
  }
}

export function createObservabilityCaptureMiddleware(
  deps: ObservabilityCaptureMiddlewareDeps = {},
): RequestHandler {
  const isEnabled = deps.isEnabled ?? isObservabilityCaptureEnabled;
  const capture =
    deps.capture ?? ((candidate: ServerTraceCandidate) => getObservabilityCaptureService().capture(candidate));
  const now = deps.now ?? Date.now;
  const makeTraceId = deps.createTraceId ?? createTraceId;

  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      // @feature-flag:observability-capture start winner=enabled
      if (!isEnabled()) {
        // @feature-flag:observability-capture disabled-start
        next();
        return;
        // @feature-flag:observability-capture disabled-end
      }

      // @feature-flag:observability-capture enabled-start
      const routeHint = `${req.baseUrl || ''}${req.path || ''}`;
      if (isCaptureExcludedPath(routeHint) || isCaptureExcludedPath(resolveRouteTemplate(req))) {
        next();
        return;
      }

      const startedAt = now();
      let completed = false;
      let sseOpenCaptured = false;

      const captureSseOpen = (): void => {
        if (sseOpenCaptured || completed) return;
        if (!isEventStream(res)) return;
        sseOpenCaptured = true;
        safeCapture(
          capture,
          buildCandidate(req, res, { ssePhase: 'open', statusCode: res.statusCode || 200 }, startedAt, now, makeTraceId),
        );
      };

      const originalSetHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: unknown) => {
        originalSetHeader(name, value as string | number | readonly string[]);
        if (String(name).toLowerCase() === 'content-type') captureSseOpen();
        return res;
      }) as Response['setHeader'];

      const originalWriteHead = res.writeHead.bind(res);
      res.writeHead = ((...args: unknown[]) => {
        const result = (originalWriteHead as (...writeArgs: unknown[]) => Response)(...args);
        captureSseOpen();
        return result;
      }) as Response['writeHead'];

      const finish = (): void => {
        if (completed) return;
        completed = true;
        const sse = sseOpenCaptured || isEventStream(res);
        if (sse) {
          safeCapture(
            capture,
            buildCandidate(req, res, { ssePhase: 'close', statusCode: res.statusCode || 200 }, startedAt, now, makeTraceId),
          );
          return;
        }
        safeCapture(capture, buildCandidate(req, res, {}, startedAt, now, makeTraceId));
      };

      res.on('finish', finish);
      res.on('close', finish);
      // @feature-flag:observability-capture enabled-end
      // @feature-flag:observability-capture end
    } catch {
      // Instrumentation must never fail the request.
    }
    next();
  };
}

export const observabilityCaptureMiddleware = createObservabilityCaptureMiddleware();

export function captureServerError(
  req: Request,
  err: unknown,
  res?: Response,
  deps: ObservabilityCaptureMiddlewareDeps = {},
): void {
  try {
    const isEnabled = deps.isEnabled ?? isObservabilityCaptureEnabled;
    const capture =
      deps.capture ??
      ((candidate: ServerTraceCandidate) => getObservabilityCaptureService().capture(candidate));
    if (!isEnabled()) return;
    const routeHint = `${req.baseUrl || ''}${req.path || ''}`;
    if (isCaptureExcludedPath(routeHint)) return;
    const actorUserId = getUserId(req);
    if (!actorUserId || actorUserId === 'anonymous') return;

    const safeError =
      err instanceof Error
        ? { message: err.message, stack: err.stack }
        : { message: String(err) };

    capture({
      eventType: 'error',
      occurredAt: new Date().toISOString(),
      actorUserId,
      projectId: resolveCaptureProject(req),
      sessionId: resolveSessionId(req),
      traceId: resolveTraceId(req, deps.createTraceId ?? createTraceId),
      routeTemplate: resolveRouteTemplate(req),
      httpMethod: req.method,
      statusCode: res?.statusCode ?? (err as { status?: number })?.status ?? 500,
      severity: 'error',
      trigger: isPollRoute(resolveRouteTemplate(req)) ? 'poll' : 'human',
      error: safeError,
    });
  } catch {
    // Error capture is best-effort.
  }
}

export async function startObservabilityCapture(): Promise<void> {
  const { startObservabilityCaptureFlagSnapshot } = await import(
    '../services/observabilityCaptureFlagSnapshot'
  );
  startObservabilityCaptureFlagSnapshot();
  getObservabilityCaptureService().start();
}

export async function stopObservabilityCapture(): Promise<void> {
  const { stopObservabilityCaptureFlagSnapshot } = await import(
    '../services/observabilityCaptureFlagSnapshot'
  );
  stopObservabilityCaptureFlagSnapshot();
  await getObservabilityCaptureService().stop();
}
