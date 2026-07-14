import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { devSessions } from '../db/schema';

export type MyWorkLogLevel = 'info' | 'warn' | 'error';

export interface MyWorkLogContext {
  sessionId?: string | null;
  threadId?: string | null;
  runId?: string | null;
  project?: string | null;
  branch?: string | null;
  status?: string | null;
  phase?: string | null;
  durationMs?: number;
  [key: string]: string | number | boolean | null | undefined;
}

const MAX_LOG_VALUE_LENGTH = 500;

function sanitizeLogValue(value: string): string {
  return value
    .replace(/:\/\/[^/\s@:]+:[^/\s@]+@/g, '://[redacted]@')
    .replace(/\b(token|password|secret|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LOG_VALUE_LENGTH);
}

function normalizeContext(context: MyWorkLogContext): MyWorkLogContext {
  return Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === 'string' ? sanitizeLogValue(value) : value]),
  ) as MyWorkLogContext;
}

/**
 * Emits a single-line, structured record. Console collection sends this to the
 * Azure log stream and Application Insights when configured.
 */
export function logMyWorkSession(
  event: string,
  context: MyWorkLogContext = {},
  level: MyWorkLogLevel = 'info',
): void {
  const payload = {
    timestamp: new Date().toISOString(),
    component: 'my-work',
    event: sanitizeLogValue(event),
    ...normalizeContext(context),
  };
  const line = `[my-work] ${JSON.stringify(payload)}`;

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export async function getMyWorkSessionContext(
  threadId: string,
): Promise<MyWorkLogContext | null> {
  const session = await db.query.devSessions.findFirst({
    where: eq(devSessions.chatThreadId, threadId),
    columns: {
      id: true,
      project: true,
      branchName: true,
      status: true,
    },
  });

  if (!session) return null;
  return {
    sessionId: session.id,
    threadId,
    project: session.project,
    branch: session.branchName,
    status: session.status,
  };
}
