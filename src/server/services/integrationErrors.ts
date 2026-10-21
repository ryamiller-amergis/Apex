export class IntegrationConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'IntegrationConnectionError';
  }
}
