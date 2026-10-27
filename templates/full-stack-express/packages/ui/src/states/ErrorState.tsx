import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';

export interface ErrorStateProps {
  title?: string;
  /**
   * Safe, fixed text for the person. Never pass an `Error` message, a stack
   * trace, or a Problem Details `detail` field; they can hold identity values.
   */
  message?: string;
  /** Renders a retry button when set. */
  onRetry?: () => void;
  retryLabel?: string;
}

/**
 * Shows a safe error message and an optional retry action, announced as an
 * alert. Use it for failed requests, for example when a query `isError`.
 *
 * @example
 * <ErrorState
 *   message="We could not load your profile."
 *   onRetry={() => query.refetch()}
 * />
 */
export const ErrorState: React.FC<ErrorStateProps> = ({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
}) => (
  <Box
    role="alert"
    data-testid="error-state"
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
    {message && <Typography variant="body1">{message}</Typography>}
    {onRetry && (
      <Button
        variant="contained"
        onClick={onRetry}
        data-testid="error-state-retry"
        sx={{ mt: 1 }}
      >
        {retryLabel}
      </Button>
    )}
  </Box>
);
