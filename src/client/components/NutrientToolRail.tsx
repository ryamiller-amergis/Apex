import React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  MousePointer2,
  TextCursorInput,
  Highlighter,
  Pen,
  PenLine,
  MessageSquare,
  FileText,
  Signature,
  LayoutGrid,
} from 'lucide-react';
import type { WorkbenchTool } from '../hooks/useNutrientWorkbench';
import styles from './NutrientToolRail.module.css';

export interface ToolRailProps {
  activeTool: WorkbenchTool;
  isLoaded: boolean;
  onSetTool: (tool: WorkbenchTool) => void;
}

interface ToolDefinition {
  id: WorkbenchTool;
  label: string;
  Icon: LucideIcon;
  ariaLabel: string;
}

const TOOLS: ToolDefinition[] = [
  { id: 'pan', label: 'Select', Icon: MousePointer2, ariaLabel: 'Pan/Select tool' },
  { id: 'text-edit', label: 'Edit Text', Icon: TextCursorInput, ariaLabel: 'Edit existing PDF text' },
  { id: 'highlight', label: 'Highlight', Icon: Highlighter, ariaLabel: 'Highlight text' },
  { id: 'draw', label: 'Draw', Icon: Pen, ariaLabel: 'Draw freehand ink' },
  { id: 'add-text', label: 'Add Text', Icon: PenLine, ariaLabel: 'Add a new text annotation' },
  { id: 'comment', label: 'Comment', Icon: MessageSquare, ariaLabel: 'Add a comment' },
  { id: 'fill-form', label: 'Fill Form', Icon: FileText, ariaLabel: 'Fill form fields' },
  { id: 'sign', label: 'Sign', Icon: Signature, ariaLabel: 'Add a signature' },
  { id: 'pages', label: 'Pages', Icon: LayoutGrid, ariaLabel: 'Manage pages — reorder, rotate, delete (requires Document Editing license)' },
];

export const NutrientToolRail: React.FC<ToolRailProps> = ({
  activeTool,
  isLoaded,
  onSetTool,
}) => {
  const handleClick = (id: WorkbenchTool) => {
    if (!isLoaded) return;
    onSetTool(activeTool === id ? null : id);
  };

  return (
    <nav
      className={styles.rail}
      aria-label="PDF editing tools"
      data-testid="nutrient-tool-rail"
    >
      {TOOLS.map(({ id, label, Icon, ariaLabel }) => (
        <button
          key={id}
          type="button"
          className={`${styles.toolBtn} ${activeTool === id ? styles.toolBtnActive : ''}`}
          aria-pressed={activeTool === id}
          aria-label={ariaLabel}
          title={label}
          disabled={!isLoaded}
          onClick={() => handleClick(id)}
          data-testid={`tool-btn-${id}`}
        >
          <Icon
            size={20}
            strokeWidth={1.6}
            className={styles.toolIcon}
            aria-hidden="true"
          />
          <span className={styles.toolLabel}>{label}</span>
        </button>
      ))}
    </nav>
  );
};
