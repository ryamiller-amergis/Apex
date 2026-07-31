import {
  availableSpaceForPlacement,
  buildAnchorHighlightStyle,
  isClippedByScrollableAncestor,
  isFixedOrStickyChrome,
  isOversizedForScrollport,
  isRectFullyInViewport,
  oppositeSide,
  pickBestCoachmarkPlacement,
  resolveCoachmarkMaxHeight,
  resolveCoachmarkMaxWidth,
  sameAxisFallbackPlacements,
  scrollBlockForPlacement,
  shouldScrollAnchorIntoView,
  scrollWalkthroughAnchorIntoView,
  type LayoutRect,
  type ViewportSize,
} from '../walkthroughCoachmarkLayout';

const viewport: ViewportSize = { width: 1000, height: 800 };

function rect(
  partial: Partial<LayoutRect> & Pick<LayoutRect, 'top' | 'left' | 'width' | 'height'>,
): LayoutRect {
  const top = partial.top;
  const left = partial.left;
  const width = partial.width;
  const height = partial.height;
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

describe('walkthroughCoachmarkLayout', () => {
  describe('pickBestCoachmarkPlacement', () => {
    it('keeps the preferred side when there is enough room', () => {
      const reference = rect({ top: 200, left: 200, width: 600, height: 180 });
      expect(
        pickBestCoachmarkPlacement('bottom', reference, viewport, { width: 420, height: 280 }),
      ).toBe('bottom');
    });

    it('places below a large section (not inside it) when bottom fits', () => {
      // Identity-sized block near the top — card must sit under the whole section.
      const reference = rect({ top: 120, left: 40, width: 920, height: 220 });
      expect(
        pickBestCoachmarkPlacement('bottom', reference, viewport, { width: 420, height: 280 }),
      ).toBe('bottom');
    });

    it('flips on the same axis when preferred top would clip', () => {
      const reference = rect({ top: 20, left: 400, width: 100, height: 40 });
      expect(
        pickBestCoachmarkPlacement('top', reference, viewport, { width: 420, height: 220 }),
      ).toBe('bottom');
    });

    it('does not jump to a sibling column for side-by-side section cards', () => {
      const reference = rect({ top: 200, left: 40, width: 420, height: 480 });
      expect(
        pickBestCoachmarkPlacement('bottom', reference, viewport, { width: 420, height: 280 }),
      ).toBe('top');
    });

    it('exposes same-axis fallbacks for Floating UI flip', () => {
      expect(sameAxisFallbackPlacements('bottom')).toEqual(['top']);
      expect(oppositeSide('left')).toBe('right');
      expect(availableSpaceForPlacement(rect({ top: 100, left: 200, width: 50, height: 50 }), viewport, 16)).toEqual({
        top: 84,
        bottom: 634,
        left: 184,
        right: 734,
      });
    });
  });

  describe('resolveCoachmarkMaxHeight', () => {
    it('allows soft slop so a nearly-fitting card does not gain a scrollbar', () => {
      expect(resolveCoachmarkMaxHeight(300, 900)).toBeGreaterThanOrEqual(300);
    });

    it('never exceeds the viewport ratio cap', () => {
      expect(resolveCoachmarkMaxHeight(2000, 800)).toBeLessThanOrEqual(Math.floor(800 * 0.72));
    });

    it('widens the preferred card width up to 420px', () => {
      expect(resolveCoachmarkMaxWidth(800)).toBe(420);
      expect(resolveCoachmarkMaxWidth(300)).toBe(300);
    });
  });

  describe('shouldScrollAnchorIntoView', () => {
    it('returns false when the anchor is fully visible with room on the preferred side', () => {
      const reference = rect({ top: 200, left: 200, width: 100, height: 40 });
      expect(shouldScrollAnchorIntoView(reference, viewport, 'bottom')).toBe(false);
      expect(isRectFullyInViewport(reference, viewport)).toBe(true);
    });

    it('returns true when the anchor sits below the fold', () => {
      const reference = rect({ top: 900, left: 200, width: 100, height: 40 });
      expect(shouldScrollAnchorIntoView(reference, viewport, 'bottom')).toBe(true);
    });
  });

  describe('scrollWalkthroughAnchorIntoView', () => {
    it('scrolls page content with a block that reserves room on the preferred side', () => {
      const el = document.createElement('div');
      const scrollIntoView = jest.fn();
      el.scrollIntoView = scrollIntoView;
      jest.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        top: 1200,
        bottom: 1240,
        left: 100,
        right: 200,
        width: 100,
        height: 40,
        x: 100,
        y: 1200,
        toJSON: () => ({}),
      });

      expect(scrollWalkthroughAnchorIntoView(el, { preferred: 'bottom' })).toBe(true);
      expect(scrollBlockForPlacement('bottom')).toBe('start');
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'start',
        inline: 'nearest',
      });
    });

    it('does not scroll normal-flow app header chrome (prevents menu shift)', () => {
      const header = document.createElement('header');
      header.className = 'app-header';
      const button = document.createElement('button');
      header.appendChild(button);
      document.body.appendChild(header);
      const scrollIntoView = jest.fn();
      button.scrollIntoView = scrollIntoView;

      expect(isFixedOrStickyChrome(button)).toBe(true);
      expect(scrollWalkthroughAnchorIntoView(button, { preferred: 'left', force: true })).toBe(false);
      expect(scrollIntoView).not.toHaveBeenCalled();

      header.remove();
    });

    it('scrolls a target clipped by a scrollable fixed modal', () => {
      const backdrop = document.createElement('div');
      backdrop.style.position = 'fixed';
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.style.overflow = 'auto';
      const target = document.createElement('input');
      const scrollIntoView = jest.fn();
      target.scrollIntoView = scrollIntoView;

      backdrop.appendChild(dialog);
      dialog.appendChild(target);
      document.body.appendChild(backdrop);

      jest.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
        top: 100,
        bottom: 600,
        left: 100,
        right: 900,
        width: 800,
        height: 500,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      });
      // Inside the browser viewport, but below the dialog's clipped scrollport.
      jest.spyOn(target, 'getBoundingClientRect').mockReturnValue({
        top: 650,
        bottom: 690,
        left: 200,
        right: 500,
        width: 300,
        height: 40,
        x: 200,
        y: 650,
        toJSON: () => ({}),
      });

      expect(isFixedOrStickyChrome(target)).toBe(false);
      expect(isClippedByScrollableAncestor(target)).toBe(true);
      expect(scrollWalkthroughAnchorIntoView(target, { preferred: 'top' })).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'end',
        inline: 'nearest',
      });

      backdrop.remove();
    });

    it('aligns an oversized modal form to the start instead of its bottom', () => {
      const dialog = document.createElement('section');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.style.overflow = 'auto';
      const form = document.createElement('form');
      const scrollIntoView = jest.fn();
      form.scrollIntoView = scrollIntoView;
      dialog.appendChild(form);
      document.body.appendChild(dialog);

      jest.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
        top: 24,
        bottom: 724,
        left: 100,
        right: 900,
        width: 800,
        height: 700,
        x: 100,
        y: 24,
        toJSON: () => ({}),
      });
      jest.spyOn(form, 'getBoundingClientRect').mockReturnValue({
        top: -500,
        bottom: 1100,
        left: 120,
        right: 880,
        width: 760,
        height: 1600,
        x: 120,
        y: -500,
        toJSON: () => ({}),
      });

      expect(isOversizedForScrollport(form)).toBe(true);
      expect(scrollWalkthroughAnchorIntoView(form, { preferred: 'top' })).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'start',
        inline: 'nearest',
      });

      dialog.remove();
    });
  });

  describe('buildAnchorHighlightStyle', () => {
    it('builds a fixed overlay rect padded around the target without mutating it', () => {
      const style = buildAnchorHighlightStyle(
        rect({ top: 100, left: 50, width: 200, height: 80 }),
        { width: 1000, height: 800 },
      );
      expect(style).toMatchObject({
        position: 'fixed',
        top: 96,
        left: 46,
        width: 208,
        height: 88,
        pointerEvents: 'none',
      });
    });

    it('clamps the highlight to the viewport so it cannot expand document scrollbars', () => {
      const style = buildAnchorHighlightStyle(
        rect({ top: -20, left: 900, width: 200, height: 100 }),
        { width: 1000, height: 800 },
      );
      expect(style.top).toBe(0);
      expect(style.left).toBe(896);
      expect(style.left + style.width).toBeLessThanOrEqual(1000);
      expect(style.top + style.height).toBeLessThanOrEqual(800);
    });
  });
});
