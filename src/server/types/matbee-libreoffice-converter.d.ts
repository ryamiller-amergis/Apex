declare module '@matbee/libreoffice-converter' {
  interface ConvertOptions {
    outputFormat: string;
  }
  interface ConvertResult {
    data: Buffer;
  }
  export function convertDocument(
    input: Buffer,
    options: ConvertOptions,
  ): Promise<ConvertResult>;
}
