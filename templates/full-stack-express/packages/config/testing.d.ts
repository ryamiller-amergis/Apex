export const coverageFloors: {
  readonly lines: 80;
  readonly functions: 80;
  readonly statements: 80;
  readonly branches: 75;
};

export const coverageScope: {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
};

export interface TestProjectOptions {
  name: 'unit' | 'component' | 'api' | 'integration' | 'contract';
  environment: 'node' | 'jsdom';
}

export interface DefinedTestProject {
  test: {
    name: TestProjectOptions['name'];
    environment: 'node' | 'jsdom';
    reporters: string[];
    exclude: string[];
    testTimeout: number;
    hookTimeout: number;
  };
}

export function defineTestProject(
  options: TestProjectOptions
): DefinedTestProject;

export const playwrightBase: {
  readonly testDir: string;
  readonly testMatch: readonly string[];
  readonly fullyParallel: boolean;
  readonly workers: number;
  readonly forbidOnly: boolean;
  readonly retries: number;
  readonly reporter: readonly (string | readonly [string, object])[];
  readonly use: {
    readonly baseURL: string;
    readonly trace: string;
    readonly screenshot: string;
  };
  readonly projects: readonly {
    readonly name: string;
    readonly use: { readonly browserName: string };
  }[];
  readonly webServer: {
    readonly command: string;
    readonly url: string;
    readonly timeout: number;
    readonly reuseExistingServer: boolean;
  };
};
