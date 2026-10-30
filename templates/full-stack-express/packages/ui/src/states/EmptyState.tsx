import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: EmptyStateAction;
}

/**
 * Tells the person that no content exists, with an optional action. Use it in
 * place of a blank area when a request succeeds with nothing to show.
 *
 * @example
 * <EmptyState
 *   title="No items yet"
 *   action={{ label: 'Add item', onClick: openForm }}
 * />
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  action,
}) => (
  <Box
    role="status"
    data-testid="empty-state"
    sx={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 1,
      py: 3,
    }}
  >
    <Typography variant="h6" component="p">
      {title}
    </Typography>
    {description && (
      <Typography variant="body1" color="text.secondary">
        {description}
      </Typography>
    )}
    {action && (
      <Button
        variant="contained"
        onClick={action.onClick}
        data-testid="empty-state-action"
        sx={{ mt: 1 }}
      >
        {action.label}
      </Button>
    )}
  </Box>
);
