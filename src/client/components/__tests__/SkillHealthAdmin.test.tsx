import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SkillHealthAdmin } from '../SkillHealthAdmin';
import { useCreateSkillHealthWorkItem, useSkillHealth } from '../../hooks/useSkillHealth';
import type {
  SkillHealthOverview,
  SkillHealthProject,
  SkillHealthProjectEvaluation,
  SkillHealthSkill,
} from '../../../shared/types/skillHealth';

jest.mock('../../hooks/useSkillHealth', () => ({
  useSkillHealth: jest.fn(),
  useCreateSkillHealthWorkItem: jest.fn(),
}));

jest.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Passthrough,
    LineChart: Passthrough,
    Line: () => null,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  };
});

const mockUseSkillHealth = useSkillHealth as jest.MockedFunction<typeof useSkillHealth>;
const mockUseCreate = useCreateSkillHealthWorkItem as jest.MockedFunction<typeof useCreateSkillHealthWorkItem>;
const mutate = jest.fn();

const skill = (overrides: Partial<SkillHealthSkill> = {}): SkillHealthSkill => ({
  key: 'MaxView:prd:.cursor/skills/to-prd/skill.md',
  project: 'MaxView',
  artifactKind: 'prd',
  skillPath: '.cursor/skills/to-prd/SKILL.md',
  status: 'fair',
  documents: 12,
  scoredDocuments: 10,
  averageScore: 72.5,
  passRate: 0.6,
  acceptanceRate: 0.75,
  revisionRequested: 2,
  overrides: 1,
  generationFailures: 0,
  reviewComments: 18,
  commentsPerDocument: 1.5,
  costUsd: 10.08,
  costPerDocument: 0.84,
  attribution: { 'document-settings': 10, 'project-default': 2, unattributed: 0 },
  trend: [{ weekStart: '2026-10-12', documents: 3, averageScore: 70 }],
  sections: [
    { sectionKey: 'backlog', commentCount: 4 },
    { sectionKey: 'prd', commentCount: 1 },
  ],
  recurringGaps: [
    {
      section: 'Non-functional requirements',
      occurrences: 9,
      documentCount: 7,
      sampleDescriptions: ['No numeric latency target'],
      exampleDocumentIds: ['a'],
    },
  ],
  versions: [
    {
      skillSha256: 'abcdef1234567890',
      documents: 4,
      scoredDocuments: 4,
      averageScore: 81,
      passRate: 0.75,
      acceptanceRate: 1,
      firstSeen: '2026-10-12T00:00:00.000Z',
      lastSeen: '2026-10-15T00:00:00.000Z',
      humanEvents: 2,
      humanAverageScore: 3.4,
    },
    {
      skillSha256: null,
      documents: 8,
      scoredDocuments: 6,
      averageScore: 68,
      passRate: 0.5,
      acceptanceRate: 0.6,
      firstSeen: '2026-09-20T00:00:00.000Z',
      lastSeen: '2026-10-10T00:00:00.000Z',
      humanEvents: 0,
      humanAverageScore: null,
    },
  ],
  ...overrides,
});

const apexSkill = skill({
  key: 'Apex:prd:.cursor/skills/to-prd/skill.md',
  project: 'Apex',
  status: 'good',
  passRate: 0.92,
  recurringGaps: [],
  sections: [],
});

const project = (overrides: Partial<SkillHealthProject> = {}): SkillHealthProject => ({
  project: 'MaxView',
  skillRepo: 'MaxView',
  isFoundation: false,
  skills: [skill()],
  evaluation: null,
  ...overrides,
});

const apexProject = project({ project: 'Apex', skillRepo: 'org/Apex', isFoundation: true, skills: [apexSkill] });

const outcomes = { accept_unchanged: 1, accept_after_edits: 1, regenerate: 0, reject: 1 };
const evaluation: SkillHealthProjectEvaluation = {
  events: 3,
  stages: [{ stageKey: 'prd_human_review', subjectType: 'prd', events: 3, outcomes }],
  flagged: [
    {
      eventId: 'event-2',
      stageKey: 'prd_human_review',
      subjectType: 'prd',
      subjectId: 'prd-2',
      outcome: 'reject',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      commentExcerpt: 'Missed the export flow',
      createdAt: '2026-10-14T00:00:00.000Z',
    },
  ],
  skills: [
    {
      key: 'MaxView:prd:.cursor/skills/to-prd/skill.md',
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      subjectType: 'prd',
      events: 3,
      criteriaAverages: {
        intent_alignment: 4,
        requirements_coverage: 3,
        scope_alignment: 3.5,
        acceptance_criteria: 2.5,
        readiness: 3,
      },
      averageScore: 3.2,
      outcomes,
      promptfoo: { pending: 0, running: 0, ready: 2, failed: 1 },
      judge: { pending: 1, running: 0, ready: 2, failed: 0 },
      recommendations: [
        {
          eventId: 'event-1',
          stageKey: 'prd_human_review',
          text: 'State a numeric latency target',
          criterion: 'readiness',
          createdAt: '2026-10-13T00:00:00.000Z',
        },
      ],
    },
  ],
};

