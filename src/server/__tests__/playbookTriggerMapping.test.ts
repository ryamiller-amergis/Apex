import { applyPlaybookTriggerMapping, renderPlaybookDedupeKey } from '../../shared/utils/playbookTriggerMapping';
import { latestScheduleInstant } from '../services/playbookTriggerDispatchService';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

describe('playbook trigger mapping', () => {
  const event = {
    entityId: 'doc-1',
    actorUserId: 'user-1',
    data: { documentId: 'doc-1', ownerUserId: 'owner-1' },
  };

  it('copies literals, event fields, and template values', () => {
    const runInput = applyPlaybookTriggerMapping({
      mapping: [
        { to: 'documentId', from: { kind: 'event.data', field: 'documentId' } },
        { to: 'actor', from: { kind: 'event.actorUserId' } },
        { to: 'source', from: { kind: 'literal', value: 'apex' } },
        { to: 'note', from: { kind: 'template', key: 'note' } },
      ],
      template: { note: 'keep' },
      event,
    });

    expect(runInput).toEqual({
      note: 'keep',
      documentId: 'doc-1',
      actor: 'user-1',
      source: 'apex',
    });
  });

  it('rejects a template expression', () => {
    expect(() => applyPlaybookTriggerMapping({
      mapping: [],
      template: { prompt: '${steps.score.answer}' },
      event,
    })).toThrow(/template expression/);
  });

  it('renders only known dedupe tokens', () => {
    expect(renderPlaybookDedupeKey('{event.type}:{event.entityId}', {
      'event.type': 'design-doc.validation-requested',
      'event.entityId': 'doc-1',
    })).toBe('design-doc.validation-requested:doc-1');
    expect(() => renderPlaybookDedupeKey('{event.script}', {})).toThrow(/Unknown dedupe token/);
  });

  it('keeps a missed schedule due after the minute has passed', () => {
    const now = new Date(Date.UTC(2026, 9, 26, 4, 30, 0));
    expect(latestScheduleInstant(now, 2, 0).toISOString()).toBe('2026-10-26T02:00:00.000Z');
  });
});
