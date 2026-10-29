import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router';
import { testId } from '../testing/testId.js';
import { CloseIcon } from './icons.js';

/** One navigation destination. `id` must be unique and stable. */
export interface NavItem {
  id: string;
  label: string;
  to: string;
}

export const DRAWER_ID = 'app-shell-drawer';
export const DRAWER_WIDTH = 240;

interface NavListProps {
  items: NavItem[];
  onNavigate?: () => void;
  focusFirstOnMount?: boolean;
}

const NavList: React.FC<NavListProps> = ({
  items,
  onNavigate,
  focusFirstOnMount = false,
}) => {
  const firstItemRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (focusFirstOnMount) {
      firstItemRef.current?.focus();
    }
  }, [focusFirstOnMount]);

  return (
    <List data-testid="app-shell-nav">
      {items.map((item, index) => (
        <ListItem key={item.id} disablePadding>
          <ListItemButton
            component={NavLink}
            to={item.to}
            end={item.to === '/'}
            onClick={onNavigate}
            ref={index === 0 ? firstItemRef : undefined}
            data-testid={testId('app-shell', 'nav-item', item.id)}
            sx={{
              '&[aria-current="page"]': {
                bgcolor: 'action.selected',
                fontWeight: 'fontWeightBold',
                boxShadow: (theme) =>
                  `inset 4px 0 0 ${theme.vars.palette.primary.main}`,
              },
            }}
          >
            <ListItemText
              primary={item.label}
              slotProps={{ primary: { sx: { fontWeight: 'inherit' } } }}
            />
          </ListItemButton>
        </ListItem>
      ))}
    </List>
  );
};

export interface NavDrawerProps {
  items: NavItem[];
  /** `permanent` sits beside the content; `temporary` is a modal drawer. */
  variant: 'permanent' | 'temporary';
  open?: boolean;
  onClose?: () => void;
}

/**
 * Primary navigation. The temporary drawer traps focus, closes on Escape,
 * and unmounts when closed so hidden links leave the tab order.
 */
export const NavDrawer: React.FC<NavDrawerProps> = ({
  items,
  variant,
  open = false,
  onClose,
}) => {
  if (variant === 'permanent') {
    return (
      <Box
        component="nav"
        aria-label="Primary"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          alignSelf: 'flex-start',
          position: 'sticky',
          top: 0,
          height: '100vh',
          overflowY: 'auto',
          borderRight: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <NavList items={items} />
      </Box>
    );
  }

  return (
    <Drawer
      variant="temporary"
      open={open}
      onClose={onClose}
      disableAutoFocus
      disableRestoreFocus
      slotProps={{ paper: { id: DRAWER_ID, sx: { width: DRAWER_WIDTH } } }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 1 }}>
        <IconButton
          aria-label="Close navigation"
          onClick={onClose}
          data-testid="app-shell-close-button"
        >
          <CloseIcon />
        </IconButton>
      </Box>
      <Box component="nav" aria-label="Primary">
        <NavList items={items} onNavigate={onClose} focusFirstOnMount />
      </Box>
    </Drawer>
  );
};
