UPDATE adrs
SET content = CASE
  WHEN content ~* '(^|[\r\n])status:[^\r\n]*'
    THEN regexp_replace(content, '(^|[\r\n])status:[^\r\n]*', E'\\1status: Accepted', 'i')
  WHEN BTRIM(content) <> ''
    THEN E'---\nstatus: Accepted\n---\n\n' || content
  ELSE content
END,
updated_at = NOW()
WHERE status = 'accepted';

UPDATE adrs
SET content = CASE
  WHEN content ~* '(^|[\r\n])status:[^\r\n]*'
    THEN regexp_replace(content, '(^|[\r\n])status:[^\r\n]*', E'\\1status: Superseded', 'i')
  WHEN BTRIM(content) <> ''
    THEN E'---\nstatus: Superseded\n---\n\n' || content
  ELSE content
END,
updated_at = NOW()
WHERE status = 'superseded';
