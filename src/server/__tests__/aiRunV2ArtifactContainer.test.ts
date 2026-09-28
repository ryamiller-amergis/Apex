const mockAzureCliCredential = jest.fn();
const mockManagedIdentityCredential = jest.fn();

jest.mock('@azure/identity', () => ({
  AzureCliCredential: mockAzureCliCredential,
  ManagedIdentityCredential: mockManagedIdentityCredential,
}));

import { resolveArtifactCredential } from '../services/aiRunV2/artifactContainer';

describe('resolveArtifactCredential', () => {
  beforeEach(() => {
    mockAzureCliCredential.mockClear();
    mockManagedIdentityCredential.mockClear();
  });

  it('uses the V2 user-assigned identity when a worker configures one', () => {
    resolveArtifactCredential({
      NODE_ENV: 'production',
      AI_PLATFORM_V2_IDENTITY_CLIENT_ID: 'v2-client',
      AZURE_CLIENT_ID: 'apex-app-registration',
    });

    expect(mockManagedIdentityCredential).toHaveBeenCalledWith({ clientId: 'v2-client' });
  });

  it('uses the App Service system identity, not the Apex app registration, in production', () => {
    resolveArtifactCredential({
      NODE_ENV: 'production',
      AZURE_CLIENT_ID: 'apex-app-registration',
      AZURE_CLIENT_SECRET: 'secret',
      AZURE_TENANT_ID: 'tenant',
    });

    expect(mockManagedIdentityCredential).toHaveBeenCalledWith();
    expect(mockAzureCliCredential).not.toHaveBeenCalled();
  });

  it('uses the Azure CLI login locally', () => {
    resolveArtifactCredential({ NODE_ENV: 'development' });

    expect(mockAzureCliCredential).toHaveBeenCalledTimes(1);
    expect(mockManagedIdentityCredential).not.toHaveBeenCalled();
  });
});
