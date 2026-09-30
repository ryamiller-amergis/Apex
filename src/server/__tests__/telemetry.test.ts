describe('telemetry service name', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  function loadTelemetry(env: Record<string, string | undefined>): void {
    process.env = { ...original, ...env };
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
    }
    jest.isolateModules(() => {
      require('../services/telemetry');
    });
  }

  it('names Container App telemetry after the app', () => {
    loadTelemetry({
      CONTAINER_APP_NAME: 'ca-apex-ai-fast-interactive-dev',
      OTEL_SERVICE_NAME: undefined,
    });

    expect(process.env.OTEL_SERVICE_NAME).toBe('ca-apex-ai-fast-interactive-dev');
  });

  it('keeps an explicit service name', () => {
    loadTelemetry({
      CONTAINER_APP_NAME: 'ca-apex-ai-fast-interactive-dev',
      OTEL_SERVICE_NAME: 'explicit-name',
    });

    expect(process.env.OTEL_SERVICE_NAME).toBe('explicit-name');
  });

  it('leaves App Service naming alone', () => {
    loadTelemetry({ CONTAINER_APP_NAME: undefined, OTEL_SERVICE_NAME: undefined });

    expect(process.env.OTEL_SERVICE_NAME).toBeUndefined();
  });
});
