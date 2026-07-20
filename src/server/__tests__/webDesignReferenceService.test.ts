import { getDesignReferences, clearDesignReferenceCache } from '../services/webDesignReferenceService';
import https from 'https';

jest.mock('https');

const mockHttps = https as jest.Mocked<typeof https>;

function makeMockReq(statusCode: number, responseBody: string) {
  const mockRes: any = {
    statusCode,
    on: jest.fn((event: string, cb: (chunk?: Buffer) => void) => {
      if (event === 'data') cb(Buffer.from(responseBody));
      if (event === 'end') cb();
      return mockRes;
    }),
  };
  const mockReq: any = {
    on: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    write: jest.fn().mockReturnThis(),
    end: jest.fn(() => { /* noop */ }),
    destroy: jest.fn(),
  };
  mockHttps.request.mockImplementation((_opts: any, cb: any) => {
    cb(mockRes);
    return mockReq;
  });
}

describe('webDesignReferenceService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearDesignReferenceCache();
    process.env.TAVILY_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.TAVILY_API_KEY;
  });

  describe('getDesignReferences', () => {
    it('returns a distilled markdown block on success', async () => {
      const tavilyResponse = JSON.stringify({
        results: [
          { title: 'Credential Upload Pattern', url: 'https://example.com/pattern', content: 'A clean drag-and-drop credential upload UI with progress indicators.' },
          { title: 'File Upload UX', url: 'https://example.com/ux', content: 'Best practices for file upload flows.' },
        ],
      });
      makeMockReq(200, tavilyResponse);

      const result = await getDesignReferences({
        featureName: 'Credential Upload',
        designSystemName: 'Amego',
      });

      expect(result).toContain('Credential Upload Pattern');
      expect(result).toContain('File Upload UX');
      expect(result).toContain('https://example.com/pattern');
    });

    it('returns empty string when TAVILY_API_KEY is not set', async () => {
      delete process.env.TAVILY_API_KEY;

      const result = await getDesignReferences({
        featureName: 'Any Feature',
        designSystemName: 'Amego',
      });

      expect(result).toBe('');
      expect(mockHttps.request).not.toHaveBeenCalled();
    });

    it('returns empty string and does not throw when Tavily returns an error status', async () => {
      makeMockReq(429, '{}');

      const result = await getDesignReferences({
        featureName: 'Feature',
        designSystemName: 'Amego',
      });

      expect(result).toBe('');
    });

    it('returns empty string and does not throw on network error', async () => {
      const mockReq: any = {
        on: jest.fn((event: string, cb: (err: Error) => void) => {
          if (event === 'error') cb(new Error('ECONNREFUSED'));
          return mockReq;
        }),
        setTimeout: jest.fn().mockReturnThis(),
        write: jest.fn().mockReturnThis(),
        end: jest.fn(),
        destroy: jest.fn(),
      };
      mockHttps.request.mockReturnValue(mockReq);

      const result = await getDesignReferences({
        featureName: 'Feature',
        designSystemName: 'Amego',
      });

      expect(result).toBe('');
    });

    it('uses the cache on repeated calls with the same inputs', async () => {
      const tavilyResponse = JSON.stringify({
        results: [{ title: 'Cached Pattern', url: 'https://example.com', content: 'Cached.' }],
      });
      makeMockReq(200, tavilyResponse);

      await getDesignReferences({ featureName: 'Feature', designSystemName: 'Amego' });
      await getDesignReferences({ featureName: 'Feature', designSystemName: 'Amego' });

      // Second call should use cache — only one HTTP request fired
      expect(mockHttps.request).toHaveBeenCalledTimes(1);
    });

    it('returns empty list gracefully when results array is missing', async () => {
      makeMockReq(200, JSON.stringify({ answer: 'no results key' }));

      const result = await getDesignReferences({ featureName: 'Feature', designSystemName: 'Amego' });

      expect(result).toBe('');
    });
  });
});
