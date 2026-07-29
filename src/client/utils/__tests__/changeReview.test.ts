/**
 * Unit tests for changeReview utilities and diff hunk helpers.
 */

import { computeDiffHunks, mergeSelectedHunks } from '../diff';
import {
  buildPrdChangeUnits,
  buildDesignDocChangeUnits,
  buildAdrChangeUnits,
  mergePrdProposalFromUnits,
  mergeDesignDocProposalFromUnits,
  mergeAdrProposalFromUnits,
  reapplyDecisions,
  mergeBacklogSelective,
  countDecisions,
} from '../changeReview';
import type { ChangeUnit, MarkdownHunkMeta } from '../changeReview';

describe('computeDiffHunks', () => {
  it('returns empty array when texts are identical', () => {
    expect(computeDiffHunks('a\nb', 'a\nb')).toEqual([]);
  });

  it('returns a single hunk for a contiguous replacement', () => {
    const oldText = 'line1\nkeep\nline3';
    const newText = 'line1\nchanged\nline3';
    const hunks = computeDiffHunks(oldText, newText);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].oldText).toBe('keep');
    expect(hunks[0].newText).toBe('changed');
  });

  it('returns separate hunks for non-contiguous changes', () => {
    const oldText = 'a\nb\nc\nd\ne';
    const newText = 'a\nB\nc\nD\ne';
    const hunks = computeDiffHunks(oldText, newText);
    expect(hunks.length).toBe(2);
    expect(hunks[0].oldText).toBe('b');
    expect(hunks[0].newText).toBe('B');
    expect(hunks[1].oldText).toBe('d');
    expect(hunks[1].newText).toBe('D');
  });

  it('omits blank-only hunks around a substantive Markdown insertion', () => {
    const oldText = [
      '# ADR',
      '',
      '## Context',
      'Current context.',
      '',
      '## Consequences',
      'Current consequences.',
    ].join('\n');
    const newText = [
      '# ADR',
      '',
      '',
      '## Context',
      'Current context.',
      '',
      '',
      '## Proposed Architecture',
      'flowchart LR',
      '  A --> B',
      '',
      '## Consequences',
      'Current consequences.',
    ].join('\n');

    const hunks = computeDiffHunks(oldText, newText);

    expect(hunks).toHaveLength(1);
    expect(hunks[0].newText).toContain('## Proposed Architecture');
    expect(hunks.every((hunk) => hunk.oldText.trim() || hunk.newText.trim())).toBe(true);
  });
});

describe('mergeSelectedHunks', () => {
  it('keeps old text when no hunks are approved', () => {
    const oldText = 'a\nb\nc';
    const newText = 'a\nX\nc';
    const hunks = computeDiffHunks(oldText, newText);
    const merged = mergeSelectedHunks(oldText, hunks, new Set());
    expect(merged).toBe(oldText);
  });

  it('applies only approved hunks in a multi-hunk diff', () => {
    const oldText = 'a\nb\nc\nd\ne';
    const newText = 'a\nB\nc\nD\ne';
    const hunks = computeDiffHunks(oldText, newText);
    expect(hunks).toHaveLength(2);
    const merged = mergeSelectedHunks(oldText, hunks, new Set([hunks[0].id]));
    expect(merged).toBe('a\nB\nc\nd\ne');
  });

  it('applies all approved hunks', () => {
    const oldText = 'a\nb\nc\nd\ne';
    const newText = 'a\nB\nc\nD\ne';
    const hunks = computeDiffHunks(oldText, newText);
    const merged = mergeSelectedHunks(
      oldText,
      hunks,
      new Set(hunks.map((h) => h.id)),
    );
    expect(merged).toBe(newText);
  });
});

describe('buildPrdChangeUnits', () => {
  it('builds markdown hunk units from content changes', () => {
    const units = buildPrdChangeUnits(
      { content: 'alpha\nbeta\ngamma' },
      { content: 'alpha\nBETA\ngamma' },
    );
    expect(units.length).toBe(1);
    expect(units[0].kind).toBe('markdown-hunk');
    expect(units[0].decision).toBe('pending');
    expect(units[0].oldText).toBe('beta');
    expect(units[0].newText).toBe('BETA');
  });

  it('builds backlog item units from structural backlog diffs', () => {
    const current = { epics: [{ title: 'Epic A', features: [] }] };
    const proposed = {
      epics: [
        { title: 'Epic A', features: [] },
        { title: 'Epic B', features: [] },
      ],
    };
    const units = buildPrdChangeUnits(
      { content: '# same', backlog: current },
      { content: '# same', backlog: proposed },
    );
    const backlogUnits = units.filter((u) => u.kind === 'backlog-item');
    expect(backlogUnits.length).toBeGreaterThanOrEqual(1);
    expect(backlogUnits.some((u) => u.newText.includes('Epic B'))).toBe(true);
  });
});

describe('reapplyDecisions', () => {
  it('preserves prior decisions for matching ids and resets regenerated unit', () => {
    const prior: ChangeUnit[] = [
      {
        id: 'content:h1',
        title: 'c1',
        kind: 'markdown-hunk',
        oldText: 'a',
        newText: 'b',
        meta: { hunk: { id: 'h1', oldStart: 0, oldCount: 1, newStart: 0, newCount: 1, oldText: 'a', newText: 'b' } },
        decision: 'approved',
      },
      {
        id: 'content:h2',
        title: 'c2',
        kind: 'markdown-hunk',
        oldText: 'c',
        newText: 'd',
        meta: { hunk: { id: 'h2', oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, oldText: 'c', newText: 'd' } },
        decision: 'rejected',
      },
    ];
    const next: ChangeUnit[] = [
      { ...prior[0], decision: 'pending' },
      { ...prior[1], newText: 'd2', decision: 'pending' },
    ];
    const result = reapplyDecisions(next, prior, 'content:h2');
    expect(result[0].decision).toBe('approved');
    expect(result[1].decision).toBe('pending');
  });
});

