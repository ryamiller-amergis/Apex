import { render, screen, fireEvent } from '@testing-library/react';
import { WorkflowEvaluationModelSettings } from '../WorkflowEvaluationModelSettings';

const mockUseSettings = jest.fn();
const mockMutate = jest.fn();
jest.mock('../../hooks/useWorkflowEvaluationsAdmin', () => ({
  useEvaluationModelSettings: (...args: unknown[]) => mockUseSettings(...args),
  useUpdateEvaluationModelSettings: () => ({ mutate: mockMutate, isPending: false, isError: false, error: null }),
}));
jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAvailableModels: () => ({
    data: [
      { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
    ],
    isLoading: false,
  }),
}));

function settings(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      hasSkillConfig: true,
      model: null,
      effort: null,
      effective: { model: 'composer-2.5', effort: null, source: 'app_default' },
      ...overrides,
    },
    isLoading: false,
    isError: false,
    error: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('WorkflowEvaluationModelSettings', () => {
  it('shows which model the judges use and where it comes from', () => {
    mockUseSettings.mockReturnValue(settings());
    render(<WorkflowEvaluationModelSettings project="proj-a" />);
    expect(screen.getByTestId('workflow-evaluation-model-effective')).toHaveTextContent(
      'Judges now use Composer 2.5 (app default model).',
    );
    expect(screen.getByTestId('workflow-evaluation-model-save')).toBeDisabled();
  });

  it('saves the chosen model and effort', () => {
    mockUseSettings.mockReturnValue(settings());
    render(<WorkflowEvaluationModelSettings project="proj-a" />);
    fireEvent.change(screen.getByTestId('workflow-evaluation-model-select'), { target: { value: 'claude-sonnet' } });
    fireEvent.change(screen.getByTestId('workflow-evaluation-effort-select'), { target: { value: 'high' } });
    fireEvent.click(screen.getByTestId('workflow-evaluation-model-save'));
    expect(mockMutate).toHaveBeenCalledWith({ model: 'claude-sonnet', effort: 'high' }, expect.anything());
  });

  it('clears the setting back to the PRD Validation model', () => {
    mockUseSettings.mockReturnValue(settings({
      model: 'claude-sonnet',
      effective: { model: 'claude-sonnet', effort: null, source: 'evaluation' },
    }));
    render(<WorkflowEvaluationModelSettings project="proj-a" />);
    fireEvent.change(screen.getByTestId('workflow-evaluation-model-select'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('workflow-evaluation-model-save'));
    expect(mockMutate).toHaveBeenCalledWith({ model: null, effort: null }, expect.anything());
  });

  it('disables the controls when the project has no default skill configuration', () => {
    mockUseSettings.mockReturnValue(settings({ hasSkillConfig: false, effective: null }));
    render(<WorkflowEvaluationModelSettings project="proj-a" />);
    expect(screen.getByTestId('workflow-evaluation-model-no-config')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-evaluation-model-select')).toBeDisabled();
    expect(screen.getByTestId('workflow-evaluation-effort-select')).toBeDisabled();
  });
});
