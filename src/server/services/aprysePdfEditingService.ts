import path from 'path';

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
  pdfToOfficeAvailable: boolean;
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

interface ApryseFilterReaderLike {
  read(bufSize: number): Promise<Uint8Array | null>;
}

/** Opaque Apryse filter handle returned by Convert.toWordWithFilter. */
type ApryseFilterLike = object;

interface ApryseConvertLike {
  toWordWithFilter(
    document: AprysePdfDocLike,
    options?: unknown
  ): Promise<ApryseFilterLike>;
}

interface AprysePdfNetLike {
  PDFDoc: {
    createFromBuffer(bytes: Uint8Array): Promise<AprysePdfDocLike>;
  };
  FindReplace?: ApryseFindReplaceLike;
  Convert?: ApryseConvertLike;
  StructuredOutputModule?: {
    isModuleAvailable(): Promise<boolean>;
  };
  FilterReader?: {
    create(filter: ApryseFilterLike): Promise<ApryseFilterReaderLike>;
  };
  SDFDoc: {
    SaveOptions: {
      e_remove_unused: number;
    };
  };
  addResourceSearchPath?(resourcePath: string): Promise<void>;
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
  /** Directory containing the Structured Output add-on (Lib/*.dll, etc.). */
  getResourceSearchPath: () => string | undefined;
}

export class AprysePdfEditingError extends Error {
  constructor(
    public readonly code:
      | 'APRYSE_NOT_CONFIGURED'
      | 'APRYSE_SDK_UNAVAILABLE'
      | 'APRYSE_FIND_REPLACE_UNAVAILABLE'
      | 'APRYSE_PDF_TO_OFFICE_UNAVAILABLE'
      | 'APRYSE_EDIT_FAILED'
      | 'APRYSE_CONVERT_FAILED',
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
  getResourceSearchPath: () => {
    const configured = process.env.APRYSE_RESOURCE_SEARCH_PATH?.trim();
    if (configured) return configured;
    // Default: repo-root apryse-modules/ (gitignored). Place Structured Output Lib here.
    return path.join(process.cwd(), 'apryse-modules');
  },
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

  const prepareResourceSearchPath = async (
    PDFNet: AprysePdfNetLike
  ): Promise<void> => {
    const resourcePath = dependencies.getResourceSearchPath()?.trim();
    if (!resourcePath || typeof PDFNet.addResourceSearchPath !== 'function') {
      return;
    }
    await PDFNet.addResourceSearchPath(resourcePath);
  };

  const probePdfToOfficeAvailable = async (
    PDFNet: AprysePdfNetLike
  ): Promise<boolean> => {
    await prepareResourceSearchPath(PDFNet);
    if (typeof PDFNet.StructuredOutputModule?.isModuleAvailable === 'function') {
      try {
        return await PDFNet.StructuredOutputModule.isModuleAvailable();
      } catch {
        return false;
      }
    }
    return (
      typeof PDFNet.Convert?.toWordWithFilter === 'function' &&
      typeof PDFNet.FilterReader?.create === 'function'
    );
  };

  const getStatus = async (): Promise<ApryseCapabilityStatus> => {
    if (!isConfigured()) {
      return {
        configured: false,
        sdkAvailable: false,
        findReplaceAvailable: false,
        pdfToOfficeAvailable: false,
        message: 'APRYSE_LICENSE_KEY is not configured.',
      };
    }
    try {
      const { PDFNet } = await loadConfiguredSdk();
      const findReplaceAvailable =
        typeof PDFNet.FindReplace?.createFindReplaceOptions === 'function' &&
        typeof PDFNet.FindReplace?.findReplaceText === 'function';
      const pdfToOfficeAvailable = await probePdfToOfficeAvailable(PDFNet);
      const parts: string[] = [];
      if (findReplaceAvailable) {
        parts.push('FindReplace available');
      } else {
        parts.push('FindReplace unavailable');
      }
      if (pdfToOfficeAvailable) {
        parts.push('PDF→Office (Structured Output) available');
      } else {
        parts.push(
          'PDF→Office unavailable — install Structured Output into apryse-modules/ (or set APRYSE_RESOURCE_SEARCH_PATH)'
        );
      }
      return {
        configured: true,
        sdkAvailable: true,
        findReplaceAvailable,
        pdfToOfficeAvailable,
        message: `Apryse SDK loaded; ${parts.join('; ')}. License entitlement is validated during use.`,
      };
    } catch (error) {
      return {
        configured: true,
        sdkAvailable: false,
        findReplaceAvailable: false,
        pdfToOfficeAvailable: false,
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

  const readFilterToBuffer = async (
    PDFNet: AprysePdfNetLike,
    filter: ApryseFilterLike
  ): Promise<Uint8Array> => {
    if (typeof PDFNet.FilterReader?.create !== 'function') {
      throw new AprysePdfEditingError(
        'APRYSE_PDF_TO_OFFICE_UNAVAILABLE',
        'Apryse FilterReader is unavailable; cannot read converted Office output.'
      );
    }
    const reader = await PDFNet.FilterReader.create(filter);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await reader.read(64 * 1024);
      if (!chunk || chunk.length === 0) break;
      chunks.push(chunk);
      total += chunk.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  };

  const convertToWord = async (pdfBytes: Uint8Array): Promise<Uint8Array> => {
    const key = dependencies.getLicenseKey()?.trim();
    if (!key) {
      throw new AprysePdfEditingError(
        'APRYSE_NOT_CONFIGURED',
        'APRYSE_LICENSE_KEY is not configured.'
      );
    }
    const { PDFNet } = await loadConfiguredSdk();
    try {
      return await PDFNet.runWithCleanup(async () => {
        await prepareResourceSearchPath(PDFNet);
        const moduleAvailable =
          typeof PDFNet.StructuredOutputModule?.isModuleAvailable === 'function'
            ? await PDFNet.StructuredOutputModule.isModuleAvailable()
            : false;
        if (
          !moduleAvailable ||
          typeof PDFNet.Convert?.toWordWithFilter !== 'function'
        ) {
          throw new AprysePdfEditingError(
            'APRYSE_PDF_TO_OFFICE_UNAVAILABLE',
            'Apryse Structured Output module is unavailable. Download the Windows Structured Output module from Apryse, extract it into apryse-modules/ (so Lib/ is present), or set APRYSE_RESOURCE_SEARCH_PATH to that folder.'
          );
        }

        const document = await PDFNet.PDFDoc.createFromBuffer(pdfBytes);
        await document.initSecurityHandler();
        const filter = await PDFNet.Convert.toWordWithFilter(document);
        return readFilterToBuffer(PDFNet, filter);
      }, key);
    } catch (error) {
      if (error instanceof AprysePdfEditingError) throw error;
      throw new AprysePdfEditingError(
        'APRYSE_CONVERT_FAILED',
        `Apryse PDF→Word conversion failed: ${messageFrom(error)}`,
        error
      );
    } finally {
      await PDFNet.shutdown();
    }
  };

  return { isConfigured, getStatus, replaceText, convertToWord };
}

export const aprysePdfEditingService = createAprysePdfEditingService();
