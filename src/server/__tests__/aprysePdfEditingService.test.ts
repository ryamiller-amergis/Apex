import {
  AprysePdfEditingError,
  createAprysePdfEditingService,
  type ApryseSdkLoader,
} from '../services/aprysePdfEditingService';

function createSdkMock() {
  const options = {
    setPages: jest.fn().mockResolvedValue(undefined),
  };
  const doc = {
    initSecurityHandler: jest.fn().mockResolvedValue(true),
    lock: jest.fn().mockResolvedValue(undefined),
    unlock: jest.fn().mockResolvedValue(undefined),
    saveMemoryBuffer: jest.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
  };
  const PDFNet = {
    PDFDoc: {
      createFromBuffer: jest.fn().mockResolvedValue(doc),
    },
    FindReplace: {
      createFindReplaceOptions: jest.fn().mockResolvedValue(options),
      findReplaceText: jest.fn().mockResolvedValue(undefined),
    },
    SDFDoc: {
      SaveOptions: {
        e_remove_unused: 1,
      },
    },
    runWithCleanup: jest.fn(
      async (callback: () => Promise<Uint8Array>, _key: string) => callback()
    ),
    shutdown: jest.fn().mockResolvedValue(undefined),
  };
  const loadModule: ApryseSdkLoader = async () => ({ PDFNet });
  return { loadModule, PDFNet, options, doc };
}

describe('aprysePdfEditingService', () => {
  it('does not load the SDK when no license key is configured', async () => {
    const loadModule = jest.fn();
    const service = createAprysePdfEditingService({
      getLicenseKey: () => undefined,
      loadModule,
    });

    await expect(service.getStatus()).resolves.toEqual({
      configured: false,
      sdkAvailable: false,
      findReplaceAvailable: false,
      message: 'APRYSE_LICENSE_KEY is not configured.',
    });
    expect(loadModule).not.toHaveBeenCalled();
  });

  it('reports the layout-aware FindReplace capability', async () => {
    const { loadModule } = createSdkMock();
    const service = createAprysePdfEditingService({
      getLicenseKey: () => 'demo-key',
      loadModule,
    });

    await expect(service.getStatus()).resolves.toEqual({
      configured: true,
      sdkAvailable: true,
      findReplaceAvailable: true,
      message:
        'Apryse FindReplace API is available; license entitlement is validated during export.',
    });
  });

  it('applies replacements to their one-based output pages', async () => {
    const { loadModule, PDFNet, options, doc } = createSdkMock();
    const service = createAprysePdfEditingService({
      getLicenseKey: () => 'demo-key',
      loadModule,
    });

    await expect(
      service.replaceText(new Uint8Array([1, 2, 3]), [
        {
          pageNumber: 2,
          originalText: 'USD $9,000',
          replacementText: 'USD $8,500',
        },
        {
          pageNumber: 4,
          originalText: 'Old clause',
          replacementText: 'New clause',
        },
      ])
    ).resolves.toEqual(new Uint8Array([4, 5, 6]));

    expect(options.setPages).toHaveBeenNthCalledWith(1, '2');
    expect(options.setPages).toHaveBeenNthCalledWith(2, '4');
    expect(PDFNet.FindReplace.findReplaceText).toHaveBeenNthCalledWith(
      1,
      doc,
      'USD $9,000',
      'USD $8,500',
      options
    );
    expect(doc.lock).toHaveBeenCalledTimes(1);
    expect(doc.unlock).toHaveBeenCalledTimes(1);
    expect(PDFNet.shutdown).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly when the licensed FindReplace API is unavailable', async () => {
    const { loadModule: _unused, PDFNet } = createSdkMock();
    const loadModule: ApryseSdkLoader = async () => ({
      PDFNet: { ...PDFNet, FindReplace: undefined },
    });
    const service = createAprysePdfEditingService({
      getLicenseKey: () => 'base-only-key',
      loadModule,
    });

    await expect(
      service.replaceText(new Uint8Array([1]), [
        {
          pageNumber: 1,
          originalText: 'before',
          replacementText: 'after',
        },
      ])
    ).rejects.toMatchObject<Partial<AprysePdfEditingError>>({
      code: 'APRYSE_FIND_REPLACE_UNAVAILABLE',
    });
  });
});