describe('mergePrdProposalFromUnits', () => {
  it('merges mixed approve/reject content decisions', () => {
    const current = { content: 'a\nb\nc\nd\ne' };
    const proposed = { content: 'a\nB\nc\nD\ne' };
    const units = buildPrdChangeUnits(current, proposed);
    expect(units).toHaveLength(2);
    units[0].decision = 'approved';
    units[1].decision = 'rejected';
    const merged = mergePrdProposalFromUnits(current, proposed, units);
    expect(merged.content).toBe('a\nB\nc\nd\ne');
  });
});

describe('mergeBacklogSelective', () => {
  it('adds only approved backlog items', () => {
    const current = { epics: [{ title: 'Epic A', features: [] }] };
    const proposed = {
      epics: [
        { title: 'Epic A', features: [] },
        { title: 'Epic B', features: [] },
      ],
    };
    const units = buildPrdChangeUnits(
      { content: 'x', backlog: current },
      { content: 'x', backlog: proposed },
    );
    const backlogUnits = units.filter((u) => u.kind === 'backlog-item');
    backlogUnits.forEach((u) => {
      u.decision = u.newText.includes('Epic B') ? 'approved' : 'rejected';
    });
    const merged = mergeBacklogSelective(current, proposed, backlogUnits) as {
      epics: { title: string }[];
    };
    expect(merged.epics.map((e) => e.title).sort()).toEqual(['Epic A', 'Epic B']);
  });
});

describe('countDecisions', () => {
  it('counts approved/rejected/pending', () => {
    const units = [
      { decision: 'approved' },
      { decision: 'rejected' },
      { decision: 'pending' },
      { decision: 'approved' },
    ] as ChangeUnit[];
    expect(countDecisions(units)).toEqual({ approved: 2, rejected: 1, pending: 1 });
  });
});

describe('buildDesignDocChangeUnits / mergeDesignDocProposalFromUnits', () => {
  it('builds hunks per design-doc section and merges selectively', () => {
    const current = {
      design: 'd1\nd2\nd3',
      techSpec: 't1\nt2',
      assumptions: 'a1',
    };
    const proposed = {
      design: 'd1\nD2\nd3',
      techSpec: 't1\nT2',
      assumptions: null,
    };
    const units = buildDesignDocChangeUnits(current, proposed);
    expect(units.some((u) => u.title.startsWith('Design'))).toBe(true);
    expect(units.some((u) => u.title.startsWith('Tech Spec'))).toBe(true);
    expect(units.every((u) => !u.title.startsWith('Assumptions'))).toBe(true);

    units.forEach((u) => {
      u.decision = u.title.startsWith('Design') ? 'approved' : 'rejected';
    });
    const merged = mergeDesignDocProposalFromUnits(current, proposed, units);
    expect(merged.designContent).toBe('d1\nD2\nd3');
    expect(merged.techSpecContent).toBe('t1\nt2');
    expect(merged.assumptionsContent).toBeUndefined();
  });
});

describe('buildAdrChangeUnits / mergeAdrProposalFromUnits', () => {
  it('builds ADR hunks and keeps rejected regions as live text', () => {
    const current = 'a\nb\nc\nd\ne';
    const proposed = 'a\nB\nc\nD\ne';
    const units = buildAdrChangeUnits(current, proposed);
    expect(units.length).toBe(2);
    units[0].decision = 'approved';
    units[1].decision = 'rejected';
    const merged = mergeAdrProposalFromUnits(current, proposed, units);
    expect(merged.content).toBe('a\nB\nc\nd\ne');
  });

  it('does not create an empty full-section review for whitespace-only changes', () => {
    expect(buildAdrChangeUnits('# ADR\nContent', '# ADR\nContent\n')).toEqual([]);
  });

  it('groups Mermaid opening and closing fences into one review unit for every document type', () => {
    const current = [
      '## Proposed Architecture',
      '',
      'flowchart LR',
      '  A --> B',
      '',
      '## Consequences',
      'None.',
    ].join('\n');
    const proposed = [
      '## Proposed Architecture',
      '',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
      '',
      '## Consequences',
      'None.',
    ].join('\n');

    const adrUnits = buildAdrChangeUnits(current, proposed);
    const prdUnits = buildPrdChangeUnits({ content: current }, { content: proposed });
    const designDocUnits = buildDesignDocChangeUnits(
      { design: current, techSpec: '', assumptions: '' },
      { design: proposed },
    );

    for (const units of [adrUnits, prdUnits, designDocUnits]) {
      expect(units).toHaveLength(1);
      expect(units[0].oldText).toContain('flowchart LR');
      expect(units[0].newText).toContain('```mermaid');
      expect(units[0].newText).toContain('```');
    }

    adrUnits[0].decision = 'approved';
    expect(mergeAdrProposalFromUnits(current, proposed, adrUnits).content).toBe(proposed);
  });
});

// silence unused type import in some jest setups
void (null as unknown as MarkdownHunkMeta);
