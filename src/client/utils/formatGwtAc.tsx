import React from 'react';

/**
 * Renders acceptance-criteria text with Given:/When:/Then: keywords in bold.
 * Accepts keywords with or without a trailing colon and normalizes to "Keyword:".
 */
export function formatGwtAcText(text: string, keywordClassName?: string): React.ReactNode {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    const match = /^(Given|When|Then)\s*:?\s*(.*)$/i.exec(line.trim());
    const prefix = i > 0 ? '\n' : '';
    if (!match) {
      return (
        <React.Fragment key={i}>
          {prefix}
          {line}
        </React.Fragment>
      );
    }
    const keyword = `${match[1].charAt(0).toUpperCase()}${match[1].slice(1).toLowerCase()}:`;
    const rest = match[2];
    return (
      <React.Fragment key={i}>
        {prefix}
        <strong className={keywordClassName}>{keyword}</strong>
        {rest ? ` ${rest}` : ''}
      </React.Fragment>
    );
  });
}
