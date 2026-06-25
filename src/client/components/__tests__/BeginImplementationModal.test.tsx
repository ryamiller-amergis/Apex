import { render, screen, fireEvent } from '@testing-library/react';
import BeginImplementationModal from '../BeginImplementationModal';

jest.mock('../../utils/cursorDeeplink', () => ({
  buildApexImplementPrompt: (id: number) => `/apex-implement-feature ${id}`,
  buildCursorPromptDeeplink: (text: string) => ({
    desktop: `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(text)}`,
    web: `https://cursor.com/link/prompt?text=${encodeURIComponent(text)}`,
  }),
  getMaxViewRepoUrl: () => 'https://dev.azure.com/amergis/_git/MaxView',
}));

// jsdom doesn't support window.location navigation; suppress the not-implemented error.
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
beforeAll(() => {
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, href: '' },
  });
});
afterAll(() => {
  if (originalLocationDescriptor) {
    Object.defineProperty(window, 'location', originalLocationDescriptor);
  }
});

describe('BeginImplementationModal', () => {
  const onClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('when featureAdoId is provided', () => {
    it('renders the feature title and ADO badge', () => {
      render(
        <BeginImplementationModal
          featureTitle="Shift Scheduler Widget"
          featureAdoId={42}
          onClose={onClose}
        />,
      );

      expect(screen.getByText('Shift Scheduler Widget')).toBeInTheDocument();
      expect(screen.getByText('ADO Feature #42')).toBeInTheDocument();
    });

    it('shows the correct prompt text', () => {
      render(
        <BeginImplementationModal
          featureTitle="Shift Scheduler Widget"
          featureAdoId={42}
          onClose={onClose}
        />,
      );

      expect(screen.getByText('/apex-implement-feature 42')).toBeInTheDocument();
    });

    it('renders the Open in Cursor button', () => {
      render(
        <BeginImplementationModal
          featureTitle="Shift Scheduler Widget"
          featureAdoId={42}
          onClose={onClose}
        />,
      );

      expect(screen.getByRole('button', { name: /open in cursor/i })).toBeInTheDocument();
    });

    it('calls onClose when Cancel is clicked', () => {
      render(
        <BeginImplementationModal
          featureTitle="Shift Scheduler Widget"
          featureAdoId={42}
          onClose={onClose}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when the X button is clicked', () => {
      render(
        <BeginImplementationModal
          featureTitle="Shift Scheduler Widget"
          featureAdoId={42}
          onClose={onClose}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows the web fallback note after Open in Cursor is clicked', () => {
      render(
        <BeginImplementationModal
          featureTitle="Shift Scheduler Widget"
          featureAdoId={42}
          onClose={onClose}
        />,
      );

      expect(screen.queryByText(/cursor didn't open/i)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /open in cursor/i }));
      expect(screen.getByText(/cursor didn't open/i)).toBeInTheDocument();
    });
  });

  describe('when featureAdoId is undefined (ADO items not yet created)', () => {
    it('shows the guard message instead of the prompt', () => {
      render(
        <BeginImplementationModal
          featureTitle="Shift Scheduler Widget"
          featureAdoId={undefined}
          onClose={onClose}
        />,
      );

      expect(screen.getByText(/create ado items/i)).toBeInTheDocument();
      expect(screen.queryByText(/apex-implement-feature/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /open in cursor/i })).not.toBeInTheDocument();
    });

    it('shows a Close (not Cancel) button in the footer when no ADO id', () => {
      render(
        <BeginImplementationModal
          featureTitle="Shift Scheduler Widget"
          featureAdoId={undefined}
          onClose={onClose}
        />,
      );

      // The footer cancel button renders as "Close" when there is no ADO id.
      // Use getByText to match the footer button specifically (the X close button has aria-label).
      expect(screen.getByText('Close')).toBeInTheDocument();
    });
  });
});
