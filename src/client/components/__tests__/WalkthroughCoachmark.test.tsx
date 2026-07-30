/**
 * Coachmark: outside-target placement, non-mutating highlight, no header scroll.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { WalkthroughCoachmark } from '../WalkthroughCoachmark';
import type { WalkthroughRendererStep } from '../../../shared/types/walkthrough';
import * as layout from '../../utils/walkthroughCoachmarkLayout';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

jest.mock('remark-gfm', () => () => {});

const step: WalkthroughRendererStep = {
  id: 's1',
  position: 0,
  heading: 'Your identity',
  bodyMarkdown: 'This section shows your display name and avatar.',
};

function noop() {}

describe('WalkthroughCoachmark viewport behavior', () => {
  let scrollSpy: jest.SpyInstance;

  beforeEach(() => {
    scrollSpy = jest.spyOn(layout, 'scrollWalkthroughAnchorIntoView');
  });

  afterEach(() => {
    scrollSpy.mockRestore();
    document.body.replaceChildren();
  });

  it('positions against the section element itself (not an inner heading)', async () => {
    const pickSpy = jest.spyOn(layout, 'pickBestCoachmarkPlacement');
    const section = document.createElement('section');
    const heading = document.createElement('h2');
    heading.setAttribute('data-walkthrough-focus', '');
    heading.textContent = 'Identity';
    section.appendChild(heading);
    document.body.appendChild(section);

    jest.spyOn(section, 'getBoundingClientRect').mockReturnValue({
      top: 120,
      bottom: 340,
      left: 40,
      right: 960,
      width: 920,
      height: 220,
      x: 40,
      y: 120,
      toJSON: () => ({}),
    });

    render(
      <WalkthroughCoachmark
        step={step}
        stepIndex={2}
        stepCount={7}
        reference={section}
        placement="bottom"
        onBack={noop}
        onNext={noop}
        onComplete={noop}
        onDismiss={noop}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-coachmark-step')).toBeInTheDocument();
    });

    // Placement math must use the section rect, not the heading.
    expect(pickSpy).toHaveBeenCalled();
    const referenceArg = pickSpy.mock.calls[0]?.[1] as layout.LayoutRect;
    expect(referenceArg.height).toBe(220);
    expect(pickSpy.mock.results[0]?.value).toBe('bottom');
    const card = screen.getByTestId('walkthrough-coachmark-step');
    const pointer = card.querySelector('[data-side]');
    expect(pointer).toHaveAttribute(
      'data-side',
      card.getAttribute('data-placement')?.split('-')[0],
    );
    pickSpy.mockRestore();
  });

  it('renders a non-mutating highlight overlay instead of styling the target', async () => {
    const section = document.createElement('section');
    section.textContent = 'Identity';
    document.body.appendChild(section);
    jest.spyOn(section, 'getBoundingClientRect').mockReturnValue({
      top: 120,
      bottom: 340,
      left: 40,
      right: 960,
      width: 920,
      height: 220,
      x: 40,
      y: 120,
      toJSON: () => ({}),
    });

    render(
      <WalkthroughCoachmark
        step={step}
        stepIndex={2}
        stepCount={7}
        reference={section}
        placement="bottom"
        onBack={noop}
        onNext={noop}
        onComplete={noop}
        onDismiss={noop}
      />,
    );

    expect(await screen.findByTestId('walkthrough-anchor-highlight')).toBeInTheDocument();
    expect(section.hasAttribute('data-walkthrough-highlighted')).toBe(false);
  });

  it('does not force-scroll anchors (avoids shifting the user menu)', async () => {
    const reference = document.createElement('button');
    reference.textContent = 'Menu';
    document.body.appendChild(reference);

    render(
      <WalkthroughCoachmark
        step={step}
        stepIndex={1}
        stepCount={7}
        reference={reference}
        placement="left"
        onBack={noop}
        onNext={noop}
        onComplete={noop}
        onDismiss={noop}
      />,
    );

    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalled();
    });
    const opts = scrollSpy.mock.calls[0]?.[1] as { force?: boolean } | undefined;
    expect(opts?.force).toBeUndefined();
  });

  it('keeps Back/Next/Dismiss outside the scroll region', async () => {
    const reference = document.createElement('section');
    reference.textContent = 'Theme';
    document.body.appendChild(reference);

    render(
      <WalkthroughCoachmark
        step={step}
        stepIndex={0}
        stepCount={3}
        reference={reference}
        placement="bottom"
        onBack={noop}
        onNext={noop}
        onComplete={noop}
        onDismiss={noop}
      />,
    );

    const card = await screen.findByTestId('walkthrough-coachmark-step');
    const footer = card.querySelector('[class*="coachmarkFooter"]');
    const scroll = card.querySelector('[class*="coachmarkScroll"]');
    expect(footer!.contains(screen.getByTestId('walkthrough-next'))).toBe(true);
    expect(scroll!.contains(screen.getByTestId('walkthrough-next'))).toBe(false);
  });
});
