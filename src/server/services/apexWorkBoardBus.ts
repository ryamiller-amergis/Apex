/**
 * In-process pub/sub for Work Board SSE updates.
 * Not multi-instance safe — clients still poll as a fallback.
 */
import { EventEmitter } from 'events';

export type ApexWorkBoardChangePayload = {
  action: string;
  itemId?: string;
  releaseId?: string;
  [key: string]: unknown;
};

export type ApexWorkBoardChangeEvent = {
  project: string;
  payload: ApexWorkBoardChangePayload;
  at: string;
};

type BoardListener = (event: ApexWorkBoardChangeEvent) => void;

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emitBoardChange(project: string, payload: ApexWorkBoardChangePayload): void {
  if (!project?.trim()) return;
  const event: ApexWorkBoardChangeEvent = {
    project: project.trim(),
    payload,
    at: new Date().toISOString(),
  };
  bus.emit('change', event);
}

export function subscribe(listener: BoardListener): () => void {
  bus.on('change', listener);
  return () => {
    bus.off('change', listener);
  };
}
