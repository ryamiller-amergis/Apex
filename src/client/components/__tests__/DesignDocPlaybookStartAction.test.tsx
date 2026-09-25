import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DesignDocPlaybookStartAction } from '../DesignDocPlaybookStartAction';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useStartDesignDocValidationPlaybook } from '../../hooks/useDesignDocValidationPlaybook';

jest.mock('../../hooks/useFeatureFlags', () => ({ useFeatureFlag: jest.fn() }));
jest.mock('../../hooks/useDesignDocValidationPlaybook', () => ({
  useStartDesignDocValidationPlaybook: jest.fn(),
}));

const mockFlag = useFeatureFlag as jest.MockedFunction<typeof useFeatureFlag>;
const mockStart = useStartDesignDocValidationPlaybook as jest.MockedFunction<
  typeof useStartDesignDocValidationPlaybook
>;

describe('DesignDocPlaybookStartAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlag.mockReturnValue(true);
    mockStart.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
      isError: false,
      error: null,
      data: undefined,
    } as unknown as ReturnType<typeof useStartDesignDocValidationPlaybook>);
  });

  it('renders the owner start control when the flag is on', () => {
    render(
      <MemoryRouter>
        <DesignDocPlaybookStartAction
          designDocId="doc-1"
          project="Apex"
          isOwner
          canRun
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('dd-playbook-start-btn')).toBeInTheDocument();
  });

  it('hides the control from a non-owner', () => {
    render(
      <MemoryRouter>
        <DesignDocPlaybookStartAction
          designDocId="doc-1"
          project="Apex"
          isOwner={false}
          canRun
        />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('dd-playbook-start-btn')).not.toBeInTheDocument();
  });
});
