import React from 'react';
import {
  DESIGN_MODULE_ICON_KEYS,
  type DesignModuleIconKey,
} from '../../shared/types/designModule';

interface IconProps {
  size?: number;
}

const IconFrame: React.FC<React.PropsWithChildren<IconProps>> = ({
  size = 20,
  children,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const ChatIcon: React.FC<IconProps> = (props) => (
  <IconFrame {...props}>
    <path d="M3 4h14v10H8l-4 3v-3H3zM6 8h8M6 11h5" />
  </IconFrame>
);
const InterviewIcon: React.FC<IconProps> = (props) => (
  <IconFrame {...props}>
    <circle cx="7" cy="7" r="2.5" />
    <circle cx="14" cy="8" r="2" />
    <path d="M3 17c0-3 1.5-5 4-5s4 2 4 5M11 17c.2-2.2 1.2-3.5 3-3.5 2 0 3 1.4 3 3.5" />
  </IconFrame>
);
const PdfIcon: React.FC<IconProps> = (props) => (
  <IconFrame {...props}>
    <path d="M5 2h7l3 3v13H5zM12 2v4h3M7 10h6M7 13h6" />
  </IconFrame>
);
const AnalysisIcon: React.FC<IconProps> = (props) => (
  <IconFrame {...props}>
    <path d="M3 17h14M5 15V9h3v6M9 15V5h3v10M13 15v-3h3v3" />
  </IconFrame>
);
const InfraIcon: React.FC<IconProps> = (props) => (
  <IconFrame {...props}>
    <rect x="3" y="3" width="14" height="5" rx="1" />
    <rect x="3" y="12" width="14" height="5" rx="1" />
    <path d="M6 5.5h.01M6 14.5h.01M9 5.5h5M9 14.5h5" />
  </IconFrame>
);
const CicdIcon: React.FC<IconProps> = (props) => (
  <IconFrame {...props}>
    <circle cx="5" cy="5" r="2" />
    <circle cx="15" cy="15" r="2" />
    <path d="M7 5h3a3 3 0 013 3v5M10 15H7a3 3 0 01-3-3V7" />
  </IconFrame>
);
const RbacIcon: React.FC<IconProps> = (props) => (
  <IconFrame {...props}>
    <path d="M10 2l6 2v5c0 4-2.4 7-6 9-3.6-2-6-5-6-9V4z" />
    <circle cx="10" cy="8" r="2" />
    <path d="M7 14c.5-2 1.5-3 3-3s2.5 1 3 3" />
  </IconFrame>
);
const DefaultIcon: React.FC<IconProps> = (props) => (
  <IconFrame {...props}>
    <rect x="3" y="3" width="14" height="14" rx="2" />
    <path d="M7 7h6M7 10h6M7 13h4" />
  </IconFrame>
);

export const DESIGN_MODULE_ICON_REGISTRY: Record<
  DesignModuleIconKey,
  React.FC<IconProps>
> = {
  chat: ChatIcon,
  interview: InterviewIcon,
  pdf: PdfIcon,
  analysis: AnalysisIcon,
  infra: InfraIcon,
  cicd: CicdIcon,
  rbac: RbacIcon,
  default: DefaultIcon,
};

export const DESIGN_MODULE_ICON_OPTIONS = DESIGN_MODULE_ICON_KEYS.map(
  (key) => ({
    key,
    label:
      key === 'cicd' ? 'CI/CD' : key.charAt(0).toUpperCase() + key.slice(1),
  })
);

export function getDesignModuleIcon(key: string): React.FC<IconProps> {
  return DESIGN_MODULE_ICON_REGISTRY[key as DesignModuleIconKey] ?? DefaultIcon;
}
