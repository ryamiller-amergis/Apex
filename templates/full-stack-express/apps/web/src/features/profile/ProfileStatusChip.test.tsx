// @vitest-environment jsdom
import { profileStatusValues } from '@project-scope/contracts';
import { AppThemeProvider } from '@project-scope/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProfileStatusChip, statusLabels } from './ProfileStatusChip';
import { profileTestIds } from './profileTestIds';

describe('ProfileStatusChip', () => {
  it('shows a text label for every contract status', () => {
    for (const status of profileStatusValues) {
      const view = render(
        <AppThemeProvider>
          <ProfileStatusChip status={status} />
        </AppThemeProvider>
      );
      expect(screen.getByTestId(profileTestIds.status)).toHaveTextContent(
        statusLabels[status]
      );
      view.unmount();
    }
  });
});
