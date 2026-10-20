import {
  buildSkillHealthProjects,
  buildSkillHealthSkills,
  deriveStatus,
  normalizeSkillPath,
  weekStartOf,
  type SkillHealthDocumentInput,
  type SkillHealthInputs,
  type SkillHealthSettingsInput,
} from '../services/skillHealthMetrics';
import type { ValidationScorecard } from '../../shared/types/interview';

const settings = (overrides: Partial<SkillHealthSettingsInput> = {}): SkillHealthSettingsInput => ({
  id: 'settings-a',
  project: 'MaxView',
  skillRepo: 'MaxView',
  isDefault: true,
  prdSkillPath: '/.cursor/skills/to-prd/SKILL.md',
  designDocSkillPath: '.cursor/skills/prd-design-spec/SKILL.md',
  prdThreshold: 70,
  designDocThreshold: null,
  ...overrides,
});

const doc = (overrides: Partial<SkillHealthDocumentInput> = {}): SkillHealthDocumentInput => ({
  id: 'doc-1',
  kind: 'prd',
  project: 'MaxView',
  createdAt: '2026-10-14T12:00:00.000Z',
  status: 'draft',
  validationScore: 80,
  scorecard: null,
  skillSettingsId: 'settings-a',
  skillSha256: null,
  hasOverride: false,
  ...overrides,
});

const inputs = (overrides: Partial<SkillHealthInputs> = {}): SkillHealthInputs => ({
  documents: [],
  settings: [settings()],
  comments: [],
  costs: [],
  ...overrides,
});

const scorecardWithGaps = (sections: string[]): ValidationScorecard =>
  ({
    slug: 's',
    generated_at: '2026-10-14T00:00:00Z',
    review_phase: 'initial',
    overall_score: 60,
    ready_threshold: 75,
    is_ready: false,
    verdict: 'gaps',
    gaps: sections.map((section, i) => ({
      id: `g${i}`,
      file: 'design.md',
      section,
      score: 1,
      description: `${section} is vague`,
      what_3_looks_like: '',
      resolution: 'pending',
    })),
  }) as ValidationScorecard;

describe('normalizeSkillPath', () => {
  it('strips leading slashes and normalizes separators', () => {
    expect(normalizeSkillPath('/.cursor\\skills\\to-prd\\SKILL.md')).toBe('.cursor/skills/to-prd/SKILL.md');
  });

  it('returns null for empty values', () => {
    expect(normalizeSkillPath('  ')).toBeNull();
    expect(normalizeSkillPath(null)).toBeNull();
  });
});

describe('weekStartOf', () => {
  it('returns the Monday of the week in UTC', () => {
    expect(weekStartOf('2026-10-18T23:00:00.000Z')).toBe('2026-10-12');
    expect(weekStartOf('2026-10-19T01:00:00.000Z')).toBe('2026-10-19');
  });
});

describe('deriveStatus', () => {
  it('reports insufficient data below the minimum sample', () => {
    expect(deriveStatus(4, 1)).toBe('insufficient_data');
  });

  it('grades by pass rate once the sample is large enough', () => {
    expect(deriveStatus(5, 0.8)).toBe('good');
    expect(deriveStatus(5, 0.5)).toBe('fair');
    expect(deriveStatus(5, 0.49)).toBe('poor');
  });
});

