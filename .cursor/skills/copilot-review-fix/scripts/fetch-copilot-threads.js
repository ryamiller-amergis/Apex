#!/usr/bin/env node
/**
 * Fetch unresolved GitHub Copilot code-review threads for a PR.
 *
 * Usage (repo root):
 *   node .cursor/skills/copilot-review-fix/scripts/fetch-copilot-threads.js
 *   node .cursor/skills/copilot-review-fix/scripts/fetch-copilot-threads.js 123
 *   node .cursor/skills/copilot-review-fix/scripts/fetch-copilot-threads.js https://github.com/org/repo/pull/123
 *
 * Flags:
 *   --include-outdated   keep threads GitHub marked outdated
 *   --include-resolved   include already-resolved Copilot threads
 *
 * Prints JSON to stdout. Status lines go to stderr.
 */
const { execFileSync } = require('child_process');

const COPILOT_LOGINS = new Set([
  'copilot-pull-request-reviewer',
  'copilot-pull-request-reviewer[bot]',
]);

const QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      headRefName
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first: 20) {
            nodes {
              databaseId
              url
              body
              createdAt
              author { login }
              path
              line
            }
          }
        }
      }
    }
  }
}
`;

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) flags.add(arg);
    else positional.push(arg);
  }
  return {
    includeOutdated: flags.has('--include-outdated'),
    includeResolved: flags.has('--include-resolved'),
    target: positional[0] || null,
  };
}

function gh(args) {
  try {
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : err.message;
    console.error(stderr || 'gh command failed');
    process.exit(err.status || 1);
  }
}

function parsePrNumber(target) {
  if (!target) return null;
  const fromUrl = target.match(/\/pull\/(\d+)/);
  if (fromUrl) return Number(fromUrl[1]);
  if (/^\d+$/.test(target)) return Number(target);
  console.error(`Unrecognized PR target: ${target}`);
  process.exit(2);
}

function isCopilotLogin(login) {
  if (!login) return false;
  return COPILOT_LOGINS.has(login.toLowerCase());
}

function extractSuggestion(body) {
  const match = body.match(/```suggestion\r?\n([\s\S]*?)```/);
  return match ? match[1].replace(/\s+$/, '') : null;
}

function firstCopilotComment(thread) {
  const comments = thread.comments?.nodes || [];
  return comments.find((c) => isCopilotLogin(c.author?.login)) || null;
}

function compactThread(thread) {
  const copilot = firstCopilotComment(thread);
  const comments = thread.comments?.nodes || [];
  return {
    threadId: thread.id,
    path: thread.path || copilot?.path || null,
    line: thread.line || copilot?.line || null,
    startLine: thread.startLine || null,
    isOutdated: Boolean(thread.isOutdated),
    isResolved: Boolean(thread.isResolved),
    commentId: copilot?.databaseId || null,
    url: copilot?.url || null,
    author: copilot?.author?.login || null,
    createdAt: copilot?.createdAt || null,
    body: copilot?.body || '',
    suggestion: copilot ? extractSuggestion(copilot.body) : null,
    replyCount: Math.max(0, comments.length - 1),
  };
}

function resolvePr(target) {
  if (target) {
    return gh(['pr', 'view', String(parsePrNumber(target)), '--json', 'number,title,url,headRefName']);
  }
  return gh(['pr', 'view', '--json', 'number,title,url,headRefName']);
}

function fetchThreads(owner, name, number) {
  const nodes = [];
  let cursor = null;
  let prMeta = null;

  while (true) {
    const args = [
      'api', 'graphql',
      '-f', `query=${QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `number=${number}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    else args.push('-F', 'cursor=null');

    const result = gh(args);
    if (result.errors?.length) {
      console.error(JSON.stringify(result.errors, null, 2));
      process.exit(1);
    }

    const pr = result.data?.repository?.pullRequest;
    if (!pr) {
      console.error(`PR #${number} not found in ${owner}/${name}`);
      process.exit(1);
    }

    prMeta = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
    };
    const connection = pr.reviewThreads;
    nodes.push(...(connection.nodes || []));
    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  return { prMeta, nodes };
}

function main() {
  const { includeOutdated, includeResolved, target } = parseArgs(process.argv.slice(2));

  const repo = gh(['repo', 'view', '--json', 'nameWithOwner']);
  const [owner, name] = String(repo.nameWithOwner).split('/');
  const pr = resolvePr(target);
  const { prMeta, nodes } = fetchThreads(owner, name, pr.number);

  const copilotThreads = nodes
    .filter((thread) => firstCopilotComment(thread))
    .filter((thread) => includeResolved || !thread.isResolved)
    .filter((thread) => includeOutdated || !thread.isOutdated)
    .map(compactThread);

  const summary = {
    pr: prMeta,
    repo: `${owner}/${name}`,
    includeOutdated,
    includeResolved,
    totalReviewThreads: nodes.length,
    copilotUnresolved: copilotThreads.length,
    threads: copilotThreads,
  };

  process.stderr.write(
    `PR #${prMeta.number}: ${copilotThreads.length} Copilot thread(s) to triage ` +
      `(${nodes.length} review threads total)\n`
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
