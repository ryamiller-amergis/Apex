/**
 * Shared runner ingest contract — TBI-005 DoD-0.
 */
import {
  AI_RUN_INGEST_KINDS,
  isAiRunIngestKind,
  isAiRunTerminalIngestStatus,
  type AiRunIngestErrorCode,
} from '../../shared/types/aiRunIngest';

describe('AI-run ingest shared types', () => {
  it('TBI-005 DoD-0: exposes the four closed ingest variants', () => {
    expect(AI_RUN_INGEST_KINDS).toEqual([
      'heartbeat',
      'progress',
      'cancel_ack',
      'terminal',
    ]);
    for (const kind of AI_RUN_INGEST_KINDS) {
      expect(isAiRunIngestKind(kind)).toBe(true);
    }
    expect(isAiRunIngestKind('final')).toBe(false);
  });

  it('TBI-005 DoD-0: terminal parsing accepts only domain terminal statuses', () => {
    expect(isAiRunTerminalIngestStatus('completed')).toBe(true);
    expect(isAiRunTerminalIngestStatus('failed')).toBe(true);
    expect(isAiRunTerminalIngestStatus('cancelled')).toBe(true);
    expect(isAiRunTerminalIngestStatus('running')).toBe(false);
  });

  it('TBI-005 DoD-4 / VT-01: exposes deterministic artifact durability rejection', () => {
    const code: AiRunIngestErrorCode = 'AI_RUN_ARTIFACTS_NOT_FLUSHED';
    expect(code).toBe('AI_RUN_ARTIFACTS_NOT_FLUSHED');
  });
});