describe('buildSkillHealthSkills', () => {
  it('groups documents by the Skill path on their own settings row', () => {
    const [skill] = buildSkillHealthSkills(
      inputs({ documents: [doc({ id: 'a', validationScore: 80 }), doc({ id: 'b', validationScore: 60 })] }),
    );

    expect(skill.skillPath).toBe('.cursor/skills/to-prd/SKILL.md');
    expect(skill.documents).toBe(2);
    expect(skill.averageScore).toBe(70);
    expect(skill.passRate).toBe(0.5);
    expect(skill.attribution['document-settings']).toBe(2);
  });

  it('falls back to the project default settings row, then to unattributed', () => {
    const skills = buildSkillHealthSkills(
      inputs({
        documents: [
          doc({ id: 'a', skillSettingsId: null }),
          doc({ id: 'b', skillSettingsId: null, project: 'Unknown' }),
        ],
      }),
    );

    const attributed = skills.find((s) => s.skillPath !== null);
    const unattributed = skills.find((s) => s.skillPath === null);
    expect(attributed?.attribution['project-default']).toBe(1);
    expect(unattributed?.attribution.unattributed).toBe(1);
  });

  it('uses the scorecard threshold when the project sets none', () => {
    const [skill] = buildSkillHealthSkills(
      inputs({
        documents: [doc({ kind: 'design_doc', validationScore: 70, scorecard: scorecardWithGaps([]) })],
      }),
    );

    expect(skill.artifactKind).toBe('design_doc');
    expect(skill.passRate).toBe(0);
  });

  it('computes acceptance from approved versus sent-back documents', () => {
    const [skill] = buildSkillHealthSkills(
      inputs({
        documents: [
          doc({ id: 'a', status: 'approved' }),
          doc({ id: 'b', status: 'reviewer_approved' }),
          doc({ id: 'c', status: 'revision_requested' }),
          doc({ id: 'd', status: 'draft', hasOverride: true }),
        ],
      }),
    );

    expect(skill.acceptanceRate).toBeCloseTo(2 / 3);
    expect(skill.revisionRequested).toBe(1);
    expect(skill.overrides).toBe(1);
  });

  it('attaches comments and cost only to documents of the matching type', () => {
    const [skill] = buildSkillHealthSkills(
      inputs({
        documents: [doc({ id: 'a' })],
        comments: [
          { documentId: 'a', documentType: 'prd', sectionKey: 'backlog' },
          { documentId: 'a', documentType: 'prd', sectionKey: 'backlog' },
          { documentId: 'a', documentType: 'design_doc', sectionKey: 'design' },
        ],
        costs: [
          { documentId: 'a', documentType: 'prd', costUsd: 1.234 },
          { documentId: 'a', documentType: 'design_doc', costUsd: 9 },
        ],
      }),
    );

    expect(skill.reviewComments).toBe(2);
    expect(skill.sections).toEqual([{ sectionKey: 'backlog', commentCount: 2 }]);
    expect(skill.costUsd).toBe(1.23);
  });

  it('ranks recurring gaps by how many documents share them', () => {
    const [skill] = buildSkillHealthSkills(
      inputs({
        documents: [
          doc({ id: 'a', scorecard: scorecardWithGaps(['NFRs', 'Scope']) }),
          doc({ id: 'b', scorecard: scorecardWithGaps(['nfrs']) }),
        ],
      }),
    );

    expect(skill.recurringGaps[0]).toMatchObject({ section: 'NFRs', documentCount: 2, occurrences: 2 });
    expect(skill.recurringGaps[0].sampleDescriptions).toEqual(['NFRs is vague', 'nfrs is vague']);
  });

  it('keeps the same Skill path in two projects as two Skills', () => {
    const skills = buildSkillHealthSkills(
      inputs({
        settings: [settings(), settings({ id: 'settings-apex', project: 'Apex', skillRepo: 'org/Apex' })],
        documents: [
          doc({ id: 'a' }),
          doc({ id: 'b', project: 'Apex', skillSettingsId: 'settings-apex' }),
        ],
      }),
    );

    expect(skills.map((s) => s.key).sort()).toEqual([
      'Apex:prd:.cursor/skills/to-prd/skill.md',
      'MaxView:prd:.cursor/skills/to-prd/skill.md',
    ]);
    expect(skills.every((s) => s.documents === 1)).toBe(true);
  });

  it('breaks a Skill down by SKILL.md version, newest first and unversioned last', () => {
    const [skill] = buildSkillHealthSkills(
      inputs({
        documents: [
          doc({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z', validationScore: 40 }),
          doc({ id: 'v1a', skillSha256: 'aaa', createdAt: '2026-10-01T00:00:00.000Z', validationScore: 60 }),
          doc({ id: 'v1b', skillSha256: 'aaa', createdAt: '2026-10-03T00:00:00.000Z', status: 'approved' }),
          doc({ id: 'v2', skillSha256: 'bbb', createdAt: '2026-10-10T00:00:00.000Z', validationScore: 90 }),
        ],
      }),
    );

    expect(skill.versions).toEqual([
      expect.objectContaining({ skillSha256: 'bbb', documents: 1, averageScore: 90, passRate: 1 }),
      expect.objectContaining({
        skillSha256: 'aaa',
        documents: 2,
        averageScore: 70,
        passRate: 0.5,
        acceptanceRate: 1,
        firstSeen: '2026-10-01T00:00:00.000Z',
        lastSeen: '2026-10-03T00:00:00.000Z',
      }),
      expect.objectContaining({ skillSha256: null, documents: 1, passRate: 0 }),
    ]);
  });
});

describe('buildSkillHealthProjects', () => {
  it('lists the foundation project first with each project repo', () => {
    const projects = buildSkillHealthProjects(
      inputs({
        settings: [
          settings({ id: 'settings-amego', project: 'Amego', skillRepo: 'Amego' }),
          settings(),
          settings({ id: 'settings-apex', project: 'Apex', skillRepo: 'org/Apex' }),
        ],
        documents: [
          doc({ id: 'a' }),
          doc({ id: 'b', project: 'Apex', skillSettingsId: 'settings-apex' }),
          doc({ id: 'c', project: 'Amego', skillSettingsId: 'settings-amego' }),
          doc({ id: 'd', project: 'Amego', kind: 'design_doc', skillSettingsId: 'settings-amego' }),
        ],
      }),
    );

    expect(projects.map((p) => [p.project, p.skillRepo, p.isFoundation])).toEqual([
      ['Apex', 'org/Apex', true],
      ['Amego', 'Amego', false],
      ['MaxView', 'MaxView', false],
    ]);
    expect(projects[1].skills.map((s) => s.artifactKind).sort()).toEqual(['design_doc', 'prd']);
  });

  it('reports a null repo for a project without settings', () => {
    const [project] = buildSkillHealthProjects(inputs({ settings: [], documents: [doc({ skillSettingsId: null })] }));

    expect(project).toMatchObject({ project: 'MaxView', skillRepo: null, isFoundation: false });
  });
});
