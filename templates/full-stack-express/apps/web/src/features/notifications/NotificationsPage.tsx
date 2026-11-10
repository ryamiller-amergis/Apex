import {
  ContentSurface,
  NotificationCenter,
  PageHeader,
  testId,
  type NotificationCategory,
} from '@project-scope/ui';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  getNotifications,
  postNotification,
  putNotificationsRead,
} from '../../api/apiClient';
import { useDocumentTitle } from '../profile/useDocumentTitle';

export const notificationsKeys = {
  all: ['notifications', 'list'] as const,
};

export const notificationsTestIds = {
  page: testId('notifications', 'page'),
  triggerForm: testId('notifications', 'trigger-form'),
  titleInput: testId('notifications', 'title-input'),
  messageInput: testId('notifications', 'message-input'),
  categorySelect: testId('notifications', 'category-select'),
  triggerButton: testId('notifications', 'trigger-button'),
} as const;

export function useNotificationsQuery() {
  return useQuery({
    queryKey: notificationsKeys.all,
    queryFn: () => getNotifications(),
    retry: false,
  });
}

export const NotificationsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [selectedFilter, setSelectedFilter] = useState('all');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [category] = useState<NotificationCategory>('workflow');

  useDocumentTitle('Notifications');

  const query = useNotificationsQuery();

  const createMutation = useMutation({
    mutationFn: postNotification,
    onSuccess: (updated) => {
      queryClient.setQueryData(notificationsKeys.all, updated);
      setTitle('');
      setMessage('');
    },
  });

  const markReadMutation = useMutation({
    mutationFn: putNotificationsRead,
    onSuccess: (updated) => {
      queryClient.setQueryData(notificationsKeys.all, updated);
    },
  });

  const allItems = query.data?.items ?? [];
  const unreadCount = query.data?.unreadCount ?? 0;

  const filteredItems = allItems.filter((item) => {
    if (selectedFilter === 'all') return true;
    if (selectedFilter === 'unread') return !item.read;
    return item.category === selectedFilter;
  });

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const cleanTitle = title.trim() || 'Afternoon carrier dispatch check';
    const cleanMessage =
      message.trim() ||
      'Midwest lane ORD-2 dock check triggered for priority review.';
    createMutation.mutate({
      title: cleanTitle,
      message: cleanMessage,
      category,
    });
  };

  return (
    <Stack spacing={3} data-testid={notificationsTestIds.page}>
      <PageHeader
        title="Notifications"
        subtitle="Operational alerts, AI forecast updates, and connector checkpoints"
        testId="notifications-page-header"
      />

      <ContentSurface testId={notificationsTestIds.triggerForm}>
        <Box
          component="form"
          onSubmit={handleCreate}
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 2,
            alignItems: { xs: 'stretch', sm: 'center' },
          }}
        >
          <TextField
            size="small"
            label="Notification title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            fullWidth
            slotProps={{
              htmlInput: { 'data-testid': notificationsTestIds.titleInput },
            }}
          />
          <TextField
            size="small"
            label="Details"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            fullWidth
            slotProps={{
              htmlInput: { 'data-testid': notificationsTestIds.messageInput },
            }}
          />
          <Button
            type="submit"
            variant="contained"
            disabled={createMutation.isPending}
            data-testid={notificationsTestIds.triggerButton}
            sx={{ flexShrink: 0 }}
          >
            {createMutation.isPending ? 'Sending…' : 'Trigger notification'}
          </Button>
        </Box>
      </ContentSurface>

      <NotificationCenter
        items={filteredItems}
        unreadCount={unreadCount}
        selectedFilter={selectedFilter}
        onFilterChange={setSelectedFilter}
        onMarkRead={(notificationId) =>
          markReadMutation.mutate({ notificationId })
        }
        onMarkAllRead={() => markReadMutation.mutate({ markAll: true })}
        isLoading={query.isPending}
        isError={query.isError}
        onRetry={() => {
          void query.refetch();
        }}
      />
    </Stack>
  );
};
