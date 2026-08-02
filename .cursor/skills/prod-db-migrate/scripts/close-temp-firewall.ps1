# Delete a temporary Azure Postgres firewall rule.
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/close-temp-firewall.ps1 -RuleName temp-cursor-migrate-ryamiller

param(
  [Parameter(Mandatory = $true)]
  [string]$RuleName
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/prod-db-defaults.ps1"

Assert-AzLoggedIn | Out-Null
Write-Host "RULE_NAME=$RuleName"

az postgres flexible-server firewall-rule delete `
  --resource-group $script:ApexProd.DataResourceGroup `
  --name $script:ApexProd.PostgresServer `
  --rule-name $RuleName `
  --yes `
  -o none

if ($LASTEXITCODE -ne 0) {
  throw "Firewall rule delete failed (exit $LASTEXITCODE)"
}

Write-Host "FIREWALL_DELETED=ok"
