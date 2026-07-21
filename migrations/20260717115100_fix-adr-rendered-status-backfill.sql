UPDATE adrs
SET content = regexp_replace(
  content,
  '(^##[ \t]+Status[ \t]*\n([ \t]*\n)*)[^\n]+',
  E'\\1Accepted',
  'im'
),
updated_at = NOW()
WHERE status = 'accepted'
  AND content ~* '(?m)^##[ \t]+Status[ \t]*\n([ \t]*\n)*[^\n]+';

UPDATE adrs
SET content = regexp_replace(
  content,
  '(^##[ \t]+Status[ \t]*\n([ \t]*\n)*)[^\n]+',
  E'\\1Superseded',
  'im'
),
updated_at = NOW()
WHERE status = 'superseded'
  AND content ~* '(?m)^##[ \t]+Status[ \t]*\n([ \t]*\n)*[^\n]+';
