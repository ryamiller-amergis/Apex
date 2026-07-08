import React from 'react';

interface AgentIconProps {
  width?: number | string;
  height?: number | string;
  className?: string;
  title?: string;
}

/**
 * Material "Psychology" icon (head with gears) used for the agent "Thinking" state.
 * Path taken from the official Material Design / MUI icon set. Inherits color via currentColor.
 */
export const ThinkingIcon: React.FC<AgentIconProps> = ({
  width = 16,
  height = 16,
  className,
  title = 'Thinking',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={width}
    height={height}
    className={className}
    fill="currentColor"
    role="img"
    aria-label={title}
  >
    <title>{title}</title>
    <path d="M13 8.57c-.79 0-1.43.64-1.43 1.43s.64 1.43 1.43 1.43 1.43-.64 1.43-1.43-.64-1.43-1.43-1.43z" />
    <path d="M13 3C9.25 3 6.2 5.94 6.02 9.64L4.1 12.2c-.25.33-.01.8.4.8H6v3c0 1.1.9 2 2 2h1v3h7v-4.68c2.36-1.12 4-3.53 4-6.32 0-3.87-3.13-7-7-7zm3 7c0 .13-.01.26-.02.39l.83.66c.08.06.1.16.05.25l-.8 1.39c-.05.09-.16.12-.24.09l-.99-.4c-.21.16-.43.29-.67.39L14 14.83c-.01.1-.1.17-.2.17h-1.6c-.1 0-.18-.07-.2-.17l-.15-1.06c-.25-.1-.47-.23-.68-.39l-.99.4c-.09.03-.2 0-.25-.09l-.8-1.39c-.05-.08-.03-.19.05-.25l.84-.66c-.01-.13-.02-.26-.02-.39s.02-.27.04-.39l-.83-.66c-.08-.06-.1-.16-.05-.25l.8-1.39c.05-.09.16-.12.24-.09l.99.4c.21-.16.43-.29.67-.39l.15-1.06c.02-.1.1-.17.2-.17h1.6c.1 0 .18.07.2.17l.15 1.06c.25.1.47.23.68.39l.99-.4c.09-.03.2 0 .25.09l.8 1.39c.05.08.03.19-.05.25l-.83.66c.01.12.02.25.02.38z" />
  </svg>
);

/**
 * Material "Lightbulb" (outline) icon used for the agent "Reasoning" state.
 * Path taken from the official Material Design / MUI icon set. Inherits color via currentColor.
 */
export const ReasoningIcon: React.FC<AgentIconProps> = ({
  width = 16,
  height = 16,
  className,
  title = 'Reasoning',
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={width}
    height={height}
    className={className}
    fill="currentColor"
    role="img"
    aria-label={title}
  >
    <title>{title}</title>
    <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7zm2.85 11.1l-.85.6V16h-4v-2.3l-.85-.6C7.8 12.16 7 10.63 7 9c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.63-.8 3.16-2.15 4.1z" />
  </svg>
);
