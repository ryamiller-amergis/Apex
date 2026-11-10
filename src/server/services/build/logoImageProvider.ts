export class LogoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogoProviderError';
  }
}

export interface LogoImageProvider {
  readonly id: 'comfyui' | 'cursor_svg';
  generate(input: {
    prompt: string;
    applicationPrompt?: string;
    count: number;
    seed: number;
    modelId?: string;
  }): Promise<Buffer[]>;
}
