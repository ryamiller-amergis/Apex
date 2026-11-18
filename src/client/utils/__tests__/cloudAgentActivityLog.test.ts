import type { CloudAgentActivityEvent } from '../../../shared/types/devWorkbench';
import {
  appendCloudActivityEvent,
  cloudAgentActivityLabel,
  cloudAgentPhaseIndex,
} from '../cloudAgentActivityLog';

function event(
  partial: Pick<CloudAgentActivityEvent, 'id' | 'kind'> & Partial<CloudAgentActivityEvent>,
): CloudAgentActivityEvent {
  return { title: partial.kind, ...partial };
}

describe('cloud agent activity log', () => {
  it('joins streamed reply chunks into one row and keeps the space before punctuation', () => {
    const first = appendCloudActivityEvent([], event({
      id: 'a1',
      kind: 'assistant',
      title: 'Assistant',
      detail: 'if',
    }));
    const second = appendCloudActivityEvent(first, event({
      id: 'a2',
      kind: 'assistant',
      title: 'Assistant',
      detail: 'needed',
    }));
    const third = appendCloudActivityEvent(second, event({
      id: 'a3',
      kind: 'assistant',
      title: 'Assistant',
      detail: '.',
    }));

    expect(third).toHaveLength(1);
    expect(third[0].detail).toBe('if needed.');
  });

  it('keeps a leading space that arrived with the chunk', () => {
    const merged = appendCloudActivityEvent(
      [event({ id: 'a1', kind: 'assistant', title: 'Assistant', detail: 'if' })],
      event({ id: 'a2', kind: 'assistant', title: 'Assistant', detail: ' needed' }),
    );
    expect(merged[0].detail).toBe('if needed');
  });

  it('starts a new row when a tool call interrupts the reply', () => {
    const merged = appendCloudActivityEvent(
      [event({ id: 'a1', kind: 'assistant', title: 'Assistant', detail: 'Looking.' })],
      event({ id: 't1', kind: 'tool', title: 'Shell', detail: 'Running', status: 'running' }),
    );
    expect(merged).toHaveLength(2);
    expect(merged[1].title).toBe('Shell');
  });

  it('says which tool is running', () => {
    expect(cloudAgentActivityLabel([
      event({ id: 't1', kind: 'tool', title: 'Shell', status: 'running' }),
    ])).toBe('Using Shell');
  });

  it('says the reply is done and the pull request is still outstanding', () => {
    expect(cloudAgentActivityLabel([
      event({ id: 'a1', kind: 'assistant', title: 'Assistant', detail: 'Done.' }),
      event({ id: 's1', kind: 'status', title: 'FINISHED', status: 'completed' }),
    ])).toBe('Reply finished. Waiting for the branch and pull request.');
  });

  it('follows a tool that starts after the reply was marked finished', () => {
    expect(cloudAgentActivityLabel([
      event({ id: 's1', kind: 'status', title: 'FINISHED', status: 'completed' }),
      event({ id: 't1', kind: 'tool', title: 'edit', status: 'running' }),
    ])).toBe('Using edit');
  });

  it('stays on Queued until the first event, then Working while the step is live', () => {
    expect(cloudAgentPhaseIndex(0, true)).toBe(0);
    expect(cloudAgentPhaseIndex(4, true)).toBe(1);
    expect(cloudAgentPhaseIndex(4, false)).toBe(2);
  });
});
