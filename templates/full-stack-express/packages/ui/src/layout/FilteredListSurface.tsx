import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';
import { testId } from '../testing/testId.js';

export interface FilteredListFilterOption {
  id: string;
  label: string;
}

export interface FilteredListSurfaceProps {
  id?: string;
  searchLabel?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  filters?: readonly FilteredListFilterOption[];
  activeFilterId?: string;
  onFilterChange?: (filterId: string) => void;
  actions?: ReactNode;
  children: ReactNode;
}

export const FilteredListSurface: React.FC<FilteredListSurfaceProps> = ({
  id = 'list',
  searchLabel = 'Search',
  searchValue = '',
  onSearchChange,
  filters,
  activeFilterId,
  onFilterChange,
  actions,
  children,
}) => (
  <Paper
    variant="outlined"
    data-testid={testId('filtered-list-surface', id)}
    sx={{
      p: 3,
      borderRadius: 2,
      bgcolor: 'background.paper',
    }}
  >
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      sx={{
        alignItems: { xs: 'stretch', sm: 'center' },
        justifyContent: 'space-between',
        mb: 2.5,
      }}
    >
      {filters && filters.length > 0 ? (
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          {filters.map((filter) => {
            const active = filter.id === activeFilterId;
            return (
              <Button
                key={filter.id}
                type="button"
                size="small"
                variant={active ? 'contained' : 'outlined'}
                aria-pressed={active}
                onClick={() => onFilterChange?.(filter.id)}
                data-testid={testId('filtered-list', id, 'filter', filter.id)}
              >
                {filter.label}
              </Button>
            );
          })}
        </Stack>
      ) : (
        <Box />
      )}
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        {onSearchChange ? (
          <TextField
            size="small"
            label={searchLabel}
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            slotProps={{
              htmlInput: {
                'data-testid': testId('filtered-list', id, 'search'),
              },
            }}
          />
        ) : null}
        {actions}
      </Stack>
    </Stack>
    {children}
  </Paper>
);

export interface DetailPanelProps {
  id?: string;
  title: string;
  subtitle?: string;
  onClose?: () => void;
  actions?: ReactNode;
  children: ReactNode;
}

export const DetailPanel: React.FC<DetailPanelProps> = ({
  id = 'detail',
  title,
  subtitle,
  onClose,
  actions,
  children,
}) => (
  <Paper
    variant="outlined"
    data-testid={testId('detail-panel', id)}
    sx={{
      p: 3,
      borderRadius: 2,
      bgcolor: 'background.paper',
    }}
  >
    <Stack
      direction="row"
      spacing={2}
      sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}
    >
      <Box>
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
        {subtitle ? (
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        ) : null}
      </Box>
      <Stack direction="row" spacing={1}>
        {actions}
        {onClose ? (
          <Button
            type="button"
            size="small"
            onClick={onClose}
            data-testid={testId('detail-panel', id, 'close')}
          >
            Close
          </Button>
        ) : null}
      </Stack>
    </Stack>
    {children}
  </Paper>
);

export interface DetailDrawerProps extends DetailPanelProps {
  open: boolean;
}

export const DetailDrawer: React.FC<DetailDrawerProps> = ({
  id = 'drawer',
  open,
  title,
  subtitle,
  onClose,
  actions,
  children,
}) => (
  <Drawer
    anchor="right"
    open={open}
    onClose={onClose}
    slotProps={{
      paper: {
        sx: { width: { xs: '100%', sm: 420 }, p: 3 },
      },
    }}
  >
    <Box data-testid={testId('detail-drawer', id)}>
      <Stack
        direction="row"
        spacing={2}
        sx={{
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          mb: 2,
        }}
      >
        <Box>
          <Typography variant="h6" component="h2">
            {title}
          </Typography>
          {subtitle ? (
            <Typography variant="body2" color="text.secondary">
              {subtitle}
            </Typography>
          ) : null}
        </Box>
        <Stack direction="row" spacing={1}>
          {actions}
          {onClose ? (
            <Button
              type="button"
              size="small"
              onClick={onClose}
              data-testid={testId('detail-drawer', id, 'close')}
            >
              Close
            </Button>
          ) : null}
        </Stack>
      </Stack>
      {children}
    </Box>
  </Drawer>
);
