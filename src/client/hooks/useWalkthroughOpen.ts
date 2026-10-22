import { useEffect, useState } from 'react';

const WALKTHROUGH_SELECTOR = '[data-testid="walkthrough-renderer"]';

/** No app state says a walkthrough is on screen, so watch the DOM for its renderer. */
export function useWalkthroughOpen(): boolean {
  const [open, setOpen] = useState(() => document.querySelector(WALKTHROUGH_SELECTOR) !== null);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setOpen(document.querySelector(WALKTHROUGH_SELECTOR) !== null);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return open;
}
