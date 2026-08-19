/**
 * Bounded in-memory browser event queue. Drops newest on overflow.
 */
import {
  BROWSER_BATCH_SIZE,
  BROWSER_QUEUE_CAPACITY,
  type BrowserTraceEventCandidate,
} from '../../shared/types/observability';
import { shouldRetainBrowserEvent } from '../../shared/utils/browserErrorProjection';

export interface BrowserEventQueueOptions {
  capacity?: number;
  batchSize?: number;
  samplingRate?: number;
}

export class BrowserEventQueue {
  private readonly items: BrowserTraceEventCandidate[] = [];
  private readonly capacity: number;
  private readonly batchSize: number;
  private readonly samplingRate: number;

  constructor(options: BrowserEventQueueOptions = {}) {
    this.capacity = options.capacity ?? BROWSER_QUEUE_CAPACITY;
    this.batchSize = options.batchSize ?? BROWSER_BATCH_SIZE;
    this.samplingRate = options.samplingRate ?? 1;
  }

  get size(): number {
    return this.items.length;
  }

  enqueue(event: BrowserTraceEventCandidate): boolean {
    if (!shouldRetainBrowserEvent(event.type, this.samplingRate)) return false;
    if (this.items.length >= this.capacity) return false;
    this.items.push(event);
    return true;
  }

  shouldFlush(): boolean {
    return this.items.length >= this.batchSize;
  }

  drain(max = this.batchSize): BrowserTraceEventCandidate[] {
    return this.items.splice(0, Math.min(max, this.batchSize, this.items.length));
  }
}
