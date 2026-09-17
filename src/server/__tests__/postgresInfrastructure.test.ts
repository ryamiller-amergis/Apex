import fs from 'node:fs';
import path from 'node:path';

const infraRoot = path.resolve(process.cwd(), 'infra');

function readTf(name: string): string {
  return fs.readFileSync(path.join(infraRoot, name), 'utf8');
}

function readBlock(source: string, header: string): string {
  const start = source.indexOf(header);
  if (start < 0) throw new Error(`Missing Terraform block: ${header}`);
  const bodyStart = source.indexOf('{', start);
  if (bodyStart < 0) throw new Error(`Missing Terraform block body: ${header}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed Terraform block: ${header}`);
}

const mainTf = readTf('main.tf');
const variablesTf = readTf('variables.tf');
const exampleTfvars = readTf('terraform.tfvars.example');
const infraReadme = readTf('README.md');
const postgresResource = readBlock(
  mainTf,
  'resource "azurerm_postgresql_flexible_server" "main"',
);
const firewallResource = readBlock(
  mainTf,
  'resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services"',
);
const storageVariable = readBlock(
  variablesTf,
  'variable "postgresql_storage_mb"',
);
const backupVariable = readBlock(
  variablesTf,
  'variable "postgresql_backup_retention_days"',
);
const firewallNameVariable = readBlock(
  variablesTf,
  'variable "postgresql_azure_services_firewall_rule_name"',
);

describe('PostgreSQL Terraform ownership contract', () => {
  it('parameterizes storage and backup retention so an imported server is not resized', () => {
    expect(storageVariable).toMatch(/type\s*=\s*number/);
    expect(storageVariable).toMatch(/default\s*=\s*32768/);
    expect(backupVariable).toMatch(/type\s*=\s*number/);
    expect(backupVariable).toMatch(/default\s*=\s*7/);
    expect(postgresResource).toMatch(/storage_mb\s*=\s*var\.postgresql_storage_mb/);
    expect(postgresResource).toMatch(
      /backup_retention_days\s*=\s*var\.postgresql_backup_retention_days/,
    );
    expect(postgresResource).not.toMatch(/storage_mb\s*=\s*32768/);
    expect(postgresResource).not.toMatch(/backup_retention_days\s*=\s*7/);
    expect(storageVariable).toMatch(
      /contains\(\s*\[\s*32768,\s*65536,\s*131072,\s*262144,\s*524288,\s*1048576,\s*2097152,\s*4193280,\s*4194304,\s*8388608,\s*16777216,\s*33553408\s*\],\s*var\.postgresql_storage_mb,\s*\)/,
    );
    expect(backupVariable).toMatch(
      /floor\(var\.postgresql_backup_retention_days\)\s*==\s*var\.postgresql_backup_retention_days/,
    );
  });

  it('parameterizes the Azure-services firewall rule name for state import', () => {
    expect(firewallNameVariable).toMatch(/type\s*=\s*string/);
    expect(firewallNameVariable).toMatch(/default\s*=\s*"allow-azure-services"/);
    expect(firewallResource).toMatch(
      /name\s*=\s*var\.postgresql_azure_services_firewall_rule_name/,
    );
    expect(firewallNameVariable).toMatch(
      /length\(trimspace\(var\.postgresql_azure_services_firewall_rule_name\)\)\s*>\s*0/,
    );
  });

  it('does not rewrite imported server credentials during state reconciliation', () => {
    expect(postgresResource).toMatch(
      /ignore_changes\s*=\s*\[[^\]]*administrator_password[^\]]*\]/,
    );
    expect(postgresResource).toMatch(
      /ignore_changes\s*=\s*\[[^\]]*administrator_login[^\]]*\]/,
    );
    expect(infraReadme).toMatch(/credential-ownership rule applies to all\s+environments/i);
    expect(infraReadme).toMatch(/administrator credentials are managed\s+outside Terraform/i);
  });

  it('documents environment-specific PostgreSQL shape in the example tfvars', () => {
    expect(exampleTfvars).toMatch(
      /postgresql_location\s*=\s*"East US 2"/,
    );
    expect(exampleTfvars).toMatch(
      /postgresql_storage_mb\s*=\s*32768/,
    );
    expect(exampleTfvars).toMatch(
      /postgresql_backup_retention_days\s*=\s*7/,
    );
    expect(exampleTfvars).toMatch(
      /postgresql_azure_services_firewall_rule_name\s*=\s*"allow-azure-services"/,
    );
  });
});
