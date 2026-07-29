/**
 * PBI-003 / PBI-004 AvatarEditor component tests.
 * Criterion / verification-test ids in names for Requirements → Test Matrix traceability.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AvatarEditor } from '../AvatarEditor';
import type { AvatarDescriptor, AvatarMutationResponse } from '../../../shared/types/profile';

const mockUploadMutate = jest.fn();
const mockDeleteMutate = jest.fn();

let uploadState: { isPending: boolean; isError: boolean; error: Error | null };
let deleteState: { isPending: boolean; isError: boolean; error: Error | null };

jest.mock('../../hooks/useAvatar', () => {
  const actual = jest.requireActual('../../hooks/useAvatar');
  return {
    ...actual,
    useUploadAvatar: () => ({ mutate: mockUploadMutate, ...uploadState }),
    useDeleteAvatar: () => ({ mutate: mockDeleteMutate, ...deleteState }),
  };
});

const uploadedAvatar: AvatarDescriptor = {
  source: 'uploaded',
  url: '/api/profile/avatar/oid-a?v=1',
  cacheVersion: '1',
  initials: null,
};

const graphAvatar: AvatarDescriptor = {
  source: 'graph',
  url: '/api/profile/avatar/oid-a?v=0',
  cacheVersion: '0',
  initials: null,
};

const initialsAvatar: AvatarDescriptor = {
  source: 'initials',
  url: null,
  cacheVersion: '0',
  initials: 'AL',
};

function renderEditor(avatar: AvatarDescriptor) {
  return render(<AvatarEditor userOid="oid-a" displayName="Ada Lovelace" avatar={avatar} />);
}

beforeEach(() => {
  jest.clearAllMocks();
  uploadState = { isPending: false, isError: false, error: null };
  deleteState = { isPending: false, isError: false, error: null };
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 401,
    json: () => Promise.resolve({}),
  }) as jest.Mock;
  // jsdom does not implement object URLs; the crop dialog/preview use them
  // to render a local file/blob without a network round trip.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: jest.fn().mockReturnValue('blob:mock'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: jest.fn(),
  });
});

describe('AvatarEditor — PBI-004 AC-2 / VT-07', () => {
  it('hides Remove and offers Upload when the source is graph', async () => {
    renderEditor(graphAvatar);
    expect(screen.queryByTestId('avatar-remove-open')).not.toBeInTheDocument();
    expect(screen.getByText('Upload avatar')).toBeInTheDocument();
    // Let AvatarPreview's authenticated fetch settle before the test exits.
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });

  it('hides Remove and offers Upload when the source is initials', () => {
    renderEditor(initialsAvatar);
    expect(screen.queryByTestId('avatar-remove-open')).not.toBeInTheDocument();
    expect(screen.getByText('Upload avatar')).toBeInTheDocument();
  });

  it('shows Edit, Change photo, and Remove when the source is uploaded', async () => {
    renderEditor(uploadedAvatar);
    expect(screen.getByTestId('avatar-remove-open')).toBeInTheDocument();
    expect(screen.getByTestId('avatar-edit-open')).toBeInTheDocument();
    expect(screen.getByText('Change photo')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });
});

describe('AvatarEditor — edit current avatar', () => {
  it('Edit fetches the current avatar and opens the crop dialog', async () => {
    const blob = new Blob(['img'], { type: 'image/webp' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(blob),
    }) as jest.Mock;

    renderEditor(uploadedAvatar);
    fireEvent.click(screen.getByTestId('avatar-edit-open'));

    expect(await screen.findByTestId('avatar-crop-dialog')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/profile/avatar/oid-a?v=1',
      expect.objectContaining({ credentials: 'include' })
    );
  });
});

describe('AvatarEditor — PBI-003 AC-0', () => {
  it('opens the crop dialog on file select; confirming calls the upload mutation', async () => {
    renderEditor(initialsAvatar);
    const file = new File(['abc'], 'avatar.png', { type: 'image/png' });

    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [file] } });

    expect(await screen.findByTestId('avatar-crop-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('avatar-upload-submit'));

    await waitFor(() => expect(mockUploadMutate).toHaveBeenCalledTimes(1));
    const [input] = mockUploadMutate.mock.calls[0];
    expect(input.file).toBe(file);
    expect(input.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe('AvatarEditor — PBI-003 AC-1', () => {
  it('shows an alert and keeps the prior preview when upload fails', async () => {
    mockUploadMutate.mockImplementation((_input, opts) => {
      opts?.onError?.(new Error('Failed to store avatar'));
    });
    renderEditor(initialsAvatar);
    const file = new File(['abc'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [file] } });
    fireEvent.click(await screen.findByTestId('avatar-upload-submit'));

    const status = await screen.findByTestId('avatar-operation-status');
    await waitFor(() => expect(status).toHaveTextContent('Failed to store avatar'));
    expect(status).toHaveAttribute('role', 'alert');
    // Prior preview (initials fallback) remains — no uploaded avatar was swapped in.
    expect(screen.getByTestId('avatar-preview-initials')).toHaveTextContent('AL');
  });
});

describe('AvatarEditor — PBI-004 AC-0', () => {
  it('confirming Remove calls the delete mutation and closes the dialog on success', async () => {
    mockDeleteMutate.mockImplementation((_input, opts) => {
      opts?.onSuccess?.({ avatar: initialsAvatar, cacheVersion: '0' } satisfies AvatarMutationResponse);
    });
    renderEditor(uploadedAvatar);

    fireEvent.click(screen.getByTestId('avatar-remove-open'));
    expect(screen.getByTestId('avatar-remove-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('avatar-remove-confirm'));

    await waitFor(() => expect(mockDeleteMutate).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('avatar-remove-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('avatar-remove-open')).not.toBeInTheDocument();
    // Default look/feel: initials circle + Upload (not Replace).
    expect(screen.getByTestId('avatar-preview-initials')).toHaveTextContent('AL');
    expect(screen.getByText('Upload avatar')).toBeInTheDocument();
  });
});

describe('AvatarEditor — PBI-004 AC-1', () => {
  it('keeps the dialog open and shows an alert when delete fails', async () => {
    mockDeleteMutate.mockImplementation((_input, opts) => {
      opts?.onError?.(new Error('Failed to delete avatar'));
    });
    renderEditor(uploadedAvatar);

    fireEvent.click(screen.getByTestId('avatar-remove-open'));
    fireEvent.click(screen.getByTestId('avatar-remove-confirm'));

    const status = await screen.findByTestId('avatar-operation-status');
    await waitFor(() => expect(status).toHaveTextContent('Failed to delete avatar'));
    expect(status).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('avatar-remove-dialog')).toBeInTheDocument();
  });
});
