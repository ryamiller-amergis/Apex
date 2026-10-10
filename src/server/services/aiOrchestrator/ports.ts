/**
 * Injected ports for the V2 orchestrator. Unit tests supply fakes; production
 * wires REST Service Bus + Azure Container Apps probes.
 */

import type {
  CommandPublishRequest,
  ExecutionProbeResult,
  PeekLockedMessage,
} from './types';

export type CommandPublisher = {
  publish(request: CommandPublishRequest): Promise<void>;
};

export type QueueConsumer = {
  receive(options?: { timeoutSeconds?: number }): Promise<PeekLockedMessage | null>;
  complete(lockToken: string): Promise<void>;
  abandon(lockToken: string): Promise<void>;
  deadLetter(lockToken: string, reason: string, description?: string): Promise<void>;
};

export type ExecutionProbe = {
  probe(executionId: string): Promise<ExecutionProbeResult>;
};

export type Clock = {
  now(): Date;
  sleep(ms: number): Promise<void>;
};

export type OrchestratorMetrics = {
  increment(name: string, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  timing(name: string, ms: number, tags?: Record<string, string>): void;
};

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const noopMetrics: OrchestratorMetrics = {
  increment() {},
  gauge() {},
  timing() {},
};
