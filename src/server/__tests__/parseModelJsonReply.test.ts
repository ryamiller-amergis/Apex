import { parseModelJsonReply } from '../services/bedrockService';

describe('parseModelJsonReply', () => {
  it('parses bare JSON', () => {
    expect(parseModelJsonReply('{"epics":[]}')).toEqual({ epics: [] });
  });

  it('parses JSON inside code fences', () => {
    expect(parseModelJsonReply('```json\n{"epics":[1]}\n```')).toEqual({ epics: [1] });
  });

  it('parses JSON surrounded by a sentence of prose', () => {
    expect(
      parseModelJsonReply('Here is the revised backlog:\n{"epics":[{"title":"System Admin"}]}\nDone.'),
    ).toEqual({ epics: [{ title: 'System Admin' }] });
  });

  it('returns null when nothing parses', () => {
    expect(parseModelJsonReply('{"epics": [')).toBeNull();
  });
});
