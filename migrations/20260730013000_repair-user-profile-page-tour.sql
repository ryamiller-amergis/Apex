-- Up Migration
-- Step 6 (repair-local): Replace fictional "Amego" content in the
-- user-profile-page-tour walkthrough with accurate Apex Profile content
-- and bump revision so users who already saw the old version re-see it.

-- 1. Delete the old steps (cascade-safe; progress rows reference walkthrough, not steps directly)
DELETE FROM walkthrough_steps
WHERE walkthrough_id = (
  SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'
);

-- 2. Bump revision and update metadata on the walkthrough itself
UPDATE walkthroughs
SET revision    = revision + 1,
    user_title  = 'Getting to know your Profile',
    why_it_matters = 'Set up your identity, bio, visual theme, and notification preferences so your team recognises you and Apex works the way you like.',
    updated_at  = NOW()
WHERE internal_name = 'user-profile-page-tour';

-- 3. Insert corrected steps using curated anchors and route catalog entries
INSERT INTO walkthrough_steps
  (walkthrough_id, ordinal, heading, body_markdown, target_route, image_url, image_alt, anchor_key, placement, cta_label, cta_route)
VALUES
  -- Step 0: Home intro (unanchored modal)
  (
    (SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'),
    0,
    'Welcome to Apex',
    'Apex is your team''s home for project planning, design interviews, AI-assisted PRDs, and more. Let''s take a quick tour of your Profile page.',
    '/home',
    '/brand-lockup.svg',
    'Apex logo',
    NULL,
    NULL,
    NULL,
    NULL
  ),
  -- Step 1: User menu (anchored to user-menu-profile on /home)
  (
    (SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'),
    1,
    'Open the user menu',
    'Click your avatar in the top-right corner to open the user menu, then select **Profile** to view your settings.',
    '/home',
    NULL,
    NULL,
    'user-menu-profile',
    'left',
    NULL,
    NULL
  ),
  -- Step 2: Profile identity (anchored to profile-identity on /profile)
  (
    (SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'),
    2,
    'Your identity',
    'This section shows your display name and avatar. Your identity is synced from your organisation''s directory, so your team always knows who you are.',
    '/profile',
    NULL,
    NULL,
    'profile-identity',
    'bottom',
    NULL,
    NULL
  ),
  -- Step 3: Bio section (anchored to profile-bio on /profile)
  (
    (SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'),
    3,
    'Tell your team about yourself',
    'Add a short bio so teammates and collaborators can learn a bit about you. This appears on your profile card across Apex.',
    '/profile',
    NULL,
    NULL,
    'profile-bio',
    'bottom',
    NULL,
    NULL
  ),
  -- Step 4: Theme preferences (anchored to profile-theme on /profile)
  (
    (SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'),
    4,
    'Customise your theme',
    'Choose a visual theme that suits you. Apex offers Light and several dark themes — your choice is saved and applied instantly.',
    '/profile',
    NULL,
    NULL,
    'profile-theme',
    'bottom',
    NULL,
    NULL
  ),
  -- Step 5: Notification preferences (anchored to profile-notifications on /profile)
  (
    (SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'),
    5,
    'Notification preferences',
    'Control which notifications you receive and how they''re delivered. Fine-tune alerts for standups, reviews, feature requests, and more.',
    '/profile',
    NULL,
    NULL,
    'profile-notifications',
    'top',
    NULL,
    NULL
  ),
  -- Step 6: Completion (unanchored modal on /profile)
  (
    (SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'),
    6,
    'You''re all set!',
    'Your profile is ready. You can return here any time from the user menu to update your bio, switch themes, or adjust notifications.',
    '/profile',
    NULL,
    NULL,
    NULL,
    NULL,
    'Go to Home',
    '/home'
  );

-- Down Migration
-- Restore the original step count placeholder; actual content is lost.
DELETE FROM walkthrough_steps
WHERE walkthrough_id = (
  SELECT id FROM walkthroughs WHERE internal_name = 'user-profile-page-tour'
);

UPDATE walkthroughs
SET revision   = GREATEST(revision - 1, 1),
    updated_at = NOW()
WHERE internal_name = 'user-profile-page-tour';