const overview = (projects: SkillHealthProject[]): SkillHealthOverview => ({
  periodDays: 30,
  periodFrom: '2026-09-19T00:00:00.000Z',
  generatedAt: '2026-10-19T00:00:00.000Z',
  projects,
  caveats: ['Only PRDs and design docs are scored today.'],
});

function mockResult(partial: Partial<ReturnType<typeof useSkillHealth>>) {
  mockUseSkillHealth.mockReturnValue({ data: undefined, isLoading: false, error: null, ...partial } as ReturnType<
    typeof useSkillHealth
  >);
}

function mockCreate(partial: Partial<ReturnType<typeof useCreateSkillHealthWorkItem>> = {}) {
  mockUseCreate.mockReturnValue({ mutate, isPending: false, error: null, data: undefined, ...partial } as unknown as ReturnType<
    typeof useCreateSkillHealthWorkItem
  >);
}

describe('SkillHealthAdmin', () => {
  beforeEach(() => {
    mockUseSkillHealth.mockReset();
    mutate.mockReset();
    mockCreate();
  });

  it('shows a loading state', () => {
    mockResult({ isLoading: true });
    render(<SkillHealthAdmin />);
    expect(screen.getByText('Loading Skill Health…')).toBeInTheDocument();
  });

  it('shows an empty state when no documents exist in the period', () => {
    mockResult({ data: overview([]) });
    render(<SkillHealthAdmin />);
    expect(screen.getByText(/No PRDs, design docs or human feedback in the last 30 days/)).toBeInTheDocument();
  });

  it('shows the first project with its repo, skills, detail and caveats', () => {
    mockResult({ data: overview([apexProject, project()]) });
    render(<SkillHealthAdmin />);

    expect(screen.getByTestId('skill-health-project-Apex')).toHaveTextContent('Apex (foundation)');
    expect(screen.getByTestId('skill-health-project-summary')).toHaveTextContent(
      'Skill repo: org/Apex · Work items go to Apex Backlog (foundation Skill).',
    );
    const table = screen.getByTestId('skill-health-table');
    expect(within(table).getByText('Good')).toBeInTheDocument();
    expect(within(table).getByText('92%')).toBeInTheDocument();
    expect(screen.getByTestId('skill-health-caveats')).toHaveTextContent('Only PRDs and design docs');
  });

  it('switches to another project and shows only its skills', () => {
    mockResult({ data: overview([apexProject, project()]) });
    render(<SkillHealthAdmin />);

    fireEvent.click(screen.getByTestId('skill-health-project-MaxView'));

    expect(screen.getByTestId('skill-health-project-summary')).toHaveTextContent(
      'Skill repo: MaxView · Work items go to MaxView Azure DevOps.',
    );
    const table = screen.getByTestId('skill-health-table');
    expect(within(table).getByText('Fair')).toBeInTheDocument();
    expect(within(table).queryByText('Good')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('skill-health-heatmap')).getByText('Backlog')).toBeInTheDocument();
    expect(screen.getByTestId('skill-health-gaps')).toHaveTextContent('No numeric latency target');
  });

  it('lists SKILL.md versions with a short hash and an unversioned row', () => {
    mockResult({ data: overview([project()]) });
    render(<SkillHealthAdmin />);

    expect(screen.getByTestId('skill-health-version-abcdef12')).toHaveTextContent('2026-10-12 – 2026-10-15');
    expect(screen.getByTestId('skill-health-version-abcdef12')).toHaveTextContent('75%');
    expect(screen.getByTestId('skill-health-version-unversioned')).toHaveTextContent('Unversioned');
  });

  it('switches the detail view to the chosen skill', () => {
    const second = skill({
      key: 'MaxView:design_doc:',
      artifactKind: 'design_doc',
      skillPath: null,
      status: 'insufficient_data',
      recurringGaps: [],
      sections: [],
    });
    mockResult({ data: overview([project({ skills: [skill(), second] })]) });
    render(<SkillHealthAdmin />);

    fireEvent.click(screen.getByTestId('skill-health-view-MaxView:design_doc:'));

    expect(screen.getByText('App default')).toBeInTheDocument();
    expect(screen.getByText('No open validation gaps in this period.')).toBeInTheDocument();
    expect(screen.getByText('No review comments in this period.')).toBeInTheDocument();
  });

  it('requests the selected period', () => {
    mockResult({ data: overview([project()]) });
    render(<SkillHealthAdmin />);

    fireEvent.change(screen.getByTestId('skill-health-period'), { target: { value: '90' } });

    expect(mockUseSkillHealth).toHaveBeenLastCalledWith(90);
  });

  it('files a gap from a project to that project ADO by default', async () => {
    mockResult({ data: overview([project()]) });
    render(<SkillHealthAdmin />);

    fireEvent.click(screen.getByTestId('skill-health-gap-work-item-Non-functional requirements'));

    expect(screen.getByTestId('skill-health-work-item-title')).toHaveValue(
      'Skill Health: to-prd — Non-functional requirements (MaxView)',
    );
    expect((screen.getByTestId('skill-health-work-item-description') as HTMLTextAreaElement).value).toContain(
      '7 of 12 PRD documents in MaxView had an open "Non-functional requirements"',
    );
    expect(screen.getByTestId('skill-health-work-item-destination')).toHaveValue('project-ado');

    fireEvent.click(screen.getByTestId('skill-health-work-item-submit'));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          project: 'MaxView',
          destination: 'project-ado',
          artifactKind: 'prd',
          skillPath: '.cursor/skills/to-prd/SKILL.md',
          title: 'Skill Health: to-prd — Non-functional requirements (MaxView)',
        }),
      ),
    );
  });

  it('says when human feedback is off for the project', () => {
    mockResult({ data: overview([project()]) });
    render(<SkillHealthAdmin />);

    expect(screen.getByTestId('skill-health-evaluation-off')).toHaveTextContent('is off for MaxView');
    expect(screen.queryByTestId('skill-health-feedback-summary')).not.toBeInTheDocument();
  });

  it('shows stages, flagged events and per-Skill feedback, and files a judge recommendation', async () => {
    mockResult({ data: overview([project({ evaluation })]) });
    render(<SkillHealthAdmin />);

    expect(screen.getByTestId('skill-health-evaluation-stage-prd_human_review')).toHaveTextContent('PRD review');
    expect(screen.getByTestId('skill-health-evaluation-flagged')).toHaveTextContent('Missed the export flow');
    expect(screen.getByTestId('skill-health-feedback-summary')).toHaveTextContent('3.2');
    expect(screen.getByTestId('skill-health-version-abcdef12')).toHaveTextContent('3.4');

    fireEvent.click(screen.getByTestId('skill-health-recommendation-work-item-event-1-0'));

    expect(screen.getByTestId('skill-health-work-item-title')).toHaveValue(
      'Skill Health: to-prd — judge recommendation (MaxView)',
    );
    expect((screen.getByTestId('skill-health-work-item-description') as HTMLTextAreaElement).value).toContain(
      'State a numeric latency target',
    );
    fireEvent.click(screen.getByTestId('skill-health-work-item-submit'));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({ project: 'MaxView', artifactKind: 'prd', destination: 'project-ado' }),
      ),
    );
  });

  it('files an Interview Skill recommendation as an interview work item', async () => {
    const interviewSkill = {
      ...evaluation.skills[0],
      key: 'MaxView:interview_phase:.cursor/skills/grill-with-docs/skill.md',
      subjectType: 'interview_phase' as const,
      skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
      recommendations: [{ ...evaluation.skills[0].recommendations[0], eventId: 'event-9', stageKey: 'interview_phase_1' }],
    };
    mockResult({ data: overview([project({ skills: [], evaluation: { ...evaluation, skills: [interviewSkill] } })]) });
    render(<SkillHealthAdmin />);

    expect(screen.getByTestId('skill-health-no-documents')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('skill-health-recommendation-work-item-event-9-0'));
    fireEvent.click(screen.getByTestId('skill-health-work-item-submit'));

    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({ artifactKind: 'interview', skillPath: '.cursor/skills/grill-with-docs/SKILL.md' }),
      ),
    );
  });

  it('lets a project send a shared-Skill finding to the Apex Backlog', async () => {
    mockResult({ data: overview([project()]) });
    render(<SkillHealthAdmin />);

    fireEvent.click(screen.getByTestId('skill-health-create-work-item'));
    fireEvent.change(screen.getByTestId('skill-health-work-item-destination'), { target: { value: 'apex-backlog' } });
    fireEvent.click(screen.getByTestId('skill-health-work-item-submit'));

    await waitFor(() => expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ destination: 'apex-backlog' })));
  });

  it('offers only the Apex Backlog for foundation Skills', () => {
    mockResult({ data: overview([apexProject]) });
    render(<SkillHealthAdmin />);

    fireEvent.click(screen.getByTestId('skill-health-create-work-item'));

    expect(screen.queryByTestId('skill-health-work-item-destination')).not.toBeInTheDocument();
    expect(screen.getByTestId('skill-health-work-item-modal')).toHaveTextContent('Apex Backlog (foundation Skill)');
  });

  it('links to the created ADO work item', () => {
    mockCreate({
      data: { destination: 'project-ado', project: 'MaxView', id: '42', url: 'https://ado/MaxView/_workitems/edit/42' },
    });
    mockResult({ data: overview([project()]) });
    render(<SkillHealthAdmin />);

    fireEvent.click(screen.getByTestId('skill-health-create-work-item'));

    const created = screen.getByTestId('skill-health-work-item-created');
    expect(created).toHaveTextContent('Created #42 in MaxView Azure DevOps.');
    expect(within(created).getByRole('link', { name: '#42' })).toHaveAttribute(
      'href',
      'https://ado/MaxView/_workitems/edit/42',
    );
  });

  it('shows the server error when creation fails', () => {
    mockCreate({ error: new Error('You do not have Azure DevOps access') });
    mockResult({ data: overview([project()]) });
    render(<SkillHealthAdmin />);

    fireEvent.click(screen.getByTestId('skill-health-create-work-item'));

    expect(screen.getByRole('alert')).toHaveTextContent('You do not have Azure DevOps access');
  });
});
