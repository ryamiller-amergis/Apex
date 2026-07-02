import React from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { MobileGuidanceMessage } from './MobileGuidanceMessage';

interface DesktopOnlyGateProps {
  children: React.ReactNode;
}

export const DesktopOnlyGate: React.FC<DesktopOnlyGateProps> = ({ children }) => {
  const { isDesktop } = useBreakpoint();

  if (!isDesktop) {
    return <MobileGuidanceMessage />;
  }

  return <div data-testid="pdf-tools-desktop-gate">{children}</div>;
};
