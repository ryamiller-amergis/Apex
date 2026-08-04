/**
 * Unit tests for Cursor SDK provider wiring in walkthroughAiDraftService (FEAT-004 step 3).
 * Verifies: model override passthrough, skillPath validation on GenerateRequest.
 */

import {
  generateProposal,
  setWalkthroughAiProviderForTests,
  type WalkthroughAiProvider,
} from '../services/walkthroughAiDraftService';
import { WalkthroughAiError } from '../../shared/types/walkthroughAiDraft';

jest.mock('@cursor/sdk', () => ({
  Agent: { create: jest.fn() },
}));

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn().mockResolvedValue({
    developmentModel: 'composer-2.5',
  }),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('composer-2.5'),
}));

jest.mock('../services/walkthroughAnchorRegistryService', () => ({
  listAuthoringAnchorEntries: jest.fn(async () => []),
  listCatalogRecordsForResolution: jest.fn(async () => []),
  getAnchorByKey: jest.fn(async () => null),
}));

import { Agent } from '@cursor/sdk';

const VALID_PROPOSAL_JSON = JSON.stringify({
  internalName: 'test-draft',
  userTitle: 'Test Draft',
  whyItMatters: 'testing',
  steps: [
    {
      heading: 'Step 1',
      bodyMarkdown: 'First',
      route: '/home',
      imageUrl: null,
      imageAlt: null,
      ctaLabel: null,
      ctaRoute: null,
      anchorKey: null,
      anchorPlacement: null,
    },
  ],
});

describe('walkthroughAiDraftService — Cursor provider wiring', () => {
  let fakeProvider: WalkthroughAiProvider;
  let callArgs: { prompt: string; modelId?: string }[];

  beforeEach(() => {
    callArgs = [];
    fakeProvider = {
      async generateStructuredJson(prompt, options) {
        callArgs.push({ prompt, modelId: options.modelId });
        return VALID_PROPOSAL_JSON;
      },
    };
    setWalkthroughAiProviderForTests(fakeProvider);
  });

  afterEach(() => {
    setWalkthroughAiProviderForTests(null);
  });

  it('AC-0 / VT-09 walkthroughAiDraftService creates and streams on SDK 1.0.24', async () => {
    // Given the production Cursor provider receives a structured streaming response.
    setWalkthroughAiProviderForTests(null);
    const stream = async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: VALID_PROPOSAL_JSON.slice(0, 40) },
            { type: 'text', text: VALID_PROPOSAL_JSON.slice(40) },
          ],
        },
      };
    };
    jest.mocked(Agent.create).mockResolvedValue({
      send: jest.fn().mockResolvedValue({
        supports: jest.fn().mockReturnValue(true),
        stream,
      }),
    } as never);
    process.env.CURSOR_API_KEY = 'test-key';

    try {
      // When the public proposal API uses its default provider.
      const proposal = await generateProposal({
        projectId: 'Apex',
        intent: 'Create a profile tour',
      });

      // Then streamed output is parsed and Apex adds no native-read tool wiring.
      expect(proposal.steps).toHaveLength(1);
      expect(jest.mocked(Agent.create)).toHaveBeenCalledWith({
        apiKey: 'test-key',
        model: { id: 'composer-2.5' },
      });
      const options = jest.mocked(Agent.create).mock.calls[0][0];
      expect(options).not.toHaveProperty('tools');
      expect(options).not.toHaveProperty('nativeTools');
    } finally {
      delete process.env.CURSOR_API_KEY;
    }
  });

  it('passes model override from request to provider', async () => {
    const proposal = await generateProposal({
      projectId: 'Apex',
      intent: 'Create a profile tour',
      model: 'gpt-4o',
    });

    expect(proposal).toBeDefined();
    expect(proposal.steps.length).toBe(1);
    expect(callArgs[0].modelId).toBe('gpt-4o');
  });

  it('falls back to project config model when no override', async () => {
    const proposal = await generateProposal({
      projectId: 'Apex',
      intent: 'Create a profile tour',
    });

    expect(proposal).toBeDefined();
    expect(callArgs[0].modelId).toBe('composer-2.5');
  });

  it('rejects empty intent', async () => {
    await expect(
      generateProposal({ projectId: 'Apex', intent: '' }),
    ).rejects.toThrow(WalkthroughAiError);
  });

  it('rejects empty projectId', async () => {
    await expect(
      generateProposal({ projectId: '', intent: 'test' }),
    ).rejects.toThrow(WalkthroughAiError);
  });
});
