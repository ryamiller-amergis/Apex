/**
 * Agent Skills frontmatter check used as an install/validate gate.
 *
 * Required fields and known optional fields are validated. Extra keys used by
 * other harnesses are warnings, not errors — this is not a closed allow-list.
 */
export const AGENT_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isAgentSkillName(value) {
  return typeof value === 'string' && AGENT_SKILL_NAME_PATTERN.test(value);
}
const KNOWN_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

export function validateAgentSkillDocument(text, { expectedName = null } = {}) {
  const errors = [];
  const warnings = [];
  const parsed = parseSkillFrontmatter(text);

  if (parsed.error) {
    return { ok: false, errors: [parsed.error], warnings, frontmatter: {} };
  }
  const { frontmatter } = parsed;

  for (const field of Object.keys(frontmatter)) {
    if (!KNOWN_FIELDS.has(field)) {
      warnings.push(
        `unrecognized frontmatter field "${field}" (allowed; not in the Agent Skills core set)`
      );
    }
  }

  const name = frontmatter.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    errors.push('name is required');
  } else {
    if (name.length > 64) errors.push('name must be at most 64 characters');
    if (!AGENT_SKILL_NAME_PATTERN.test(name)) {
      errors.push(
        'name must contain lowercase letters, numbers, and single hyphens only'
      );
    }
    if (expectedName && name !== expectedName) {
      errors.push(
        `name "${name}" must match parent directory "${expectedName}"`
      );
    }
  }

  const description = frontmatter.description;
  if (typeof description !== 'string' || description.trim().length === 0) {
    errors.push('description is required');
  } else if (description.length > 1024) {
    errors.push('description must be at most 1024 characters');
  }

  validateOptionalString(frontmatter, 'license', errors);
  validateOptionalString(frontmatter, 'allowed-tools', errors);
  validateOptionalString(frontmatter, 'compatibility', errors, {
    maxLength: 500,
  });

  if (frontmatter.metadata != null) {
    if (
      typeof frontmatter.metadata !== 'object' ||
      Array.isArray(frontmatter.metadata)
    ) {
      errors.push('metadata must be a mapping of string keys to string values');
    } else {
      for (const [key, value] of Object.entries(frontmatter.metadata)) {
        if (!key || typeof value !== 'string') {
          errors.push(
            'metadata must be a mapping of string keys to string values'
          );
          break;
        }
      }
    }
  }

  const lineCount = String(text ?? '').split(/\r?\n/).length;
  if (lineCount > 500) {
    warnings.push(
      `SKILL.md is ${lineCount} lines; Agent Skills recommends fewer than 500`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    frontmatter,
  };
}

export function parseSkillFrontmatter(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return {
      error: 'SKILL.md must start with YAML frontmatter',
      frontmatter: {},
    };
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) {
    return {
      error: 'SKILL.md frontmatter must end with ---',
      frontmatter: {},
    };
  }

  const lines = normalized.slice(4, end).split('\n');
  const frontmatter = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      index += 1;
      continue;
    }
    if (/^\s/.test(line)) {
      return {
        error: `invalid unexpected indentation in frontmatter: ${line.trim()}`,
        frontmatter: {},
      };
    }
    const match = /^([a-z][a-z0-9-]*):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      return {
        error: `invalid YAML frontmatter line: ${line}`,
        frontmatter: {},
      };
    }
    const [, key, rawValue = ''] = match;
    if (Object.hasOwn(frontmatter, key)) {
      return {
        error: `duplicate frontmatter field "${key}"`,
        frontmatter: {},
      };
    }

    if (key === 'metadata' && rawValue.trim() === '') {
      const metadata = {};
      index += 1;
      while (index < lines.length && /^\s/.test(lines[index])) {
        const child = /^\s{2,}([^:#][^:]*):\s*(.*)$/.exec(lines[index]);
        if (!child) {
          return {
            error: `invalid metadata entry: ${lines[index].trim()}`,
            frontmatter: {},
          };
        }
        const metadataKey = child[1].trim();
        if (Object.hasOwn(metadata, metadataKey)) {
          return {
            error: `duplicate metadata key "${metadataKey}"`,
            frontmatter: {},
          };
        }
        metadata[metadataKey] = parseScalar(child[2]);
        index += 1;
      }
      frontmatter[key] = metadata;
      continue;
    }

    const blockHeader = parseBlockScalarHeader(rawValue);
    if (blockHeader) {
      const blockLines = [];
      index += 1;
      while (
        index < lines.length &&
        (lines[index] === '' || /^\s/.test(lines[index]))
      ) {
        blockLines.push(lines[index].replace(/^\s{2}/, ''));
        index += 1;
      }
      const joined = blockHeader.folded
        ? blockLines.join(' ').trim()
        : blockLines.join('\n');
      frontmatter[key] = blockHeader.chomp === '+' ? joined : joined.trimEnd();
      continue;
    }

    frontmatter[key] = parseScalar(rawValue);
    index += 1;
  }

  return { error: null, frontmatter };
}

/** YAML block headers: `|`, `>`, plus chomping (`-`/`+`) and indent digits. */
function parseBlockScalarHeader(rawValue) {
  const match = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?$/.exec(
    String(rawValue ?? '').trim()
  );
  if (!match) return null;
  return {
    folded: match[1] === '>',
    chomp: match[2] || match[5] || '',
  };
}

function parseScalar(value) {
  const trimmed = String(value ?? '').trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  if (/^(true|false|null|~)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === 'true'
      ? true
      : trimmed.toLowerCase() === 'false'
        ? false
        : null;
  }
  if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function validateOptionalString(
  frontmatter,
  field,
  errors,
  { maxLength = null } = {}
) {
  const value = frontmatter[field];
  if (value == null) return;
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string when provided`);
    return;
  }
  if (maxLength != null && value.length > maxLength) {
    errors.push(`${field} must be at most ${maxLength} characters`);
  }
}
