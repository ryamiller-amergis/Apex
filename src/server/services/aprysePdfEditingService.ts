export interface ApryseTextReplacement {
  /** One-based page number in the assembled output PDF. */
  pageNumber: number;
  originalText: string;
  replacementText: string;
}

export interface ApryseCapabilityStatus {
  configured: boolean;
  sdkAvailable: boolean;
  findReplaceAvailable: boolean;
  message: string;
}

interface ApryseFindReplaceOptionsLike {
  setPages(pages: string): Promise<void> | void;
}

interface AprysePdfDocLike {
  initSecurityHandler(): Promise<boolean> | boolean;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  saveMemoryBuffer(flags: number): Promise<Uint8Array>;
}

interface ApryseFindReplaceLike {
  createFindReplaceOptions(): Promise<ApryseFindReplaceOptionsLike>;
  findReplaceText(
    document: AprysePdfDocLike,
    from: string,
    to: string,
    options: ApryseFindReplaceOptionsLike
  ): Promise<void>;
}

interface AprysePdfNetLike {
  PDFDoc: {
    createFromBuffer(bytes: Uint8Array): Promise<AprysePdfDocLike>;
  };
  FindReplace?: ApryseFindReplaceLike;
  SDFDoc: {
    SaveOptions: {
      e_remove_unused: number;
    };
  };
  runWithCleanup(
    callback: () => Promise<Uint8Array>,
    licenseKey: string
  ): Promise<Uint8Array>;
  shutdown(): Promise<void>;
}

export interface ApryseSdkModuleLike {
  PDFNet: AprysePdfNetLike;
}

export type ApryseSdkLoader = () => Promise<ApryseSdkModuleLike>;

interface AprysePdfEditingDependencies {
  getLicenseKey: () => string | undefined;
  loadModule: ApryseSdkLoader;
}

export class AprysePdfEditingError extends Error {
  constructor(
    public readonly code:
      | 'APRYSE_NOT_CONFIGURED'
      | 'APRYSE_SDK_UNAVAILABLE'
      | 'APRYSE_FIND_REPLACE_UNAVAILABLE'
      | 'APRYSE_EDIT_FAILED',
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = 'AprysePdfEditingError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

const defaultDependencies: AprysePdfEditingDependencies = {
  getLicenseKey: () => process.env.APRYSE_LICENSE_KEY?.trim() || undefined,
  loadModule: async () =>
    (await import('@pdftron/pdfnet-node')) as unknown as ApryseSdkModuleLike,
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown Apryse SDK error';
}

export function createAprysePdfEditingService(
  dependencies: AprysePdfEditingDependencies = defaultDependencies
) {
  const isConfigured = (): boolean =>
    Boolean(dependencies.getLicenseKey()?.trim());

  const loadConfiguredSdk = async (): Promise<ApryseSdkModuleLike> => {
    const key = dependencies.getLicenseKey()?.trim();
    if (!key) {
      throw new AprysePdfEditingError(
        'APRYSE_NOT_CONFIGURED',
        'APRYSE_LICENSE_KEY is not configured.'
      );
    }
    try {
      return await dependencies.loadModule();
    } catch (error) {
      throw new AprysePdfEditingError(
        'APRYSE_SDK_UNAVAILABLE',
        `Apryse Node SDK could not be loaded: ${messageFrom(error)}`,
        error
      );
    }
  };

  const getStatus = async (): Promise<ApryseCapabilityStatus> => {
    if (!isConfigured()) {
      return {
        configured: false,
        sdkAvailable: false,
        findReplaceAvailable: false,
        message: 'APRYSE_LICENSE_KEY is not configured.',
      };
    }
    try {
      const { PDFNet } = await loadConfiguredSdk();
      const findReplaceAvailable =
        typeof PDFNet.FindReplace?.createFindReplaceOptions === 'function' &&
        typeof PDFNet.FindReplace?.findReplaceText === 'function';
      return {
        configured: true,
        sdkAvailable: true,
        findReplaceAvailable,
        message: findReplaceAvailable
          ? 'Apryse FindReplace API is available; license entitlement is validated during export.'
          : 'Apryse SDK loaded, but FindReplace is unavailable.',
      };
    } catch (error) {
      return {
        configured: true,
        sdkAvailable: false,
        findReplaceAvailable: false,
        message: messageFrom(error),
      };
    }
  };

  const replaceText = async (
    pdfBytes: Uint8Array,
    replacements: ApryseTextReplacement[]
  ): Promise<Uint8Array> => {
    if (replacements.length === 0) return new Uint8Array(pdfBytes);
    const key = dependencies.getLicenseKey()?.trim();
    if (!key) {
      throw new AprysePdfEditingError(
        'APRYSE_NOT_CONFIGURED',
        'APRYSE_LICENSE_KEY is not configured.'
      );
    }
    const { PDFNet } = await loadConfiguredSdk();
    const findReplace = PDFNet.FindReplace;
    if (!findReplace) {
      throw new AprysePdfEditingError(
        'APRYSE_FIND_REPLACE_UNAVAILABLE',
        'Apryse FindReplace is unavailable. Enable the Server SDK PDF Editing add-on and use a compatible SDK build.'
      );
    }

    try {
      return await PDFNet.runWithCleanup(async () => {
        const document = await PDFNet.PDFDoc.createFromBuffer(pdfBytes);
        await document.initSecurityHandler();
        for (const replacement of replacements) {
          const options = await findReplace.createFindReplaceOptions();
          await options.setPages(String(replacement.pageNumber));
          await findReplace.findReplaceText(
            document,
            replacement.originalText,
            replacement.replacementText,
            options
          );
        }

        await document.lock();
        try {
          return await document.saveMemoryBuffer(
            PDFNet.SDFDoc.SaveOptions.e_remove_unused
          );
        } finally {
          await document.unlock();
        }
      }, key);
    } catch (error) {
      if (error instanceof AprysePdfEditingError) throw error;
      throw new AprysePdfEditingError(
        'APRYSE_EDIT_FAILED',
        `Apryse PDF text replacement failed: ${messageFrom(error)}`,
        error
      );
    } finally {
      await PDFNet.shutdown();
    }
  };

  return { isConfigured, getStatus, replaceText };
}

export const aprysePdfEditingService = createAprysePdfEditingService();
