import type { Response } from 'express';

/** Write an SSE data frame. Returns false when the connection is no longer writable. */
export function writeSseEvent(res: Response, event: object): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Write an SSE comment (e.g. keep-alive ping). Returns false when the connection is no longer writable. */
export function writeSseComment(res: Response, comment: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`: ${comment}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Start a keep-alive ping interval. The returned function clears the interval. */
export function startSseHeartbeat(res: Response, intervalMs = 25_000): () => void {
  const ping = setInterval(() => {
    if (!writeSseComment(res, 'ping')) {
      clearInterval(ping);
    }
  }, intervalMs);
  return () => clearInterval(ping);
}
