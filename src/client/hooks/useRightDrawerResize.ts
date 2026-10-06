import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';

const DEFAULT_WIDTH = 560;
const MIN_WIDTH = 400;
const MAX_WIDTH = 960;
const RESIZE_STEP = 24;

export function useRightDrawerResize() {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_WIDTH);
  const resizeJustEndedRef = useRef(false);

  const handleResizeMouseDown = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragStartXRef.current = event.clientX;
    dragStartWidthRef.current = width;
    setIsDragging(true);
  }, [width]);

  const handleResizeKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setWidth((current) => Math.min(MAX_WIDTH, current + RESIZE_STEP));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setWidth((current) => Math.max(MIN_WIDTH, current - RESIZE_STEP));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setWidth(MAX_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      setWidth(MIN_WIDTH);
    }
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMouseMove = (event: globalThis.MouseEvent) => {
      const delta = dragStartXRef.current - event.clientX;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartWidthRef.current + delta)));
    };
    const onMouseUp = () => {
      resizeJustEndedRef.current = true;
      setIsDragging(false);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  const consumeResizeClick = useCallback(() => {
    if (!resizeJustEndedRef.current) return false;
    resizeJustEndedRef.current = false;
    return true;
  }, []);

  return {
    width,
    isDragging,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    handleResizeMouseDown,
    handleResizeKeyDown,
    consumeResizeClick,
  };
}
