/**
 * TBI-005 — Extend thread-selection callback with optional focus message id
 * DoD-0: Selection callback accepts an optional focus-message identifier
 * DoD-2: Opening a thread without a focus id behaves exactly as before
 */
import type {
  SelectChatThreadHandler,
  SelectChatThreadOptions,
} from '../../../shared/types/chat';

describe('TBI-005 SelectChatThreadHandler', () => {
  it('DoD-0: accepts an optional focusMessageId via options bag', () => {
    const calls: Array<{ threadId: string; options?: SelectChatThreadOptions }> = [];
    const handler: SelectChatThreadHandler = (threadId, options) => {
      calls.push({ threadId, options });
    };

    handler('thread-1', { focusMessageId: 'msg-42' });

    expect(calls).toEqual([
      { threadId: 'thread-1', options: { focusMessageId: 'msg-42' } },
    ]);
  });

  it('DoD-2: calling with only threadId (no options) remains valid', () => {
    const calls: Array<{ threadId: string; options?: SelectChatThreadOptions }> = [];
    const handler: SelectChatThreadHandler = (threadId, options) => {
      calls.push({ threadId, options });
    };

    handler('thread-2');

    expect(calls).toEqual([{ threadId: 'thread-2', options: undefined }]);
    expect(calls[0].options?.focusMessageId).toBeUndefined();
  });
});
