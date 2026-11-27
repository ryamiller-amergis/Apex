const queryWorkItemsByWiql = jest.fn();
const createWorkItemForPrd = jest.fn();
const addWorkItemComment = jest.fn();
const createPullRequest = jest.fn();
jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn().mockImplementation(() => ({
    queryWorkItemsByWiql,
    createWorkItemForPrd,
    addWorkItemComment,
    createPullRequest,
  })),
}));

import {
  ADO_OPERATIONS,
  ADO_WRITE_OPERATIONS,
  buildProjectUrl,
} from '../services/adoConnectorOperations';
import { playbookConnectorHandlerKeys } from '../services/playbookConnectorHandlers';
import { PLAYBOOK_CONNECTORS } from '../../shared/types/playbookConnectors';

const ORG = 'https://dev.azure.com/acme';

function respond(body: unknown, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  });
}

describe('connector catalog and handlers', () => {
  it('has a handler for every operation that is not recordsOnly, and none for those that are', () => {
    const handled = new Set(playbookConnectorHandlerKeys());
    for (const connector of PLAYBOOK_CONNECTORS) {
      for (const operation of connector.operations) {
        const key = `${connector.id}/${operation.id}`;
        expect({ key, handled: handled.has(key) }).toEqual({ key, handled: !operation.recordsOnly });
      }
    }
  });

  it('declares every operation read or write', () => {
    for (const connector of PLAYBOOK_CONNECTORS) {
      for (const operation of connector.operations) {
        expect(['read', 'write']).toContain(operation.access);
      }
    }
  });

  it('keeps every Azure DevOps read operation a read', () => {
    const ado = PLAYBOOK_CONNECTORS.find((connector) => connector.id === 'azure-devops')!;
    for (const id of Object.keys(ADO_OPERATIONS)) {
      expect(ado.operations.find((operation) => operation.id === id)?.access).toBe('read');
    }
  });

  it('keeps every Azure DevOps write operation a write, so the guard and allow-list apply', () => {
    const ado = PLAYBOOK_CONNECTORS.find((connector) => connector.id === 'azure-devops')!;
    for (const id of Object.keys(ADO_WRITE_OPERATIONS)) {
      expect(ado.operations.find((operation) => operation.id === id)?.access).toBe('write');
    }
    expect(Object.keys(ADO_WRITE_OPERATIONS).filter((id) => id in ADO_OPERATIONS)).toEqual([]);
  });
});

describe('buildProjectUrl', () => {
  it('builds a URL under the run project and adds the api-version', () => {
    const url = buildProjectUrl(ORG, 'MaxView', '_apis/git/repositories');
    expect(url.toString()).toBe(`${ORG}/MaxView/_apis/git/repositories?api-version=7.1`);
  });

  it('keeps an api-version the caller set', () => {
    const url = buildProjectUrl(ORG, 'My Project', '_apis/projects?api-version=6.0');
    expect(url.pathname).toBe('/acme/My%20Project/_apis/projects');
    expect(url.searchParams.get('api-version')).toBe('6.0');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/_apis/x'],
    ['a protocol-relative URL', '//evil.example/_apis/x'],
    ['a leading slash', '/_apis/projects'],
    ['a parent segment', '../Other/_apis/projects'],
    ['an encoded parent segment', '%2e%2e/Other/_apis/projects'],
    ['a backslash', '..\\Other\\_apis'],
    ['an empty path', '   '],
  ])('refuses %s', (_label, path) => {
    expect(() => buildProjectUrl(ORG, 'MaxView', path)).toThrow();
  });
});

