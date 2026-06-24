import React from 'react';

interface BrandLogoProps {
  variant?: 'mark' | 'lockup';
  tone?: 'default' | 'inverse';
  className?: string;
  showDescriptor?: boolean;
  beta?: boolean;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  variant = 'lockup',
  tone = 'default',
  className,
  showDescriptor = true,
  beta = false,
}) => {
  const isInverse = tone === 'inverse';
  const markFill = isInverse ? 'var(--brand-primary-light)' : 'var(--brand-primary)';
  const markSurface = isInverse ? 'var(--brand-surface-dark)' : 'var(--brand-surface)';
  const markCutout = isInverse ? 'var(--brand-navy)' : 'var(--bg-primary)';
  const textColor = isInverse ? 'var(--brand-text-inverse)' : 'var(--text-primary)';
  const descriptorColor = isInverse ? 'var(--brand-primary-light)' : 'var(--accent-color)';
  const betaBadgeFill = isInverse ? 'var(--brand-primary-light)' : 'var(--accent-color)';
  const betaBadgeText = isInverse ? 'var(--brand-navy)' : 'var(--bg-primary)';

  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: variant === 'mark' ? 0 : 12,
        color: textColor,
      }}
    >
      <svg
        viewBox="0 0 96 96"
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
        <rect x="10" y="10" width="76" height="76" rx="20" fill={markSurface} />
        <path d="M20 72L43 22H56L34 72H20Z" fill={markFill} />
        <path d="M52 22L78 72H61L43 38L52 22Z" fill={markFill} opacity="0.9" />
        <path d="M40 72L49 54L58 72H40Z" fill={markCutout} />
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

      {variant === 'lockup' && (
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.28em' }}>
            <span style={{ fontWeight: 800, fontSize: '1em', letterSpacing: '-0.03em' }}>Apex</span>
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
          {showDescriptor && (
            <span
              style={{
                marginTop: 8,
                color: descriptorColor,
                fontSize: '0.34em',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              Planning to Delivery
            </span>
          )}
        </span>
      )}
    </div>
  );
};
