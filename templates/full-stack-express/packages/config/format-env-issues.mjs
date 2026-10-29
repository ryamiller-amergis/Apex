const PROBLEM_SINGULAR = 'problem';
const PROBLEM_PLURAL = 'problems';

function isSet(source, key) {
  if (source === null || typeof source !== 'object') {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(source, key)) {
    return false;
  }
  const value = source[key];
  return value !== undefined && value !== '';
}

function issueName(issue) {
  const head = issue.path?.[0];
  return typeof head === 'string' ? head : null;
}

/**
 * Formats startup validation problems. The text names each variable and never
 * prints a received value. A secret variable reads "value hidden".
 * An empty string counts as unset.
 */
export function formatEnvIssues(issues, source, secretNames) {
  const secrets =
    secretNames instanceof Set ? secretNames : new Set(secretNames ?? []);
  const linesByName = new Map();

  for (const issue of issues ?? []) {
    const name = issueName(issue);
    if (name === null || linesByName.has(name)) {
      continue;
    }
    const message =
      typeof issue.message === 'string' && issue.message !== ''
        ? issue.message
        : 'invalid';
    let detail;
    if (!isSet(source, name)) {
      detail = 'required but not set';
    } else if (secrets.has(name)) {
      detail = 'set but invalid (value hidden)';
    } else {
      detail = `set but invalid (${message})`;
    }
    linesByName.set(name, `  - ${name}: ${detail}`);
  }

  const names = [...linesByName.keys()].sort();
  const count = names.length;
  const noun = count === 1 ? PROBLEM_SINGULAR : PROBLEM_PLURAL;
  return [
    `Invalid environment configuration (${count} ${noun}):`,
    ...names.map((name) => linesByName.get(name)),
    'See .env.example for every variable.',
  ].join('\n');
}
