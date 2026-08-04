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
  Eraser,
} from 'lucide-react';
import type { WorkbenchTool } from '../hooks/useApryseWorkbench';
import styles from './NutrientToolRail.module.css';

export interface ApryseToolRailProps {
  activeTool: WorkbenchTool;
  isLoaded: boolean;
  /** When true, PDF-only tools stay disabled (e.g. XLSX spreadsheet mode). */
  spreadsheetMode?: boolean;
  onSetTool: (tool: WorkbenchTool) => void;
}

interface ToolDefinition {
  id: Exclude<WorkbenchTool, null>;
  label: string;
  Icon: LucideIcon;
  ariaLabel: string;
  pdfOnly?: boolean;
}

const TOOLS: ToolDefinition[] = [
  { id: 'pan', label: 'Select', Icon: MousePointer2, ariaLabel: 'Select / pan tool' },
  {
    id: 'text-edit',
    label: 'Edit Text',
    Icon: TextCursorInput,
    ariaLabel: 'Edit existing PDF text',
    pdfOnly: true,
  },
  {
    id: 'highlight',
    label: 'Highlight',
    Icon: Highlighter,
    ariaLabel: 'Highlight text',
    pdfOnly: true,
  },
  { id: 'draw', label: 'Draw', Icon: Pen, ariaLabel: 'Draw freehand ink', pdfOnly: true },
  {
    id: 'add-text',
    label: 'Add Text',
    Icon: PenLine,
    ariaLabel: 'Add a new text annotation',
    pdfOnly: true,
  },
  {
    id: 'comment',
    label: 'Comment',
    Icon: MessageSquare,
    ariaLabel: 'Add a comment',
    pdfOnly: true,
  },
  {
    id: 'fill-form',
    label: 'Fill Form',
    Icon: FileText,
    ariaLabel: 'Fill form fields',
    pdfOnly: true,
  },
  {
    id: 'sign',
    label: 'Sign',
    Icon: Signature,
    ariaLabel: 'Add an ink or digital signature',
    pdfOnly: true,
  },
  {
    id: 'redact',
    label: 'Redact',
    Icon: Eraser,
    ariaLabel: 'Mark and apply true redactions',
    pdfOnly: true,
  },
  {
    id: 'pages',
    label: 'Pages',
    Icon: LayoutGrid,
    ariaLabel: 'Manage pages — thumbnails, reorder, rotate, add, delete',
    pdfOnly: true,
  },
];

export const ApryseToolRail: React.FC<ApryseToolRailProps> = ({
  activeTool,
  isLoaded,
  spreadsheetMode = false,
  onSetTool,
}) => {
  const handleClick = (id: Exclude<WorkbenchTool, null>, pdfOnly?: boolean) => {
    if (!isLoaded) return;
    if (spreadsheetMode && pdfOnly) return;
    onSetTool(activeTool === id ? null : id);
  };

  return (
    <nav
      className={styles.rail}
      aria-label="Apryse PDF editing tools"
      data-testid="apryse-tool-rail"
    >
      {TOOLS.map(({ id, label, Icon, ariaLabel, pdfOnly }) => {
        const disabled = !isLoaded || (Boolean(spreadsheetMode) && Boolean(pdfOnly));
        return (
          <button
            key={id}
            type="button"
            className={`${styles.toolBtn} ${activeTool === id ? styles.toolBtnActive : ''}`}
            aria-pressed={activeTool === id}
            aria-label={ariaLabel}
            title={
              spreadsheetMode && pdfOnly
                ? `${label} (PDF only — close spreadsheet to use)`
                : label
            }
            disabled={disabled}
            onClick={() => handleClick(id, pdfOnly)}
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
        );
      })}
    </nav>
  );
};
