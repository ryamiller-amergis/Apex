import { assertDockerAvailable } from '../../../../scripts/docker-guard.mjs';

declare module 'vitest' {
  export interface ProvidedContext {
    dockerAvailable: boolean;
    databaseUrl: string;
    containerId: string;
  }
}

let stop: (() => Promise<void>) | undefined;

export async function setup(context: {
  provide: (key: string, value: unknown) => void;
}): Promise<void> {
  try {
    await assertDockerAvailable('integration');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(message);
    context.provide('dockerAvailable', false);
    context.provide('databaseUrl', '');
    context.provide('containerId', '');
    return;
  }

  const { startTestDatabaseServer } =
    await import('../support/testDatabase.ts');
  const server = await startTestDatabaseServer();
  const database = await server.createDatabase({ migrated: true });
  context.provide('dockerAvailable', true);
  context.provide('databaseUrl', database.url);
  context.provide('containerId', server.id);
  stop = async () => {
    await database.drop().catch(() => undefined);
    await server.stop();
  };
}

export async function teardown(): Promise<void> {
  await stop?.();
  stop = undefined;
}
