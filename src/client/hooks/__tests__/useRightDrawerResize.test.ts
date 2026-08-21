import { act, renderHook } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { useRightDrawerResize } from '../useRightDrawerResize';

describe('useRightDrawerResize', () => {
  it('grows on ArrowLeft and shrinks on ArrowRight', () => {
    const { result } = renderHook(() => useRightDrawerResize());
    const start = result.current.width;

    act(() => {
      result.current.handleResizeKeyDown({
        key: 'ArrowLeft',
        preventDefault: jest.fn(),
      } as unknown as KeyboardEvent);
    });
    expect(result.current.width).toBeGreaterThan(start);

    const grown = result.current.width;
    act(() => {
      result.current.handleResizeKeyDown({
        key: 'ArrowRight',
        preventDefault: jest.fn(),
      } as unknown as KeyboardEvent);
    });
    expect(result.current.width).toBeLessThan(grown);
  });
});
