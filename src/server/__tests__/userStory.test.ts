import {
  normalizeBacklogUserStories,
  normalizePbiUserStory,
  resolveUserStoryIWant,
} from '../../shared/utils/userStory';

describe('resolveUserStoryIWant', () => {
  it('prefers iWant over the want alias', () => {
    expect(resolveUserStoryIWant({ iWant: 'edit todos', want: 'ignored' })).toBe('edit todos');
  });

  it('falls back to want when iWant is missing or blank', () => {
    expect(resolveUserStoryIWant({ want: 'list my todos' })).toBe('list my todos');
    expect(resolveUserStoryIWant({ iWant: '   ', want: 'list my todos' })).toBe('list my todos');
  });

  it('returns empty string when neither field has text', () => {
    expect(resolveUserStoryIWant(undefined)).toBe('');
    expect(resolveUserStoryIWant({ persona: 'Developer' })).toBe('');
  });
});

describe('normalizePbiUserStory', () => {
  it('rewrites want to iWant and drops the alias', () => {
    expect(
      normalizePbiUserStory({
        persona: 'Authenticated User',
        want: 'add a todo from Profile',
        soThat: 'I can capture tasks quickly',
      }),
    ).toEqual({
      persona: 'Authenticated User',
      iWant: 'add a todo from Profile',
      soThat: 'I can capture tasks quickly',
    });
  });

  it('returns undefined for empty objects', () => {
    expect(normalizePbiUserStory({})).toBeUndefined();
    expect(normalizePbiUserStory(null)).toBeUndefined();
  });
});

describe('normalizeBacklogUserStories', () => {
  it('rewrites PBI userStory.want to iWant without mutating the input', () => {
    const backlog = {
      epics: [
        {
          features: [
            {
              items: [
                {
                  type: 'PBI',
                  id: 'PBI-001',
                  userStory: {
                    persona: 'Developer',
                    want: 'a dedicated user_todos table',
                    soThat: 'each todo is queryable',
                  },
                },
                {
                  type: 'TBI',
                  id: 'TBI-001',
                  userStory: { want: 'should not change' },
                },
              ],
            },
          ],
        },
      ],
    };

    const result = normalizeBacklogUserStories(backlog);

    expect(result.epics[0].features[0].items[0].userStory).toEqual({
      persona: 'Developer',
      iWant: 'a dedicated user_todos table',
      soThat: 'each todo is queryable',
    });
    expect(result.epics[0].features[0].items[1].userStory).toEqual({
      want: 'should not change',
    });
    expect(backlog.epics[0].features[0].items[0].userStory).toEqual({
      persona: 'Developer',
      want: 'a dedicated user_todos table',
      soThat: 'each todo is queryable',
    });
  });

  it('passes through null and non-objects', () => {
    expect(normalizeBacklogUserStories(null)).toBeNull();
    expect(normalizeBacklogUserStories(undefined)).toBeUndefined();
    expect(normalizeBacklogUserStories('x')).toBe('x');
  });
});
