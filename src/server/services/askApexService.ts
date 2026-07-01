import { Agent } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk/dist/cjs/agent.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { retryWithBackoff } from '../utils/retry';

const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MODEL_ID = 'composer-2.5-fast';

const SYSTEM_PROMPT = `You are the Apex Product Assistant. You are a knowledgeable product owner for the Apex application (AI-Pilot). You help users understand:
- What features are available and how they work
- Application workflows and navigation
- What's planned on the roadmap
- How to use specific capabilities
- Best practices for using the application

Be friendly, concise, and helpful. If you don't know something specific, say so and suggest they submit a feature request.

IMPORTANT: You are a conversational assistant only. Do NOT attempt to read, write, or modify any files. Do NOT use any tools. Just answer questions based on your knowledge.`;

export interface AskApexMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

export type AskApexSessionStatus = 'idle' | 'streaming' | 'error';

export interface AskApexSseEvent {
  type: 'token' | 'message' | 'status' | 'error' | 'done';
  text?: string;
  message?: AskApexMessage;
  status?: AskApexSessionStatus;
  error?: string;
}

interface SessionState {
  id: string;
  userId: string;
  agent: SDKAgent | null;
  messages: AskApexMessage[];
  status: AskApexSessionStatus;
  subscribers: Set<(event: AskApexSseEvent) => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  workspaceDir: string;
}

const sessions = new Map<string, SessionState>();

function broadcast(session: SessionState, event: AskApexSseEvent): void {
  for (const cb of session.subscribers) {
    try { cb(event); } catch { /* subscriber error */ }
  }
}

function resetIdleTimer(session: SessionState): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => destroySession(session.id), SESSION_IDLE_TIMEOUT_MS);
}

function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.agent) {
    try { session.agent[Symbol.asyncDispose]().catch(() => {}); } catch { /* ignore */ }
  }
  try {
    if (fs.existsSync(session.workspaceDir)) {
      fs.rmSync(session.workspaceDir, { recursive: true, force: true });
    }
  } catch { /* ignore cleanup errors */ }
  sessions.delete(sessionId);
}

export function createSession(userId: string): string {
  const sessionId = uuidv4();
  const workspaceDir = path.join(os.tmpdir(), 'ask-apex-sessions', sessionId);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const session: SessionState = {
    id: sessionId,
    userId,
    agent: null,
    messages: [],
    status: 'idle',
    subscribers: new Set(),
    idleTimer: null,
    workspaceDir,
  };

  sessions.set(sessionId, session);
  resetIdleTimer(session);
  return sessionId;
}

export function getSession(sessionId: string, userId: string): SessionState | null {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) return null;
  return session;
}

export function subscribeToSession(
  sessionId: string,
  userId: string,
  callback: (event: AskApexSseEvent) => void,
): (() => void) | null {
  const session = getSession(sessionId, userId);
  if (!session) return null;
  session.subscribers.add(callback);
  return () => { session.subscribers.delete(callback); };
}

export function getSessionMessages(sessionId: string, userId: string): AskApexMessage[] | null {
  const session = getSession(sessionId, userId);
  if (!session) return null;
  return session.messages;
}

function isTransientSdkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('rate') || msg.includes('timeout') || msg.includes('econnreset') || msg.includes('503');
}

export async function sendMessage(sessionId: string, userId: string, text: string): Promise<void> {
  const session = getSession(sessionId, userId);
  if (!session) throw new Error('Session not found');
  if (session.status === 'streaming') throw new Error('Already streaming');

  const userMsg: AskApexMessage = {
    id: uuidv4(),
    role: 'user',
    text: text.trim(),
    ts: new Date().toISOString(),
  };
  session.messages.push(userMsg);
  broadcast(session, { type: 'message', message: userMsg });

  session.status = 'streaming';
  broadcast(session, { type: 'status', status: 'streaming' });
  resetIdleTimer(session);

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    session.status = 'error';
    broadcast(session, { type: 'error', error: 'CURSOR_API_KEY is not set' });
    return;
  }

  const isFirstTurn = !session.agent;
  const prompt = isFirstTurn
    ? `${SYSTEM_PROMPT}\n\n---\n\nUser: ${text.trim()}`
    : text.trim();

  try {
    const sdkRetryOpts = { maxRetries: 3, initialDelay: 1000, shouldRetry: isTransientSdkError, jitter: true } as const;

    if (!session.agent) {
      session.agent = await retryWithBackoff(
        () => Agent.create({
          apiKey,
          model: { id: MODEL_ID },
          local: { cwd: session.workspaceDir },
        }),
        sdkRetryOpts,
      );
    }

    const run = await retryWithBackoff(
      () => session.agent!.send(prompt),
      { ...sdkRetryOpts, maxRetries: 2 },
    );

    let agentTextBuffer = '';

    if (run.supports('stream')) {
      for await (const event of run.stream()) {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              agentTextBuffer += block.text;
              broadcast(session, { type: 'token', text: block.text });
            }
          }
        }
      }
    }

    const assistantMsg: AskApexMessage = {
      id: uuidv4(),
      role: 'assistant',
      text: agentTextBuffer.trim() || 'I wasn\'t able to generate a response. Please try again.',
      ts: new Date().toISOString(),
    };
    session.messages.push(assistantMsg);
    broadcast(session, { type: 'message', message: assistantMsg });

    session.status = 'idle';
    broadcast(session, { type: 'status', status: 'idle' });
    broadcast(session, { type: 'done' });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[ask-apex] sendMessage error for session ${sessionId}:`, errorMessage);

    const errorMsg: AskApexMessage = {
      id: uuidv4(),
      role: 'assistant',
      text: `Sorry, I encountered an error. Please try again. (${errorMessage})`,
      ts: new Date().toISOString(),
    };
    session.messages.push(errorMsg);
    broadcast(session, { type: 'message', message: errorMsg });

    session.status = 'idle';
    broadcast(session, { type: 'status', status: 'idle' });
    broadcast(session, { type: 'done' });
  } finally {
    resetIdleTimer(session);
  }
}

export function closeSession(sessionId: string, userId: string): boolean {
  const session = getSession(sessionId, userId);
  if (!session) return false;
  destroySession(sessionId);
  return true;
}
