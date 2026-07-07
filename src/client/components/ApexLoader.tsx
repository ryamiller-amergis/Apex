import React, { useId } from 'react';
import styles from './ApexLoader.module.css';

interface ApexLoaderProps {
  size?: number;
  fullscreen?: boolean;
  className?: string;
}

// Outer silhouette of the Apex "A" mark (viewBox 0 0 96 96), going clockwise:
//   bottom-left foot → top-left peak → top-right peak → bottom-right foot
//   → inner-right leg bottom → V-notch top → inner-left leg bottom → close
// Perimeter ≈ 214 (two ~59 outer edges + two 18 bottom feet + two ~25 inner edges + 11 crossbar top)
const BORDER_PATH =
  'M20,74 L43,20 L54,20 L78,74 L60,74 L49,52 L38,74 Z';

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
      viewBox="0 0 96 96"
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
        <path d="M20 72L43 22H56L34 72H20Z" className={styles.markFill} />
        <path d="M52 22L78 72H61L43 38L52 22Z" className={styles.markFill} opacity={0.9} />
      </g>

      {/* Circuit — faint static dashed track tracing the A outline */}
      <path d={BORDER_PATH} className={styles.circuitTrack} />

      {/* Circuit — animated bright dash sweeping around the A */}
      <path d={BORDER_PATH} className={styles.circuitFlow} />

      {/* Trace stubs extending outward from the three key points of the A */}
      {/* Top peak — stub goes straight up */}
      <line x1="48" y1="20" x2="48" y2="11" className={styles.traceStub} />
      {/* Bottom-left foot — stub goes left */}
      <line x1="20" y1="74" x2="11" y2="74" className={styles.traceStub} />
      {/* Bottom-right foot — stub goes right */}
      <line x1="78" y1="74" x2="87" y2="74" className={styles.traceStub} />

      {/* Node pads at each stub end, staggered pulse */}
      <circle cx="48" cy="11" r="2" className={styles.nodePad} />
      <circle
        cx="11" cy="74" r="2" className={styles.nodePad}
        style={{ '--node-delay': '0.6s' } as React.CSSProperties}
      />
      <circle
        cx="87" cy="74" r="2" className={styles.nodePad}
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
