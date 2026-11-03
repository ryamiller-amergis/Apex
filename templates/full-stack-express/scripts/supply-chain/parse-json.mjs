export function parseJsonText(stdout) {
  const start = stdout.search(/[[{]/);
  if (start === -1) {
    throw new Error('no json');
  }
  return JSON.parse(stdout.slice(start));
}
