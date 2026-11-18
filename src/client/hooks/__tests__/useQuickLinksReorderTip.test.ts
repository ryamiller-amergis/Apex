import { act, renderHook } from '@testing-library/react';
import {
  REORDER_TIP_MAX_VISITS,
  REORDER_TIP_STORAGE_KEY,
  REORDER_TIP_VISIT_GAP_MS,
  useQuickLinksReorderTip,
} from '../useQuickLinksReorderTip';

let now = Date.UTC(2026, 10, 7, 9);

beforeEach(() => {
  window.localStorage.clear();
  now = Date.UTC(2026, 10, 7, 9);
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Mounts the hook as a fresh page load would, then unmounts it. */
function visit(eligible = true): boolean {
  const { result, unmount } = renderHook(() => useQuickLinksReorderTip(eligible));
  const { visible } = result.current;
  unmount();
  return visible;
}

describe('useQuickLinksReorderTip', () => {
  it(`shows on the first ${REORDER_TIP_MAX_VISITS} visits, then hides on its own`, () => {
    const seen: boolean[] = [];
    for (let i = 0; i < REORDER_TIP_MAX_VISITS + 1; i += 1) {
      seen.push(visit());
      now += REORDER_TIP_VISIT_GAP_MS;
    }
    expect(seen).toEqual([true, true, true, false]);
  });

  it('counts page loads inside the visit gap as one visit', () => {
    visit();
    now += REORDER_TIP_VISIT_GAP_MS - 1;
    visit();
    visit();
    expect(JSON.parse(window.localStorage.getItem(REORDER_TIP_STORAGE_KEY)!)).toMatchObject({ visits: 1 });
  });

  it('does not use up a visit while the user has nothing to reorder', () => {
    expect(visit(false)).toBe(false);
    expect(window.localStorage.getItem(REORDER_TIP_STORAGE_KEY)).toBeNull();
  });

  it('stays hidden after dismiss, on later visits too', () => {
    const { result, unmount } = renderHook(() => useQuickLinksReorderTip(true));
    expect(result.current.visible).toBe(true);

    act(() => result.current.dismiss());

    expect(result.current.visible).toBe(false);
    unmount();
    now += REORDER_TIP_VISIT_GAP_MS;
    expect(visit()).toBe(false);
  });
});
