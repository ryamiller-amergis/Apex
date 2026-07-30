import React, { useId } from 'react';
import {
  BRAND_MARK_INNER,
  BRAND_MARK_LEFT_LEG,
  BRAND_MARK_OUTLINE,
  BRAND_MARK_RIGHT_LEG,
  BRAND_MARK_VIEWBOX,
} from './brandMark';
import styles from './ApexLoader.module.css';

interface ApexLoaderProps {
  size?: number;
  fullscreen?: boolean;
  className?: string;
}

// Outer silhouette of the Apex "A" mark — see brandMark.ts
const BORDER_PATH = BRAND_MARK_OUTLINE;

export const ApexLoader: React.FC<ApexLoaderProps> = ({
  size = 72,
  fullscreen = false,
  className,
}) => {
  const uid = useId().replace(/:/g, '');
  const filterId = `apxgf-${uid}`;
  const borderPathId = `apxbp-${uid}`;

  const svg = (
    <svg
      className={styles.svg}
      viewBox={BRAND_MARK_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="status"
      aria-label="Loading"
      aria-busy="true"
      style={{ width: size, height: size }}
    >
      <defs>
        {/* Glow filter for the traveling spark */}
        <filter id={filterId} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* A-silhouette path — shared by circuit strokes + animateMotion */}
        <path id={borderPathId} d={BORDER_PATH} />
      </defs>

      {/* "A" mark — no background square, breathes gently while loading */}
      <g className={styles.mark}>
        <path d={BRAND_MARK_RIGHT_LEG} className={styles.markFill} />
        <path d={BRAND_MARK_LEFT_LEG} className={styles.markFill} opacity={0.9} />
        <path d={BRAND_MARK_INNER} className={styles.markCutout} />
      </g>

      {/* Circuit — faint static dashed track tracing the A outline */}
      <path d={BORDER_PATH} className={styles.circuitTrack} />

      {/* Circuit — animated bright dash sweeping around the A */}
      <path d={BORDER_PATH} className={styles.circuitFlow} />

      {/* Trace stubs extending outward from the three key points of the A */}
      <line x1="48" y1="22" x2="48" y2="11" className={styles.traceStub} />
      <line x1="18" y1="72" x2="11" y2="72" className={styles.traceStub} />
      <line x1="76" y1="72" x2="87" y2="72" className={styles.traceStub} />

      <circle cx="48" cy="11" r="2" className={styles.nodePad} />
      <circle
        cx="11" cy="72" r="2" className={styles.nodePad}
        style={{ '--node-delay': '0.6s' } as React.CSSProperties}
      />
      <circle
        cx="87" cy="72" r="2" className={styles.nodePad}
        style={{ '--node-delay': '1.1s' } as React.CSSProperties}
      />

      {/* Traveling glow — spark + halo travel around the A via SMIL */}
      <g className={styles.glowGroup}>
        <circle r="4.5" className={styles.glowHalo} filter={`url(#${filterId})`} />
        <circle r="2" className={styles.glowCore} />
        <animateMotion dur="2.2s" repeatCount="indefinite">
          <mpath href={`#${borderPathId}`} />
        </animateMotion>
      </g>
    </svg>
  );

  if (fullscreen) {
    return (
      <div className={`${styles.fullscreen}${className ? ` ${className}` : ''}`}>
        {svg}
      </div>
    );
  }

  return (
    <div
      className={`${styles.wrap}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
    >
      {svg}
    </div>
  );
};
