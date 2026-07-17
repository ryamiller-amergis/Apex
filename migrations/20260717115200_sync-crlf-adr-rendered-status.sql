UPDATE adrs
SET content = regexp_replace(
  content,
  '(^##[ \t]+Status[ \t]*\r?\n([ \t]*\r?\n)*)[^\r\n]+',
  E'\\1Accepted',
  'im'
),
updated_at = NOW()
WHERE status = 'accepted'
  AND content ~* '(?m)^##[ \t]+Status[ \t]*\r?\n([ \t]*\r?\n)*[^\r\n]+';

UPDATE adrs
SET content = regexp_replace(
  content,
  '(^##[ \t]+Status[ \t]*\r?\n([ \t]*\r?\n)*)[^\r\n]+',
  E'\\1Superseded',
  'im'
),
updated_at = NOW()
WHERE status = 'superseded'
  AND content ~* '(?m)^##[ \t]+Status[ \t]*\r?\n([ \t]*\r?\n)*[^\r\n]+';
