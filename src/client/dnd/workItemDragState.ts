import type { WorkItem } from '../types/workitem';

/** MIME type for HTML5 dataTransfer of calendar/unscheduled work items. */
export const APEX_WORK_ITEM_MIME = 'application/x-apex-work-item';

let draggedWorkItem: WorkItem | null = null;
let draggedCalendarItem: WorkItem | null = null;

export function setDraggedWorkItem(item: WorkItem | null): void {
  draggedWorkItem = item;
}

export function getDraggedWorkItem(): WorkItem | null {
  return draggedWorkItem;
}

export function clearDraggedWorkItem(): void {
  draggedWorkItem = null;
}

export function setDraggedCalendarItem(item: WorkItem | null): void {
  draggedCalendarItem = item;
}

export function getDraggedCalendarItem(): WorkItem | null {
  return draggedCalendarItem;
}

export function clearDraggedCalendarItem(): void {
  draggedCalendarItem = null;
}

export function clearAllDraggedWorkItems(): void {
  draggedWorkItem = null;
  draggedCalendarItem = null;
}

/** Prefer module state; fall back to dataTransfer JSON if present. */
export function resolveDraggedWorkItem(dataTransfer?: DataTransfer | null): WorkItem | null {
  const fromState = draggedWorkItem ?? draggedCalendarItem;
  if (fromState) return fromState;
  if (!dataTransfer) return null;
  try {
    const raw =
      dataTransfer.getData(APEX_WORK_ITEM_MIME) ||
      dataTransfer.getData('text/plain');
    if (!raw) return null;
    return JSON.parse(raw) as WorkItem;
  } catch {
    return null;
  }
}

export function writeDraggedWorkItemToTransfer(
  dataTransfer: DataTransfer,
  item: WorkItem,
): void {
  const json = JSON.stringify(item);
  try {
    dataTransfer.setData(APEX_WORK_ITEM_MIME, json);
  } catch {
    // Some browsers reject custom MIME types; text/plain is enough.
  }
  dataTransfer.setData('text/plain', json);
  dataTransfer.effectAllowed = 'move';
}
