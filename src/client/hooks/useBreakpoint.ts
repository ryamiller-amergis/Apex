import { useState, useEffect } from 'react';

interface Breakpoints {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
}

const MOBILE_QUERY = '(max-width: 768px)';
const TABLET_QUERY = '(min-width: 769px) and (max-width: 1024px)';

export function useBreakpoint(): Breakpoints {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });

  const [isTablet, setIsTablet] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(TABLET_QUERY).matches;
  });

  useEffect(() => {
    const mobileMql = window.matchMedia(MOBILE_QUERY);
    const tabletMql = window.matchMedia(TABLET_QUERY);

    const handleMobile = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    const handleTablet = (e: MediaQueryListEvent) => setIsTablet(e.matches);

    mobileMql.addEventListener('change', handleMobile);
    tabletMql.addEventListener('change', handleTablet);

    return () => {
      mobileMql.removeEventListener('change', handleMobile);
      tabletMql.removeEventListener('change', handleTablet);
    };
  }, []);

  return { isMobile, isTablet, isDesktop: !isMobile && !isTablet };
}
