/**
 * Generic ADO file/tree fetcher.
 *
 * Replaces the MaxView-hardcoded `fetchRawFileFromADO` in bedrockService and
 * `fetchAdoFile` in designSystemService with a single parameterised helper that
 * works for any project/repo/branch combination resolved from project skill config.
 */

import https from 'https';

/** Fetch a single file from any ADO git repo. Returns the raw text content. */
export function fetchAdoFileGeneric(
  orgUrl: string,
  pat: string,
  adoProject: string,
  repo: string,
  filePath: string,
  branch = 'main',
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${pat}`).toString('base64');
    const encodedPath = encodeURIComponent(filePath);
    const encodedBranch = encodeURIComponent(branch);
    const apiUrl = new URL(
      `${orgUrl}/${adoProject}/_apis/git/repositories/${repo}/items` +
      `?path=${encodedPath}&versionDescriptor.versionType=branch&versionDescriptor.version=${encodedBranch}` +
      `&api-version=7.1&$format=text`,
    );
    const options: https.RequestOptions = {
      hostname: apiUrl.hostname,
      path: apiUrl.pathname + apiUrl.search,
      method: 'GET',
      headers: { Authorization: `Basic ${token}`, Accept: 'text/plain' },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`ADO ${res.statusCode} fetching ${filePath} from ${repo}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${filePath} from ${repo}`));
    });
    req.end();
  });
}

/** Fetch a folder listing from any ADO git repo. Returns item paths. */
export function fetchAdoTreeGeneric(
  orgUrl: string,
  pat: string,
  adoProject: string,
  repo: string,
  folderPath: string,
  branch = 'main',
  recursionLevel: 'OneLevel' | 'Full' = 'OneLevel',
  timeoutMs = 10_000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${pat}`).toString('base64');
    const encodedPath = encodeURIComponent(folderPath);
    const encodedBranch = encodeURIComponent(branch);
    const apiUrl = new URL(
      `${orgUrl}/${adoProject}/_apis/git/repositories/${repo}/items` +
      `?scopePath=${encodedPath}&recursionLevel=${recursionLevel}` +
      `&versionDescriptor.versionType=branch&versionDescriptor.version=${encodedBranch}` +
      `&api-version=7.1`,
    );
    const options: https.RequestOptions = {
      hostname: apiUrl.hostname,
      path: apiUrl.pathname + apiUrl.search,
      method: 'GET',
      headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`ADO ${res.statusCode} listing ${folderPath} from ${repo}`));
          return;
        }
        try {
          const json = JSON.parse(data) as { value?: Array<{ path: string }> };
          resolve((json.value ?? []).map((item) => item.path));
        } catch {
          reject(new Error('ADO tree response was not valid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout listing ${folderPath} from ${repo}`));
    });
    req.end();
  });
}
