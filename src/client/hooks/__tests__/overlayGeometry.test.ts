import {
  clientDeltaToPagePercent,
  clientPointToPagePercent,
  clampOverlayBox,
  defaultBoxAt,
  moveOverlayBox,
  resizeOverlayFromHandle,
} from '../overlayGeometry';

describe('overlayGeometry', () => {
  it('places a default 30×10 box at the click then clamps near the edge', () => {
    expect(defaultBoxAt(40, 40)).toEqual({
      x: 40,
      y: 40,
      width: 30,
      height: 10,
    });

    expect(defaultBoxAt(98, 98)).toEqual({
      x: 70,
      y: 90,
      width: 30,
      height: 10,
    });
  });

  it('enforces minimum size while clamping fully on-page', () => {
    expect(clampOverlayBox({ x: -5, y: -5, width: 2, height: 1 })).toEqual({
      x: 0,
      y: 0,
      width: 5,
      height: 3,
    });
  });

  it('converts client points to page percentages', () => {
    expect(
      clientPointToPagePercent(150, 120, {
        left: 100,
        top: 100,
        width: 200,
        height: 100,
      })
    ).toEqual({ xPct: 25, yPct: 20 });
  });

  it('moves by page percent and clamps at page edges', () => {
    expect(
      moveOverlayBox({ x: 70, y: 5, width: 20, height: 10 }, 25, -10)
    ).toEqual({ x: 80, y: 0, width: 20, height: 10 });
  });

  it('resizes from each edge while enforcing minimum size', () => {
    expect(
      resizeOverlayFromHandle(
        { x: 20, y: 20, width: 30, height: 10 },
        'nw',
        40,
        20
      )
    ).toEqual({ x: 45, y: 27, width: 5, height: 3 });
  });

  it('clamps outward resize fully on-page', () => {
    expect(
      resizeOverlayFromHandle(
        { x: 70, y: 80, width: 20, height: 10 },
        'se',
        50,
        50
      )
    ).toEqual({ x: 70, y: 80, width: 30, height: 20 });
  });

  it('converts pointer deltas to page-relative percentages', () => {
    expect(
      clientDeltaToPagePercent(20, -10, { width: 200, height: 100 })
    ).toEqual({ xPct: 10, yPct: -10 });
  });
});
