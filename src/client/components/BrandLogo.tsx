import React from 'react';
import {
  BRAND_MARK_INNER,
  BRAND_MARK_LEFT_LEG,
  BRAND_MARK_RIGHT_LEG,
  BRAND_MARK_SURFACE,
  BRAND_MARK_VIEWBOX,
  BRAND_SLOGAN,
} from './brandMark';

interface BrandLogoProps {
  variant?: 'mark' | 'lockup';
  tone?: 'default' | 'inverse';
  className?: string;
  showDescriptor?: boolean;
  beta?: boolean;
  align?: 'start' | 'center';
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  variant = 'lockup',
  tone = 'default',
  className,
  showDescriptor = true,
  beta = false,
  align = 'start',
}) => {
  const isInverse = tone === 'inverse';
  const markFill = isInverse ? 'var(--brand-primary-light)' : 'var(--brand-primary)';
  const markSurface = isInverse ? 'var(--brand-surface-dark)' : 'var(--brand-surface)';
  const markCutout = isInverse ? 'var(--brand-navy)' : 'var(--bg-primary)';
  const textColor = isInverse ? 'var(--brand-text-inverse)' : 'var(--text-primary)';
  const descriptorColor = isInverse ? 'var(--brand-primary-light)' : 'var(--accent-color)';
  const betaBadgeFill = isInverse ? 'var(--brand-primary-light)' : 'var(--accent-color)';
  const betaBadgeText = isInverse ? 'var(--brand-navy)' : 'var(--bg-primary)';

  const markSvg = (
    <svg
      viewBox={BRAND_MARK_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{
        display: 'block',
        width: variant === 'mark' ? '100%' : '0.9em',
        height: variant === 'mark' ? '100%' : '0.9em',
        flex: '0 0 auto',
      }}
    >
      <rect
        x={BRAND_MARK_SURFACE.x}
        y={BRAND_MARK_SURFACE.y}
        width={BRAND_MARK_SURFACE.width}
        height={BRAND_MARK_SURFACE.height}
        rx={BRAND_MARK_SURFACE.rx}
        fill={markSurface}
      />
      {/* Right (flat) under, left (kink) on top — flipped original layering */}
      <path d={BRAND_MARK_RIGHT_LEG} fill={markFill} />
      <path d={BRAND_MARK_LEFT_LEG} fill={markFill} opacity="0.9" />
      <path d={BRAND_MARK_INNER} fill={markCutout} />
      {beta && variant === 'mark' && (
        <>
          <rect x="16" y="74" width="64" height="14" rx="4" fill={markFill} />
          <text
            x="48"
            y="84.5"
            textAnchor="middle"
            fill={markSurface}
            fontSize="8.5"
            fontWeight="700"
            fontFamily="system-ui, -apple-system, sans-serif"
            letterSpacing="0.08em"
          >
            BETA
          </text>
        </>
      )}
    </svg>
  );

  if (variant === 'mark') {
    return (
      <div
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          color: textColor,
        }}
      >
        {markSvg}
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: align === 'center' ? 'center' : 'flex-start',
        gap: 10,
        color: textColor,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 12,
          lineHeight: 1,
        }}
      >
        {markSvg}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.28em' }}>
          <span style={{ fontWeight: 800, fontSize: '1em', letterSpacing: '-0.03em' }}>
            Apex
          </span>
          {beta && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.12em 0.42em',
                borderRadius: '0.22em',
                background: betaBadgeFill,
                color: betaBadgeText,
                fontSize: '0.28em',
                fontWeight: 700,
                letterSpacing: '0.1em',
                lineHeight: 1.2,
              }}
            >
              BETA
            </span>
          )}
        </span>
      </span>
      {showDescriptor && (
        <span
          style={{
            color: descriptorColor,
            fontSize: '0.34em',
            fontWeight: 600,
            letterSpacing: '0.02em',
            lineHeight: 1.3,
          }}
        >
          {BRAND_SLOGAN}
        </span>
      )}
    </div>
  );
};
