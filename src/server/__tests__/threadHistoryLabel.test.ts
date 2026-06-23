import {
  formatProcessDescription,
  formatThreadHistoryLabel,
  firstUserMessagePreview,
  normalizeMessagePreview,
  skillPathToProcessLabel,
} from '../../shared/utils/threadHistoryLabel';
import type { ChatMessage, ChatThreadSummary } from '../../shared/types/chat';

describe('normalizeMessagePreview', () => {
  it('skips Begin. and bare skill slugs', () => {
    expect(normalizeMessagePreview('Begin.')).toBeUndefined();
    expect(normalizeMessagePreview('/app-knowledge')).toBeUndefined();
  });

  it('truncates long prompts', () => {
    const long = 'x'.repeat(100);
    expect(normalizeMessagePreview(long)?.length).toBe(80);
  });
});

describe('firstUserMessagePreview', () => {
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', text: 'Begin.', ts: '2026-01-01T00:00:00.000Z', hidden: true },
    { id: '2', role: 'user', text: 'How do we deploy to Azure?', ts: '2026-01-01T00:01:00.000Z' },
  ];

  it('returns the first non-hidden meaningful user message', () => {
    expect(firstUserMessagePreview(messages)).toBe('How do we deploy to Azure?');
  });
});

describe('skillPathToProcessLabel', () => {
  it('title-cases the skill folder name', () => {
    expect(skillPathToProcessLabel('skills/grill-with-docs/SKILL.md')).toBe('Grill With Docs');
  });
});

describe('formatProcessDescription', () => {
  it('joins process and description with a hyphen', () => {
    expect(formatProcessDescription('Document Griller', 'Review your docs')).toBe(
      'Document Griller - Review your docs',
    );
  });

  it('returns process only when description is absent', () => {
    expect(formatProcessDescription('Free chat', null)).toBe('Free chat');
  });
});

describe('formatThreadHistoryLabel', () => {
  const base: ChatThreadSummary = {
    id: 't1',
    userId: 'u1',
    title: 'Stored title',
    status: 'idle',
    kickoff: { project: 'P', repo: 'R' },
    flagged: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
  };

  it('prefers user message preview over static pill description', () => {
    expect(
      formatThreadHistoryLabel({
        ...base,
        kickoff: {
          ...base.kickoff,
          pillLabel: 'App Knowledge',
          pillDescription: 'Query your codebase',
        },
        messagePreview: 'How does the auth flow work?',
      }),
    ).toBe('App Knowledge - How does the auth flow work?');
  });

  it('falls back to pill description when no user message exists', () => {
    expect(
      formatThreadHistoryLabel({
        ...base,
        kickoff: {
          ...base.kickoff,
          pillLabel: 'Kick-off',
          pillDescription: 'Start a new feature',
        },
      }),
    ).toBe('Kick-off - Start a new feature');
  });

  it('uses user message when pill description is missing', () => {
    expect(
      formatThreadHistoryLabel({
        ...base,
        kickoff: { ...base.kickoff, pillLabel: 'App Knowledge' },
        messagePreview: 'What services run in production?',
      }),
    ).toBe('App Knowledge - What services run in production?');
  });

  it('combines skill path with message preview', () => {
    expect(
      formatThreadHistoryLabel({
        ...base,
        kickoff: { ...base.kickoff, skillPath: 'skills/to-prd/SKILL.md' },
        messagePreview: 'Draft a PRD for notifications',
      }),
    ).toBe('To Prd - Draft a PRD for notifications');
  });

  it('extracts description from stored title when messagePreview is missing', () => {
    expect(
      formatThreadHistoryLabel({
        ...base,
        title: 'App Knowledge - what does auth look like',
        kickoff: { ...base.kickoff, pillLabel: 'App Knowledge' },
      }),
    ).toBe('App Knowledge - what does auth look like');
  });

  it('extracts description from stored title for skill path threads', () => {
    expect(
      formatThreadHistoryLabel({
        ...base,
        title: 'To Prd - Draft a PRD for notifications',
        kickoff: { ...base.kickoff, skillPath: 'skills/to-prd/SKILL.md' },
      }),
    ).toBe('To Prd - Draft a PRD for notifications');
  });

  it('returns just pill label when title has no description either', () => {
    expect(
      formatThreadHistoryLabel({
        ...base,
        title: 'App Knowledge',
        kickoff: { ...base.kickoff, pillLabel: 'App Knowledge' },
      }),
    ).toBe('App Knowledge');
  });

  it('falls back to stored title for free chat', () => {
    expect(formatThreadHistoryLabel({ ...base, title: 'Help me plan Q3' })).toBe('Help me plan Q3');
  });
});