describe('Azure DevOps read operations', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADO_ORG = `${ORG}/`;
    process.env.ADO_PAT = 'server-pat';
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  function lastUrl(): URL {
    const calls = fetchMock.mock.calls;
    return new URL(String(calls[calls.length - 1][0]));
  }

  it('sends the server credential in a Basic header and the run project in the path', async () => {
    fetchMock.mockResolvedValue(respond({ value: [] }));

    await ADO_OPERATIONS['list-repositories']({ project: 'MaxView', parameters: {} });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from(':server-pat').toString('base64')}`);
    expect(lastUrl().pathname).toBe('/acme/MaxView/_apis/git/repositories');
  });

  it('lists branches by prefix without knowing any naming scheme', async () => {
    fetchMock.mockResolvedValue(respond({
      value: [{ name: 'refs/heads/Release/2026.17.0' }, { name: 'refs/heads/Release/2026.16.0' }],
    }));

    const result = await ADO_OPERATIONS['list-branches']({
      project: 'MaxView',
      parameters: { repository: 'api', startsWith: 'Release/' },
    });

    expect(lastUrl().pathname).toBe('/acme/MaxView/_apis/git/repositories/api/refs');
    expect(lastUrl().searchParams.get('filter')).toBe('heads/Release/');
    expect(JSON.parse(result)).toEqual(['Release/2026.16.0', 'Release/2026.17.0']);
  });

  it('lists tags under the tags filter', async () => {
    fetchMock.mockResolvedValue(respond({ value: [{ name: 'refs/tags/v1.2.0' }] }));

    const result = await ADO_OPERATIONS['list-tags']({
      project: 'Apex',
      parameters: { repository: 'web' },
    });

    expect(lastUrl().searchParams.get('filter')).toBe('tags/');
    expect(JSON.parse(result)).toEqual(['v1.2.0']);
  });

  it('lists completed pull requests into a branch and trims them to what a step needs', async () => {
    fetchMock.mockResolvedValue(respond({
      value: [{
        pullRequestId: 42,
        title: 'Fix totals',
        status: 'completed',
        createdBy: { displayName: 'Ada', imageUrl: 'ignored' },
        sourceRefName: 'refs/heads/fix/totals',
        targetRefName: 'refs/heads/main',
        creationDate: '2026-01-01T00:00:00Z',
        closedDate: '2026-01-02T00:00:00Z',
      }],
    }));

    const result = JSON.parse(await ADO_OPERATIONS['list-pull-requests']({
      project: 'MaxView',
      parameters: { repository: 'api', targetBranch: 'main', top: '9999' },
    }));

    const query = lastUrl().searchParams;
    expect(query.get('searchCriteria.status')).toBe('completed');
    expect(query.get('searchCriteria.targetRefName')).toBe('refs/heads/main');
    expect(query.get('$top')).toBe('500');
    expect(result).toEqual([expect.objectContaining({
      id: 42,
      title: 'Fix totals',
      createdBy: 'Ada',
      sourceBranch: 'fix/totals',
      targetBranch: 'main',
      url: `${ORG}/MaxView/_git/api/pullrequest/42`,
    })]);
    expect(JSON.stringify(result)).not.toContain('imageUrl');
  });

  it('refuses a pull request status it does not know', async () => {
    await expect(ADO_OPERATIONS['list-pull-requests']({
      project: 'MaxView',
      parameters: { repository: 'api', status: 'merged' },
    })).rejects.toThrow(/Status must be/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gets a pull request with its linked work items, and survives a failed link read', async () => {
    fetchMock
      .mockResolvedValueOnce(respond({
        pullRequestId: 7,
        title: 'Add export',
        description: 'Adds CSV export.',
        reviewers: [{ displayName: 'Grace', vote: 10, isRequired: true }],
      }))
      .mockResolvedValueOnce(respond('nope', { status: 500, contentType: 'text/plain' }));

    const result = JSON.parse(await ADO_OPERATIONS['get-pull-request']({
      project: 'MaxView',
      parameters: { repository: 'api', pullRequestId: '7' },
    }));

    expect(result).toEqual(expect.objectContaining({
      id: 7,
      description: 'Adds CSV export.',
      reviewers: [{ name: 'Grace', vote: 10, isRequired: true }],
      workItemIds: [],
    }));
  });

  it('gets one work item with its links', async () => {
    fetchMock.mockResolvedValue(respond({
      id: 55,
      fields: { 'System.Title': 'Broken export' },
      relations: [{ rel: 'ArtifactLink', url: 'vstfs:///x', attributes: { name: 'drop' } }],
    }));

    const result = JSON.parse(await ADO_OPERATIONS['get-work-item']({
      project: 'MaxView',
      parameters: { workItemId: '55' },
    }));

    expect(lastUrl().pathname).toBe('/acme/MaxView/_apis/wit/workitems/55');
    expect(result.relations).toEqual([{ rel: 'ArtifactLink', url: 'vstfs:///x' }]);
  });

  it('refuses a work item number that is not a whole number', async () => {
    await expect(ADO_OPERATIONS['get-work-item']({
      project: 'MaxView',
      parameters: { workItemId: '5; DROP' },
    })).rejects.toThrow(/whole number/);
  });

  it('queries work items through the project-scoped service', async () => {
    queryWorkItemsByWiql.mockResolvedValue({
      totalMatched: 1,
      returned: 1,
      ids: [9],
      items: [{ id: 9, fields: { 'System.Title': 'Open bug' }, url: 'ignored' }],
    });

    const result = JSON.parse(await ADO_OPERATIONS['query-work-items']({
      project: 'MaxView',
      parameters: { wiql: 'SELECT [System.Id] FROM WorkItems', fields: 'System.Title, System.State', maxResults: '5' },
    }));

    expect(queryWorkItemsByWiql).toHaveBeenCalledWith({
      wiql: 'SELECT [System.Id] FROM WorkItems',
      fields: ['System.Title', 'System.State'],
      maxResults: 5,
    });
    expect(result.items).toEqual([{ id: 9, fields: { 'System.Title': 'Open bug' } }]);
  });

  it('reads any path in the project with rest-get', async () => {
    fetchMock.mockResolvedValue(respond({ count: 1, value: [{ id: 'build-1' }] }));

    const result = JSON.parse(await ADO_OPERATIONS['rest-get']({
      project: 'MaxView',
      parameters: { path: '_apis/build/builds?$top=1' },
    }));

    expect(lastUrl().pathname).toBe('/acme/MaxView/_apis/build/builds');
    expect(result.value[0].id).toBe('build-1');
  });

  it('refuses a rest-get path that leaves the project', async () => {
    await expect(ADO_OPERATIONS['rest-get']({
      project: 'MaxView',
      parameters: { path: '../Other/_apis/projects' },
    })).rejects.toThrow(/inside this project/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an Azure DevOps error with its status and path', async () => {
    fetchMock.mockResolvedValue(respond('Repository not found', { status: 404, contentType: 'text/plain' }));

    await expect(ADO_OPERATIONS['list-branches']({
      project: 'MaxView',
      parameters: { repository: 'missing' },
    })).rejects.toThrow(/answered 404 for \/acme\/MaxView\/_apis\/git\/repositories\/missing\/refs/);
  });

  it('treats a sign-in page as a credential problem', async () => {
    fetchMock.mockResolvedValue(respond('<html>Sign in</html>', { status: 203, contentType: 'text/html' }));

    await expect(ADO_OPERATIONS['list-repositories']({ project: 'MaxView', parameters: {} }))
      .rejects.toThrow(/credentials may be invalid/);
  });

  it('says so when the server has no Azure DevOps credentials', async () => {
    delete process.env.ADO_PAT;

    await expect(ADO_OPERATIONS['list-repositories']({ project: 'MaxView', parameters: {} }))
      .rejects.toThrow(/not configured/);
  });

  describe('write operations', () => {
    it('creates a work item for the run project and returns its id and link', async () => {
      createWorkItemForPrd.mockResolvedValue({ id: 321, url: `${ORG}/MaxView/_workitems/edit/321` });

      const result = JSON.parse(await ADO_WRITE_OPERATIONS['create-work-item']({
        project: 'MaxView',
        parameters: { workItemType: 'Product Backlog Item', title: 'Add export', description: 'Some **text**' },
      }));

      expect(createWorkItemForPrd).toHaveBeenCalledWith(expect.objectContaining({
        type: 'Product Backlog Item',
        title: 'Add export',
        description: expect.stringContaining('<'),
        reproStepsHtml: undefined,
      }));
      expect(result).toEqual({ id: 321, url: `${ORG}/MaxView/_workitems/edit/321` });
    });

    it('puts a bug description in Repro Steps too', async () => {
      createWorkItemForPrd.mockResolvedValue({ id: 1, url: 'u' });

      await ADO_WRITE_OPERATIONS['create-work-item']({
        project: 'MaxView',
        parameters: { workItemType: 'Bug', title: 'Crash', description: 'Steps' },
      });

      const call = createWorkItemForPrd.mock.calls[0][0];
      expect(call.reproStepsHtml).toBe(call.description);
      expect(call.reproStepsHtml).toBeTruthy();
    });

    it('requires a title', async () => {
      await expect(ADO_WRITE_OPERATIONS['create-work-item']({
        project: 'MaxView',
        parameters: { workItemType: 'Bug', title: ' ' },
      })).rejects.toThrow(/Title is required/);
      expect(createWorkItemForPrd).not.toHaveBeenCalled();
    });

    it('updates work item fields with a JSON patch', async () => {
      fetchMock.mockResolvedValue(respond({ id: 12, rev: 4 }));

      const result = JSON.parse(await ADO_WRITE_OPERATIONS['update-work-item']({
        project: 'MaxView',
        parameters: { workItemId: '12', fields: '{"System.State": "Resolved", "Custom.Risk": 3}' },
      }));

      const [url, init] = fetchMock.mock.calls[0];
      expect(new URL(String(url)).pathname).toBe('/acme/MaxView/_apis/wit/workitems/12');
      expect(init.method).toBe('PATCH');
      expect(init.headers['Content-Type']).toBe('application/json-patch+json');
      expect(JSON.parse(init.body)).toEqual([
        { op: 'add', path: '/fields/System.State', value: 'Resolved' },
        { op: 'add', path: '/fields/Custom.Risk', value: 3 },
      ]);
      expect(result).toEqual({ id: 12, rev: 4 });
    });

    it.each([
      ['not JSON', 'System.State=Resolved', /JSON object/],
      ['a list', '["System.State"]', /JSON object/],
      ['empty', '{}', /nothing to set/],
      ['a field name that is a path', '{"/fields/../x": 1}', /is not a field name/],
      ['a field name with no namespace', '{"State": "Done"}', /is not a field name/],
    ])('refuses update fields that are %s', async (_label, fields, message) => {
      await expect(ADO_WRITE_OPERATIONS['update-work-item']({
        project: 'MaxView',
        parameters: { workItemId: '12', fields },
      })).rejects.toThrow(message);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts a comment on a work item', async () => {
      addWorkItemComment.mockResolvedValue({ id: 77 });

      const result = JSON.parse(await ADO_WRITE_OPERATIONS['post-comment']({
        project: 'MaxView',
        parameters: { workItemId: '12', text: 'Shipped in 2026.17.0' },
      }));

      expect(addWorkItemComment).toHaveBeenCalledWith(12, 'Shipped in 2026.17.0');
      expect(result).toEqual({ commentId: 77, workItemId: 12 });
    });

    it('creates a pull request between two branches the playbook names', async () => {
      createPullRequest.mockResolvedValue(`${ORG}/MaxView/_git/api/pullrequest/9`);

      const result = JSON.parse(await ADO_WRITE_OPERATIONS['create-pull-request']({
        project: 'MaxView',
        parameters: {
          repository: 'api',
          sourceBranch: 'Release/2026.17.0',
          targetBranch: 'main',
          title: 'Merge release',
          workItemId: '55',
          draft: 'TRUE',
        },
      }));

      expect(createPullRequest).toHaveBeenCalledWith({
        repo: 'api',
        project: 'MaxView',
        sourceBranch: 'Release/2026.17.0',
        targetBranch: 'main',
        title: 'Merge release',
        description: '',
        workItemId: 55,
        isDraft: true,
      });
      expect(result).toEqual({ url: `${ORG}/MaxView/_git/api/pullrequest/9` });
    });

    it('refuses a draft value that is not true or false', async () => {
      await expect(ADO_WRITE_OPERATIONS['create-pull-request']({
        project: 'MaxView',
        parameters: { repository: 'api', sourceBranch: 'a', targetBranch: 'b', title: 't', draft: 'maybe' },
      })).rejects.toThrow(/Draft must be/);
      expect(createPullRequest).not.toHaveBeenCalled();
    });

    it('sends a generic write to a path inside the project', async () => {
      fetchMock.mockResolvedValue(respond({ id: 5 }));

      await ADO_WRITE_OPERATIONS['rest-write']({
        project: 'MaxView',
        parameters: { method: 'post', path: '_apis/wit/workitems/$Task', body: '[{"op":"add"}]', contentType: 'application/json-patch+json' },
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(new URL(String(url)).pathname).toBe('/acme/MaxView/_apis/wit/workitems/$Task');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json-patch+json');
      expect(init.body).toBe('[{"op":"add"}]');
    });

    it('reports ok when a generic write returns no body', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      const result = await ADO_WRITE_OPERATIONS['rest-write']({
        project: 'MaxView',
        parameters: { method: 'DELETE', path: '_apis/wit/workitems/9' },
      });

      expect(JSON.parse(result)).toEqual({ status: 'ok' });
    });

    it.each([
      ['GET', /Method must be POST/],
      ['TRACE', /Method must be POST/],
    ])('refuses the method %s in a generic write', async (method, message) => {
      await expect(ADO_WRITE_OPERATIONS['rest-write']({
        project: 'MaxView',
        parameters: { method, path: '_apis/projects' },
      })).rejects.toThrow(message);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a generic write path that leaves the project', async () => {
      await expect(ADO_WRITE_OPERATIONS['rest-write']({
        project: 'MaxView',
        parameters: { method: 'POST', path: '../Other/_apis/wit/workitems/$Bug', body: '[]' },
      })).rejects.toThrow(/inside this project/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a body that is not JSON and a content type outside the two allowed', async () => {
      await expect(ADO_WRITE_OPERATIONS['rest-write']({
        project: 'MaxView',
        parameters: { method: 'POST', path: '_apis/x', body: 'not json' },
      })).rejects.toThrow(/valid JSON/);
      await expect(ADO_WRITE_OPERATIONS['rest-write']({
        project: 'MaxView',
        parameters: { method: 'POST', path: '_apis/x', body: '{}', contentType: 'text/html' },
      })).rejects.toThrow(/Content type must be/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
