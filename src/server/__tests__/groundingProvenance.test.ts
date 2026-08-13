import { stampGroundingProvenance } from '../../shared/utils/groundingProvenance';

const input = {
  groundedSha: 'A'.repeat(40),
  repository: 'AI-Pilot',
  branch: 'main',
  groundedAt: '2026-08-02T14:00:00.000Z',
};

describe('stampGroundingProvenance', () => {
  it('prefixes generated markdown with a durable SHA stamp', () => {
    const stamped = stampGroundingProvenance('# PRD\n\nHello', input);

    expect(stamped).toContain(`<!-- apex-grounded-sha:${'a'.repeat(40)} -->`);
    expect(stamped).toContain('AI-Pilot');
    expect(stamped).toContain('main');
    expect(stamped).toContain('# PRD');
  });

  it('replaces an existing stamp instead of stacking another copy', () => {
    const first = stampGroundingProvenance('# PRD\n\nHello', input);
    const second = stampGroundingProvenance(first, {
      ...input,
      groundedSha: 'b'.repeat(40),
    });

    expect(second.match(/apex-grounded-sha:/g)).toHaveLength(1);
    expect(second).toContain('b'.repeat(40));
    expect(second).not.toContain('a'.repeat(40));
  });

  it('leaves content unchanged when the SHA is empty', () => {
    expect(
      stampGroundingProvenance('# PRD', { ...input, groundedSha: '  ' }),
    ).toBe('# PRD');
  });
});
