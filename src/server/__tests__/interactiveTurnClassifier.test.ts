import type { InteractiveCapability } from '../../shared/types/durableInteractiveTurn';
import {
  classifyInteractiveTurn,
  type InteractiveClassificationInput,
} from '../services/interactiveTurnClassifier';

const plain = (
  overrides: Partial<InteractiveClassificationInput> = {}
): InteractiveClassificationInput => ({
  effort: 'low',
  skillPath: null,
  capabilityMetadata: {
    status: 'known',
    capabilities: ['plain-chat'],
  },
  ...overrides,
});

const requiring = (
  capability: Exclude<InteractiveCapability, 'plain-chat'>
): Partial<InteractiveClassificationInput> => ({
  capabilityMetadata: {
    status: 'known',
    capabilities: ['plain-chat', capability],
  },
});

describe('interactive turn classifier', () => {
  it('keeps a registered low-effort plain turn fast', () => {
    expect(classifyInteractiveTurn(plain()).interactiveClass).toBe('fast');
  });

  it.each([
    ['high effort', { effort: 'high' }],
    ['workspace', requiring('workspace')],
    ['attachments', requiring('attachments')],
    ['ado', requiring('ado')],
    ['mcp', requiring('mcp')],
    ['tool heavy', requiring('tool-heavy')],
  ] as const)('upgrades %s and never downgrades it', (_name, override) => {
    expect(classifyInteractiveTurn(plain(override)).interactiveClass).toBe(
      'agentic'
    );
  });

  it.each(['unknown', 'conflicting', 'uncertain'] as const)(
    'defaults %s capability metadata to agentic',
    (status) => {
      expect(
        classifyInteractiveTurn(plain({ capabilityMetadata: { status } }))
          .interactiveClass
      ).toBe('agentic');
    }
  );

  it('defaults an unknown skill to agentic', () => {
    expect(
      classifyInteractiveTurn(
        plain({
          skillPath: '/unknown/SKILL.md',
          capabilityMetadata: { status: 'unknown' },
        })
      ).interactiveClass
    ).toBe('agentic');
  });

  it('does not let known plain metadata downgrade an unregistered skill', () => {
    expect(
      classifyInteractiveTurn(plain({ skillPath: '/unknown/SKILL.md' }))
        .interactiveClass
    ).toBe('agentic');
  });

  it.each([
    '.cursor/skills/app-knowledge/SKILL.md',
    '.CURSOR\\SKILLS\\DAILY-STANDUP\\skill.md',
    '/skills/prd-design-spec/SKILL.md',
  ])(
    'normalizes registered skill path %s and adds its capabilities',
    (skillPath) => {
      expect(
        classifyInteractiveTurn(plain({ skillPath })).interactiveClass
      ).toBe('agentic');
    }
  );

  it('requires plain-chat in known capability metadata', () => {
    expect(
      classifyInteractiveTurn(
        plain({
          capabilityMetadata: {
            status: 'known',
            capabilities: [],
          },
        })
      ).interactiveClass
    ).toBe('agentic');
  });

  it('sorts and deduplicates reasons deterministically', () => {
    const result = classifyInteractiveTurn(
      plain({
        effort: 'high',
        capabilityMetadata: {
          status: 'known',
          capabilities: ['tool-heavy', 'workspace', 'tool-heavy'],
        },
      })
    );

    expect(result.reasons).toEqual(
      [...new Set(result.reasons)].sort((left, right) =>
        left.localeCompare(right)
      )
    );
  });

  it('ignores model when callers carry it beside classification input', () => {
    const first = { ...plain(), model: 'model-a' };
    const second = { ...plain(), model: 'model-b' };
    expect(classifyInteractiveTurn(first).interactiveClass).toBe('fast');
    expect(classifyInteractiveTurn(second).interactiveClass).toBe('fast');
  });
});
