import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReleaseFormModal } from '../ReleaseFormModal';

global.fetch = jest.fn();

const renderModal = (props: Partial<React.ComponentProps<typeof ReleaseFormModal>> = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSubmit = jest.fn();
  const onClose = jest.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <ReleaseFormModal
        isEditMode={false}
        project="MaxView"
        currentAreaPath="MaxView"
        onSubmit={onSubmit}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onSubmit, onClose };
};

describe('ReleaseFormModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ['MaxView', 'MaxView\\Desktop', 'MaxView\\Mobile', 'MaxView\\Platform'],
    });
  });

  it('uses e.g., v2.4.0 placeholder and populates Area Path picker from project area paths', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderModal();

    expect(screen.getByTestId('release-form-name')).toHaveAttribute('placeholder', 'e.g., v2.4.0');

    const areaSelect = await screen.findByTestId('release-form-area-path');
    expect(areaSelect).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Mobile.*MaxView\\Mobile/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Desktop.*MaxView\\Desktop/i })).toBeInTheDocument();

    await user.selectOptions(areaSelect, 'MaxView\\Mobile');
    await user.type(screen.getByTestId('release-form-name'), 'v2.4.0');
    await user.type(screen.getByTestId('release-form-start-date'), '2026-11-01');
    await user.type(screen.getByTestId('release-form-target-date'), '2026-11-18');
    await user.type(screen.getByTestId('release-form-description'), 'Mobile biometric login');
    await user.click(screen.getByTestId('release-form-save'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 'v2.4.0',
          areaPath: 'MaxView\\Mobile',
          startDate: '2026-11-01',
          targetDate: '2026-11-18',
          description: 'Mobile biometric login',
        }),
        expect.anything(),
      );
    });
  });

  it('defaults the Area Path picker to active sub-path when scoped to Mobile', async () => {
    renderModal({ currentAreaPath: 'MaxView\\Mobile' });

    const areaSelect = await screen.findByTestId('release-form-area-path') as HTMLSelectElement;
    await waitFor(() => {
      expect(areaSelect.value).toBe('MaxView\\Mobile');
    });
  });

  it('shows zod validation errors when required fields are empty', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderModal();

    await user.click(screen.getByTestId('release-form-save'));

    expect(await screen.findByText('Release name is required')).toBeInTheDocument();
    expect(screen.getByText('Start date is required')).toBeInTheDocument();
    expect(screen.getByText('Target date is required')).toBeInTheDocument();
    expect(screen.getByText('Description is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
