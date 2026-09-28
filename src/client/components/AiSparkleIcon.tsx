import React from 'react';

interface AiSparkleIconProps {
  /** Pixel width/height — comment resolution uses 11; toolbar buttons often use 14–16. */
  size?: number;
  className?: string;
}

/** Sparkle glyph used for AI actions (e.g. PR comment “Fix with Apex”). */
export const AiSparkleIcon: React.FC<AiSparkleIconProps> = ({
  size = 11,
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5Z" />
    <path d="M19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75Z" />
  </svg>
);

export default AiSparkleIcon;
