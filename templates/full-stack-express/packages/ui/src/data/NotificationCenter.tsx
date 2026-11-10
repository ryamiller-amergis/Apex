import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { EmptyState } from '../states/EmptyState.js';
import { ErrorState } from '../states/ErrorState.js';
import { LoadingState } from '../states/LoadingState.js';
import { testId } from '../testing/testId.js';

export type NotificationCategory = 'system' | 'workflow' | 'insight' | 'alert';

export interface NotificationItemData {
  id: string;
  title: string;
  message: string;
  category: NotificationCategory;
  read: boolean;
  createdAt: string;
}

export interface NotificationListProps {
  items: readonly NotificationItemData[];
  onMarkRead?: (id: string) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}

export const NotificationList: React.FC<NotificationListProps> = ({
  items,
  onMarkRead,
  emptyTitle = 'No notifications match this filter',
  emptyDescription = 'New operational updates and workflow alerts will appear here.',
}) => {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <Stack spacing={1.5} data-testid="notification-list">
      {items.map((item) => (
        <Paper
          key={item.id}
          variant="outlined"
          data-testid={testId('notification-item', item.id)}
          sx={{
            p: 2,
            borderRadius: 2,
            bgcolor: item.read ? 'background.default' : 'background.paper',
            borderColor: item.read ? 'divider' : 'primary.main',
          }}
        >
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{
              alignItems: { xs: 'flex-start', sm: 'center' },
              justifyContent: 'space-between',
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Stack
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap' }}
              >
                <Typography
                  variant="subtitle1"
                  component="h3"
                  sx={{
                    fontWeight: item.read
                      ? 'fontWeightRegular'
                      : 'fontWeightBold',
                  }}
                >
                  {item.title}
                </Typography>
                <Chip
                  size="small"
                  label={item.category}
                  color={item.read ? 'default' : 'primary'}
                  data-testid={testId('notification-category', item.id)}
                />
                {!item.read ? (
                  <Chip
                    size="small"
                    color="info"
                    label="Unread"
                    data-testid={testId('notification-unread', item.id)}
                  />
                ) : null}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {item.message}
              </Typography>
            </Box>
            {!item.read && onMarkRead ? (
              <Button
                type="button"
                size="small"
                variant="outlined"
                onClick={() => onMarkRead(item.id)}
                data-testid={testId('notification-mark-read', item.id)}
              >
                Mark read
              </Button>
            ) : null}
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
};

export interface NotificationCenterProps {
  items: readonly NotificationItemData[];
  unreadCount: number;
  selectedFilter: string;
  onFilterChange: (filter: string) => void;
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}

const FILTER_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'insight', label: 'Insight' },
  { id: 'alert', label: 'Alert' },
  { id: 'system', label: 'System' },
] as const;

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  items,
  unreadCount,
  selectedFilter,
  onFilterChange,
  onMarkRead,
  onMarkAllRead,
  isLoading = false,
  isError = false,
  onRetry,
}) => {
  if (isLoading) {
    return (
      <LoadingState
        testId="notification-center-loading"
        label="Loading notifications…"
      />
    );
  }

  if (isError) {
    return (
      <ErrorState
        testId="notification-center-error"
        retryTestId="notification-center-retry"
        title="We couldn't load notifications"
        onRetry={onRetry}
      />
    );
  }

  return (
    <Stack spacing={2} data-testid="notification-center">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
        }}
      >
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          {FILTER_OPTIONS.map((option) => {
            const active = selectedFilter === option.id;
            return (
              <Button
                key={option.id}
                type="button"
                size="small"
                variant={active ? 'contained' : 'outlined'}
                aria-pressed={active}
                onClick={() => onFilterChange(option.id)}
                data-testid={testId('notification-filter', option.id)}
              >
                {option.label}
              </Button>
            );
          })}
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Chip
            label={`${unreadCount} unread`}
            color={unreadCount > 0 ? 'primary' : 'default'}
            data-testid="notification-unread-badge"
          />
          {unreadCount > 0 && onMarkAllRead ? (
            <Button
              type="button"
              size="small"
              variant="text"
              onClick={onMarkAllRead}
              data-testid="notification-mark-all-read"
            >
              Mark all read
            </Button>
          ) : null}
        </Stack>
      </Stack>
      <NotificationList items={items} onMarkRead={onMarkRead} />
    </Stack>
  );
};
