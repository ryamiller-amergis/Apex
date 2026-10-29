import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import { useTheme } from '@mui/material/styles';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ColorModeToggle } from './ColorModeToggle.js';
import { MenuIcon } from './icons.js';
import { DRAWER_ID, NavDrawer, type NavItem } from './NavDrawer.js';
import { SkipLink } from './SkipLink.js';

export type { NavItem };

const MAIN_ID = 'main-content';

export interface AppShellProps {
  /** Shown in the header. */
  appName: string;
  /** Primary navigation. An empty list renders no navigation and no menu button. */
  navItems: NavItem[];
  /** Header slot for host content, placed before the colour mode switch. */
  headerActions?: ReactNode;
  children: ReactNode;
}

function assertUniqueIds(items: NavItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`AppShell: duplicate nav item id "${item.id}"`);
    }
    seen.add(item.id);
  }
}

/**
 * Responsive application frame: skip link, header with the colour mode
 * switch, primary navigation, and the `main` landmark. Below the `md`
 * breakpoint the navigation is a temporary drawer opened by a menu button;
 * from `md` up it is a permanent drawer beside the content.
 *
 * @example
 * <AppShell appName={webEnv.VITE_APP_NAME} navItems={[
 *   { id: 'profile', label: 'Profile', to: '/profile/details/edit' },
 * ]}>
 *   <AppErrorBoundary resetKeys={[location.pathname]}>
 *     <Routes>…</Routes>
 *   </AppErrorBoundary>
 * </AppShell>
 */
export const AppShell: React.FC<AppShellProps> = ({
  appName,
  navItems,
  headerActions,
  children,
}) => {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'), { noSsr: true });
  const isTablet = useMediaQuery(theme.breakpoints.up('sm'), { noSsr: true });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  assertUniqueIds(navItems);

  if (isDesktop && drawerOpen) {
    setDrawerOpen(false);
  }

  useEffect(() => {
    if (wasOpenRef.current && !drawerOpen) {
      menuButtonRef.current?.focus();
    }
    wasOpenRef.current = drawerOpen;
  }, [drawerOpen]);

  const hasNav = navItems.length > 0;
  const layout = isDesktop ? 'desktop' : isTablet ? 'tablet' : 'phone';
  const padding = isDesktop ? 4 : isTablet ? 3 : 2;

  return (
    <Box
      data-testid="app-shell"
      data-layout={layout}
      sx={{
        display: 'flex',
        minHeight: '100vh',
        bgcolor: 'background.default',
      }}
    >
      <SkipLink targetId={MAIN_ID} />
      {hasNav && (
        <NavDrawer
          items={navItems}
          variant={isDesktop ? 'permanent' : 'temporary'}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        />
      )}
      <Box
        sx={{
          flexGrow: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <AppBar
          component="header"
          position="static"
          color="inherit"
          elevation={0}
          data-testid="app-shell-header"
          sx={{
            bgcolor: 'background.paper',
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Toolbar sx={{ gap: 1 }}>
            {hasNav && !isDesktop && (
              <IconButton
                ref={menuButtonRef}
                edge="start"
                aria-label="Open navigation"
                aria-expanded={drawerOpen}
                aria-controls={DRAWER_ID}
                onClick={() => setDrawerOpen(true)}
                data-testid="app-shell-menu-button"
              >
                <MenuIcon />
              </IconButton>
            )}
            <Typography
              variant="h6"
              component="p"
              noWrap
              sx={{ flexGrow: 1, minWidth: 0 }}
            >
              {appName}
            </Typography>
            {headerActions}
            <ColorModeToggle />
          </Toolbar>
        </AppBar>
        <Box
          component="main"
          id={MAIN_ID}
          tabIndex={-1}
          data-testid="app-shell-main"
          sx={{
            flexGrow: 1,
            width: '100%',
            minWidth: 0,
            maxWidth: isDesktop ? theme.breakpoints.values.lg : 'none',
            px: padding,
            py: padding,
            overflowWrap: 'anywhere',
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
};
