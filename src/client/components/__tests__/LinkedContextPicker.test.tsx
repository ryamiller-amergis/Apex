import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  LinkCandidate,
  LinkedContextReadModel,
} from '../../../shared/types/interviewLinks';
import {
  LinkedContextPicker,
  type StagedLinkedContextSelection,
} from '../LinkedContextPicker';
import {
  useAddAdrLink,
  useAddDesignModuleLink,
  useLinkCandidates,
  useLinkedContext,
  useRemoveAdrLink,
  useRemoveDesignModuleLink,
} from '../../hooks/useLinkedContext';

jest.mock('../../hooks/useDebouncedValue', () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

jest.mock('../../hooks/useLinkedContext', () => ({
  useLinkedContext: jest.fn(),
  useLinkCandidates: jest.fn(),
  useAddAdrLink: jest.fn(),
  useAddDesignModuleLink: jest.fn(),
  useRemoveAdrLink: jest.fn(),
  useRemoveDesignModuleLink: jest.fn(),
}));

const mockUseLinkedContext = useLinkedContext as jest.MockedFunction<
  typeof useLinkedContext
>;
const mockUseLinkCandidates = useLinkCandidates as jest.MockedFunction<
  typeof useLinkCandidates
>;
const mockUseAddAdrLink = useAddAdrLink as jest.MockedFunction<
  typeof useAddAdrLink
>;
const mockUseAddDesignModuleLink =
  useAddDesignModuleLink as jest.MockedFunction<
    typeof useAddDesignModuleLink
  >;
const mockUseRemoveAdrLink = useRemoveAdrLink as jest.MockedFunction<
  typeof useRemoveAdrLink
>;
const mockUseRemoveDesignModuleLink =
  useRemoveDesignModuleLink as jest.MockedFunction<
    typeof useRemoveDesignModuleLink
  >;

const PROJECT = 'Apex';
const INTERVIEW_ID = 'interview-1';
const LINKED_AT = '2026-08-06T00:00:00.000Z';

const adrCandidate: LinkCandidate = {
  type: 'adr',
  id: 'adr-2',
  title: 'Use an event stream',
  status: 'accepted',
};
const moduleCandidate: LinkCandidate = {
  type: 'design-module',
  id: 'module-2',
  name: 'Interview orchestration',
};

let linkedContext: LinkedContextReadModel;
let setLinkedContext:
  | React.Dispatch<React.SetStateAction<LinkedContextReadModel>>
  | undefined;
let candidatesByType: Record<'adr' | 'design-module', LinkCandidate[]>;
let candidateTotal: number;
let linksLoading: boolean;
let linksError: Error | null;
let candidatesLoading: boolean;
let candidatesError: Error | null;
let addAdrError: Error | null;
let removeAdrError: Error | null;

const addAdr = jest.fn();
const addDesignModule = jest.fn();
const removeAdr = jest.fn();
const removeDesignModule = jest.fn();
const refetchLinks = jest.fn();
const refetchCandidates = jest.fn();

function makeLinkedContext(
  overrides: Partial<LinkedContextReadModel> = {},
): LinkedContextReadModel {
  return {
    interviewId: INTERVIEW_ID,
    adrLinks: [
      {
        adrId: 'adr-1',
        title: 'Existing ADR',
        isAccepted: true,
        linkedBy: 'user-1',
        linkedAt: LINKED_AT,
      },
    ],
    designModuleLinks: [],
    count: 1,
    capacity: 10,
    ...overrides,
  };
}

function publish(next: LinkedContextReadModel): void {
  linkedContext = next;
  setLinkedContext?.(next);
}

function installHookMocks(): void {
  mockUseLinkedContext.mockImplementation(() => {
    const [data, setData] = React.useState(linkedContext);
    setLinkedContext = setData;
    return {
      data,
      isLoading: linksLoading,
      isError: Boolean(linksError),
      error: linksError,
      refetch: refetchLinks,
    } as unknown as ReturnType<typeof useLinkedContext>;
  });

  mockUseLinkCandidates.mockImplementation((_project, _interviewId, filters) => ({
    data: {
      items: candidatesByType[filters.type],
      total: candidateTotal,
      offset: filters.offset ?? 0,
      limit: filters.limit ?? 50,
    },
    isLoading: candidatesLoading,
    isError: Boolean(candidatesError),
    error: candidatesError,
    refetch: refetchCandidates,
  }) as unknown as ReturnType<typeof useLinkCandidates>);

  addAdr.mockImplementation(async ({ adrId }: { adrId: string }) => {
    if (addAdrError) throw addAdrError;
    const candidate = candidatesByType.adr.find((item) => item.id === adrId);
    const next = {
      ...linkedContext,
      adrLinks: [
        ...linkedContext.adrLinks,
        {
          adrId,
          title:
            candidate?.type === 'adr' ? candidate.title : 'Restored ADR',
          isAccepted: true,
          linkedBy: 'user-1',
          linkedAt: LINKED_AT,
        },
      ],
      count: linkedContext.count + 1,
    };
    publish(next);
    return { linkedContext: next };
  });

  addDesignModule.mockImplementation(
    async ({ designModuleId }: { designModuleId: string }) => {
      const candidate = candidatesByType['design-module'].find(
        (item) => item.id === designModuleId,
      );
      const next = {
        ...linkedContext,
        designModuleLinks: [
          ...linkedContext.designModuleLinks,
          {
            designModuleId,
            name:
              candidate?.type === 'design-module'
                ? candidate.name
                : 'Restored module',
            linkedBy: 'user-1',
            linkedAt: LINKED_AT,
          },
        ],
        count: linkedContext.count + 1,
      };
      publish(next);
      return { linkedContext: next };
    },
  );

  removeAdr.mockImplementation(async (adrId: string) => {
    if (removeAdrError) throw removeAdrError;
    const adrLinks = linkedContext.adrLinks.filter(
      (link) => link.adrId !== adrId,
    );
    const next = {
      ...linkedContext,
      adrLinks,
      count: adrLinks.length + linkedContext.designModuleLinks.length,
    };
    publish(next);
    return { linkedContext: next };
  });

  removeDesignModule.mockImplementation(async (designModuleId: string) => {
    const designModuleLinks = linkedContext.designModuleLinks.filter(
      (link) => link.designModuleId !== designModuleId,
    );
    const next = {
      ...linkedContext,
      designModuleLinks,
      count: linkedContext.adrLinks.length + designModuleLinks.length,
    };
    publish(next);
    return { linkedContext: next };
  });

  mockUseAddAdrLink.mockReturnValue({
    mutateAsync: addAdr,
    isPending: false,
  } as unknown as ReturnType<typeof useAddAdrLink>);
  mockUseAddDesignModuleLink.mockReturnValue({
    mutateAsync: addDesignModule,
    isPending: false,
  } as unknown as ReturnType<typeof useAddDesignModuleLink>);
  mockUseRemoveAdrLink.mockReturnValue({
    mutateAsync: removeAdr,
    isPending: false,
  } as unknown as ReturnType<typeof useRemoveAdrLink>);
  mockUseRemoveDesignModuleLink.mockReturnValue({
    mutateAsync: removeDesignModule,
    isPending: false,
  } as unknown as ReturnType<typeof useRemoveDesignModuleLink>);
}

function renderPersisted(
  props: Partial<React.ComponentProps<typeof LinkedContextPicker>> = {},
) {
  return render(
    <LinkedContextPicker
      mode="persisted"
      project={PROJECT}
      interviewId={INTERVIEW_ID}
      canManage
      interviewStatus="in_progress"
      {...props}
    />,
  );
}

describe('TBI-003 LinkedContextPicker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    linkedContext = makeLinkedContext();
    candidatesByType = {
      adr: [adrCandidate],
      'design-module': [moduleCandidate],
    };
    candidateTotal = 1;
    linksLoading = false;
    linksError = null;
    candidatesLoading = false;
    candidatesError = null;
    addAdrError = null;
    removeAdrError = null;
    setLinkedContext = undefined;
    installHookMocks();
  });

  it('DoD-0 Given staged and persisted modes, When the same component renders each mode, Then it presents the controlled or server links', () => {
    const stagedSelections: StagedLinkedContextSelection[] = [
      { type: 'adr', id: 'adr-staged', label: 'Staged architecture choice' },
    ];
    const onStagedSelectionsChange = jest.fn();
    const { rerender } = render(
      <LinkedContextPicker
        mode="staged"
        project={PROJECT}
        canManage
        stagedSelections={stagedSelections}
        onStagedSelectionsChange={onStagedSelectionsChange}
      />,
    );

    expect(screen.getByText('Staged architecture choice')).toBeVisible();
    fireEvent.click(screen.getByTestId('linked-context-add-adr-adr-2'));
    expect(onStagedSelectionsChange).toHaveBeenCalledWith([
      ...stagedSelections,
      {
        type: 'adr',
        id: 'adr-2',
        label: 'Use an event stream',
      },
    ]);
    fireEvent.click(
      screen.getByTestId('linked-context-remove-adr-adr-staged'),
    );
    expect(onStagedSelectionsChange).toHaveBeenLastCalledWith([]);

    rerender(
      <LinkedContextPicker
        mode="persisted"
        project={PROJECT}
        interviewId={INTERVIEW_ID}
        canManage
        interviewStatus="in_progress"
      />,
    );

    expect(screen.getByText('Existing ADR')).toBeVisible();
  });

  it('DoD-1 Given loading, empty, error, and read-only states, When each renders, Then state and permission feedback remain observable', () => {
    linksLoading = true;
    const loading = renderPersisted();
    expect(screen.getByTestId('linked-context-loading')).toHaveTextContent(
      /loading linked context/i,
    );
    loading.unmount();

    linksLoading = false;
    linkedContext = makeLinkedContext({
      adrLinks: [],
      designModuleLinks: [],
      count: 0,
    });
    candidatesByType.adr = [];
    candidateTotal = 0;
    const empty = renderPersisted();
    expect(screen.getByTestId('linked-context-empty')).toHaveTextContent(
      /no linked context/i,
    );
    expect(
      screen.getByTestId('linked-context-candidates-empty'),
    ).toHaveTextContent(/no matching/i);
    empty.unmount();

    linksError = new Error('Linked context unavailable');
    const error = renderPersisted();
    expect(screen.getByTestId('linked-context-error')).toHaveTextContent(
      'Linked context unavailable',
    );
    expect(screen.getByTestId('linked-context-retry')).toBeEnabled();
    error.unmount();

    linksError = null;
    linkedContext = makeLinkedContext();
    candidatesByType.adr = [adrCandidate];
    const readOnly = renderPersisted({ canManage: false });
    expect(screen.getByText('Existing ADR')).toBeVisible();
    expect(screen.getByTestId('linked-context-read-only')).toHaveTextContent(
      /read-only/i,
    );
    expect(
      screen.queryByTestId('linked-context-remove-adr-adr-1'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('linked-context-add-adr-adr-2'),
    ).not.toBeInTheDocument();
    readOnly.unmount();
  });

  it('clears the kickoff persistence error when its failed context query is retried', () => {
    linksError = new Error('Linked context unavailable');
    const view = renderPersisted({
      initialErrorText: 'Some linked context could not be saved.',
    });

    expect(screen.getByTestId('linked-context-error')).toHaveTextContent(
      'Some linked context could not be saved.',
    );
    fireEvent.click(screen.getByTestId('linked-context-retry'));

    expect(refetchLinks).toHaveBeenCalled();
    expect(refetchCandidates).toHaveBeenCalled();
    expect(screen.getByTestId('linked-context-error')).not.toHaveTextContent(
      'Some linked context could not be saved.',
    );

    linksError = null;
    view.rerender(
      <LinkedContextPicker
        mode="persisted"
        project={PROJECT}
        interviewId={INTERVIEW_ID}
        canManage
        interviewStatus="in_progress"
        initialErrorText="Some linked context could not be saved."
      />,
    );
    expect(
      screen.queryByTestId('linked-context-error'),
    ).not.toBeInTheDocument();
  });

  it('PBI-003 AC-2 / VT-07 Given exactly 10 staged artifacts, When candidates display, Then all adds are disabled with the exact capacity copy', () => {
    const stagedSelections = Array.from({ length: 10 }, (_, index) => ({
      type: 'adr' as const,
      id: `staged-${index}`,
      label: `Staged ${index}`,
    }));

    render(
      <LinkedContextPicker
        mode="staged"
        project={PROJECT}
        canManage
        stagedSelections={stagedSelections}
        onStagedSelectionsChange={jest.fn()}
      />,
    );

    expect(screen.getByTestId('linked-context-capacity')).toHaveTextContent(
      'Remove a linked item to add another (10 of 10).',
    );
    expect(screen.getByTestId('linked-context-add-adr-adr-2')).toBeDisabled();
  });

  it('PBI-004 AC-2 / VT-03 Given 10 persisted links including a stale ADR, When the picker opens, Then stale stays counted, badged, and adds are disabled', () => {
    linkedContext = makeLinkedContext({
      adrLinks: [
        {
          adrId: 'adr-stale',
          title: 'Retired architecture choice',
          isAccepted: false,
          staleReason: 'no_longer_accepted',
          linkedBy: 'user-1',
          linkedAt: LINKED_AT,
        },
        ...Array.from({ length: 9 }, (_, index) => ({
          adrId: `linked-${index}`,
          title: `ADR ${index}`,
          isAccepted: true,
          linkedBy: 'user-1',
          linkedAt: LINKED_AT,
        })),
      ],
      designModuleLinks: [],
      count: 10,
    });

    renderPersisted();

    const badge = screen.getByTestId(
      'linked-context-stale-badge-adr-stale',
    );
    expect(badge).toHaveTextContent('No longer accepted');
    expect(badge).toHaveAttribute('aria-label', 'No longer accepted');
    expect(screen.getByTestId('linked-context-capacity')).toHaveTextContent(
      'Remove a linked item to add another (10 of 10).',
    );
    expect(screen.getByTestId('linked-context-add-adr-adr-2')).toBeDisabled();
  });

  it('PBI-004 AC-0 / VT-01 Given persisted candidates, When add, remove, and Undo are activated, Then the authoritative set changes and Undo re-adds', async () => {
    renderPersisted();

    fireEvent.click(screen.getByTestId('linked-context-add-adr-adr-2'));
    expect(
      await screen.findByTestId('linked-context-link-adr-adr-2'),
    ).toHaveTextContent('Use an event stream');

    fireEvent.click(screen.getByTestId('linked-context-remove-adr-adr-2'));
    await waitFor(() =>
      expect(
        screen.queryByTestId('linked-context-link-adr-adr-2'),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('linked-context-undo')).toBeVisible();

    fireEvent.click(screen.getByTestId('linked-context-undo'));
    expect(
      await screen.findByTestId('linked-context-link-adr-adr-2'),
    ).toBeVisible();
    expect(addAdr).toHaveBeenLastCalledWith({ adrId: 'adr-2' });
  });

  it('PBI-004 AC-1 / VT-02 Given rejected remove and add mutations, When actions run, Then authoritative links remain and the server errors are politely announced', async () => {
    removeAdrError = new Error('Remove rejected by server');
    addAdrError = new Error('Capacity changed on the server');
    renderPersisted();

    fireEvent.click(screen.getByTestId('linked-context-remove-adr-adr-1'));
    expect(
      await screen.findByTestId('linked-context-link-adr-adr-1'),
    ).toBeVisible();
    expect(screen.getByTestId('linked-context-error')).toHaveTextContent(
      'Remove rejected by server',
    );
    expect(screen.getByTestId('linked-context-error')).toHaveAttribute(
      'aria-live',
      'polite',
    );

    fireEvent.click(screen.getByTestId('linked-context-add-adr-adr-2'));
    await waitFor(() =>
      expect(screen.getByTestId('linked-context-error')).toHaveTextContent(
        'Capacity changed on the server',
      ),
    );
    expect(
      screen.queryByTestId('linked-context-link-adr-adr-2'),
    ).not.toBeInTheDocument();
  });

  it('DoD-3 / VT-09 Given keyboard-only operation, When focus activates Add, Then the control works and success is announced', async () => {
    const user = userEvent.setup();
    renderPersisted();

    const addButton = screen.getByTestId('linked-context-add-adr-adr-2');
    addButton.focus();
    expect(addButton).toHaveFocus();
    await act(async () => {
      await user.keyboard('{Enter}');
    });

    expect(
      await screen.findByTestId('linked-context-link-adr-adr-2'),
    ).toBeVisible();
    expect(screen.getByTestId('linked-context-status')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    expect(screen.getByTestId('linked-context-status')).toHaveTextContent(
      /linked use an event stream/i,
    );
  });

  it('TBI-003 NFR Given more than 50 candidates, When filtering, searching, and paging, Then the query uses type/search and 50-item offsets', () => {
    candidateTotal = 60;
    renderPersisted();

    expect(mockUseLinkCandidates).toHaveBeenLastCalledWith(
      PROJECT,
      INTERVIEW_ID,
      expect.objectContaining({ type: 'adr', offset: 0, limit: 50 }),
    );

    fireEvent.click(screen.getByTestId('linked-context-filter-design-module'));
    expect(mockUseLinkCandidates).toHaveBeenLastCalledWith(
      PROJECT,
      INTERVIEW_ID,
      expect.objectContaining({
        type: 'design-module',
        offset: 0,
        limit: 50,
      }),
    );

    fireEvent.change(screen.getByTestId('linked-context-search'), {
      target: { value: 'orchestration' },
    });
    expect(mockUseLinkCandidates).toHaveBeenLastCalledWith(
      PROJECT,
      INTERVIEW_ID,
      expect.objectContaining({ search: 'orchestration', offset: 0 }),
    );

    fireEvent.click(screen.getByTestId('linked-context-next-page'));
    expect(mockUseLinkCandidates).toHaveBeenLastCalledWith(
      PROJECT,
      INTERVIEW_ID,
      expect.objectContaining({ offset: 50, limit: 50 }),
    );
  });
});
