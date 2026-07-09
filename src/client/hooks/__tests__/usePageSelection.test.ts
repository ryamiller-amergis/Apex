import { renderHook, act } from '@testing-library/react';
import { usePageSelection } from '../usePageSelection';

describe('usePageSelection', () => {
  const allPageIds = ['p1', 'p2', 'p3', 'p4', 'p5'];

  it('starts with empty selection', () => {
    const { result } = renderHook(() => usePageSelection());

    expect(result.current.selectedCount).toBe(0);
    expect(result.current.isSelected('p1')).toBe(false);
  });

  it('toggleSelection sets selection to just one page (click)', () => {
    const { result } = renderHook(() => usePageSelection());

    act(() => {
      result.current.toggleSelection('p2');
    });

    expect(result.current.isSelected('p2')).toBe(true);
    expect(result.current.selectedCount).toBe(1);
  });

  it('toggleSelection replaces previous selection', () => {
    const { result } = renderHook(() => usePageSelection());

    act(() => {
      result.current.toggleSelection('p1');
    });
    act(() => {
      result.current.toggleSelection('p3');
    });

    expect(result.current.isSelected('p1')).toBe(false);
    expect(result.current.isSelected('p3')).toBe(true);
    expect(result.current.selectedCount).toBe(1);
  });

  it('rangeSelect selects contiguous range from last click (shift-click)', () => {
    const { result } = renderHook(() => usePageSelection());

    act(() => {
      result.current.toggleSelection('p2');
    });
    act(() => {
      result.current.rangeSelect('p4', allPageIds);
    });

    expect(result.current.isSelected('p2')).toBe(true);
    expect(result.current.isSelected('p3')).toBe(true);
    expect(result.current.isSelected('p4')).toBe(true);
    expect(result.current.selectedCount).toBe(3);
    expect(result.current.isSelected('p1')).toBe(false);
    expect(result.current.isSelected('p5')).toBe(false);
  });

  it('rangeSelect works in reverse direction', () => {
    const { result } = renderHook(() => usePageSelection());

    act(() => {
      result.current.toggleSelection('p4');
    });
    act(() => {
      result.current.rangeSelect('p2', allPageIds);
    });

    expect(result.current.isSelected('p2')).toBe(true);
    expect(result.current.isSelected('p3')).toBe(true);
    expect(result.current.isSelected('p4')).toBe(true);
    expect(result.current.selectedCount).toBe(3);
  });

  it('rangeSelect with no prior click selects just the target', () => {
    const { result } = renderHook(() => usePageSelection());

    act(() => {
      result.current.rangeSelect('p3', allPageIds);
    });

    expect(result.current.isSelected('p3')).toBe(true);
    expect(result.current.selectedCount).toBe(1);
  });

  it('clearSelection clears all selections', () => {
    const { result } = renderHook(() => usePageSelection());

    act(() => {
      result.current.toggleSelection('p1');
    });
    act(() => {
      result.current.rangeSelect('p3', allPageIds);
    });

    expect(result.current.selectedCount).toBe(3);

    act(() => {
      result.current.clearSelection();
    });

    expect(result.current.selectedCount).toBe(0);
    expect(result.current.isSelected('p1')).toBe(false);
  });

  it('selectedPageIds reflects current selection', () => {
    const { result } = renderHook(() => usePageSelection());

    act(() => {
      result.current.toggleSelection('p2');
    });
    act(() => {
      result.current.rangeSelect('p4', allPageIds);
    });

    expect(result.current.selectedPageIds).toEqual(new Set(['p2', 'p3', 'p4']));
  });

  it('selectAll sets all provided page IDs as selected', () => {
    const { result } = renderHook(() => usePageSelection());

    act(() => {
      result.current.selectAll(allPageIds);
    });

    expect(result.current.selectedCount).toBe(5);
    expect(result.current.isSelected('p1')).toBe(true);
    expect(result.current.isSelected('p2')).toBe(true);
    expect(result.current.isSelected('p3')).toBe(true);
    expect(result.current.isSelected('p4')).toBe(true);
    expect(result.current.isSelected('p5')).toBe(true);
  });

  it('deselectAll clears all selections', () => {
    const { result } = renderHook(() => usePageSelection());

    act(() => {
      result.current.selectAll(allPageIds);
    });

    expect(result.current.selectedCount).toBe(5);

    act(() => {
      result.current.deselectAll();
    });

    expect(result.current.selectedCount).toBe(0);
    expect(result.current.isSelected('p1')).toBe(false);
  });

  it('selectedCount reflects selectAll correctly', () => {
    const { result } = renderHook(() => usePageSelection());

    expect(result.current.selectedCount).toBe(0);

    act(() => {
      result.current.selectAll(['p1', 'p3']);
    });

    expect(result.current.selectedCount).toBe(2);
    expect(result.current.isSelected('p1')).toBe(true);
    expect(result.current.isSelected('p2')).toBe(false);
    expect(result.current.isSelected('p3')).toBe(true);
  });
});
