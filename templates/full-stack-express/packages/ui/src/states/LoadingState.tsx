import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';

export interface LoadingStateProps {
  /** Visible text, announced politely. Defaults to "Loading". */
  label?: string;
  /** `page` centres the state in the content area; `inline` sits in a row. */
  variant?: 'page' | 'inline';
}

/**
 * Tells the person that content is loading. Use it in place of a blank area,
 * for example while a TanStack Query is `isPending`.
 *
 * @example
 * if (query.isPending) return <LoadingState label="Loading profile" />;
 */
export const LoadingState: React.FC<LoadingStateProps> = ({
  label = 'Loading',
  variant = 'page',
}) => {
  const isPage = variant === 'page';
  return (
    <Box
      role="status"
      data-testid="loading-state"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        ...(isPage && { justifyContent: 'center', py: 4 }),
      }}
    >
      <CircularProgress size={isPage ? 32 : 20} aria-hidden />
      <Typography variant="body1" component="span">
        {label}
      </Typography>
    </Box>
  );
};
