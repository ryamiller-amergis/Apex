# Open a temporary Azure Postgres firewall rule for this machine's public IP.
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/open-temp-firewall.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/open-temp-firewall.ps1 -RuleName temp-cursor-migrate-ryamiller
#
# Prints RULE_NAME=... so callers can close the same rule later.

param(
  [string]$RuleName = ""
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/prod-db-defaults.ps1"

Assert-AzLoggedIn | Out-Null

if ([string]::IsNullOrWhiteSpace($RuleName)) {
  $safeUser = ($env:USERNAME -replace '[^a-zA-Z0-9]', '').ToLower()
  if ([string]::IsNullOrWhiteSpace($safeUser)) { $safeUser = 'agent' }
  $RuleName = "$($script:ApexProd.DefaultRulePrefix)-$safeUser"
}

$ip = Get-ApexPublicIp
Write-Host "PUBLIC_IP=$ip"
Write-Host "RULE_NAME=$RuleName"

az postgres flexible-server firewall-rule create `
  --resource-group $script:ApexProd.DataResourceGroup `
  --name $script:ApexProd.PostgresServer `
  --rule-name $RuleName `
  --start-ip-address $ip `
  --end-ip-address $ip `
  -o none

if ($LASTEXITCODE -ne 0) {
  throw "Firewall rule create failed (exit $LASTEXITCODE)"
}

Write-Host "FIREWALL_OPEN=ok"
Write-Output $RuleName
