import {
  BUNDLE_HASH_FORMAT,
  bundleHashV1,
  type SkillBundleCompanion,
} from '../services/playbookSkillBundle';

const SKILL = '---\nname: incident-investigation\n---\n# Procedure\n';
const GUIDE: SkillBundleCompanion = {
  path: 'INVESTIGATION_GUIDE.md',
  content: '# Guide\n',
  classification: 'instruction',
};
const CATALOG: SkillBundleCompanion = {
  path: 'RESOURCE_CATALOG.md',
  content: '| dev | app-dev |\n',
  classification: 'reference',
};

function hashOf(overrides: Partial<Parameters<typeof bundleHashV1>[0]> = {}): string {
  return bundleHashV1({
    skillVersionId: 'ver-1',
    skillContent: SKILL,
    companions: [GUIDE, CATALOG],
    ...overrides,
  });
}

describe('bundleHashV1', () => {
  it('names its format for the policy record', () => {
    expect(BUNDLE_HASH_FORMAT).toBe('bundle-v1');
  });

  it('returns 64 lowercase hex characters', () => {
    expect(hashOf()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same however the companions are ordered', () => {
    expect(hashOf({ companions: [GUIDE, CATALOG] })).toBe(
      hashOf({ companions: [CATALOG, GUIDE] }),
    );
  });

  it('treats CRLF and LF line endings as the same bytes', () => {
    expect(hashOf({ skillContent: 'a\r\nb\r\n' })).toBe(hashOf({ skillContent: 'a\nb\n' }));
  });

  it('changes when the skill version ID changes', () => {
    expect(hashOf({ skillVersionId: 'ver-2' })).not.toBe(hashOf());
  });

  it('changes when SKILL.md changes', () => {
    expect(hashOf({ skillContent: SKILL + 'Use the catalog.\n' })).not.toBe(hashOf());
  });

  it('changes when an instruction companion changes', () => {
    expect(
      hashOf({ companions: [{ ...GUIDE, content: '# Guide, revised\n' }, CATALOG] }),
    ).not.toBe(hashOf());
  });

  it('ignores reference companions, so a catalog edit leaves the pin alone', () => {
    expect(
      hashOf({ companions: [GUIDE, { ...CATALOG, content: '| prod | app-prod |\n' }] }),
    ).toBe(hashOf());
  });

  it('ignores a reference companion entirely, including its presence', () => {
    expect(hashOf({ companions: [GUIDE] })).toBe(hashOf());
  });

  it('separates bytes that would otherwise run together across two files', () => {
    const split = (a: string, b: string) =>
      bundleHashV1({
        skillVersionId: 'ver-1',
        skillContent: SKILL,
        companions: [
          { path: 'A.md', content: a, classification: 'instruction' },
          { path: 'B.md', content: b, classification: 'instruction' },
        ],
      });
    expect(split('xy', '')).not.toBe(split('x', 'y'));
  });

  it('rejects two companions with the same path', () => {
    expect(() => hashOf({ companions: [GUIDE, GUIDE] })).toThrow(/appears twice/);
  });

  it.each(['', '.', '..', 'docs/GUIDE.md', 'docs\\GUIDE.md', 'a\nb.md'])(
    'rejects the companion path %j',
    (path) => {
      expect(() =>
        hashOf({
          companions: [{ path, content: 'x', classification: 'instruction' }],
        }),
      ).toThrow(/bare file name/);
    },
  );

  it('rejects an empty skill version ID', () => {
    expect(() => hashOf({ skillVersionId: '' })).toThrow(/skill version ID/);
  });
});
