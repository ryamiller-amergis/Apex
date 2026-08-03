-- Fix user-menu step: anchor the avatar trigger (always visible) instead of the
-- Profile menu item (only present while the dropdown is open). Placement left
-- keeps the coachmark beside the header control without covering page content.

UPDATE walkthrough_steps
SET anchor_key = 'user-menu-trigger',
    placement = 'left',
    target_route = '/home',
    heading = 'Open the user menu',
    body_markdown = 'Click your avatar in the top-right corner to open the user menu, then select **Profile** to view your settings.'
WHERE walkthrough_id = (
  SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'
)
AND ordinal = 1;
