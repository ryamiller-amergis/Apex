import React from 'react';

/**
 * Thin FEAT-002 stub for the guarded `/diagrams` route.
 * FEAT-003 replaces this with the Excalidraw Diagrams module.
 */
export const DiagramsPlaceholder: React.FC = () => {
  return (
    <div
      role="status"
      aria-live="polite"
      {...{ 'data-testid': 'diagrams-placeholder' }}
    >
      <h1>Diagrams</h1>
      <p>The Diagrams module will be available here once the editor is enabled.</p>
    </div>
  );
};

export default DiagramsPlaceholder;
