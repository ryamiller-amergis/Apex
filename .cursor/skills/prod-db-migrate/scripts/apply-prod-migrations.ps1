# Open temp firewall, fetch prod DATABASE_URL, list pending, run node-pg-migrate up, optionally verify, close firewall.
#
# Usage (from repo root):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/apply-prod-migrations.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/apply-prod-migrations.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/apply-prod-migrations.ps1 -Count 1
#
# Never prints the connection string.

param(
  [switch]$DryRun,
  [int]$Count = 0,
  [string]$RuleName = "",
  [string]$VerifySql = "",
  [string[]]$VerifyArgs = @(),
  [switch]$KeepFirewallOpen,
  # Apply exactly one migrations/<Name>.sql and record pgmigrations (skips other pending).
  [string]$NamedMigration = ""
)

$ErrorActionPreference = 'Stop'
# scripts/ -> prod-db-migrate/ -> skills/ -> .cursor/ -> repo root
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
Set-Location $repoRoot
Write-Host "REPO_ROOT=$repoRoot"

. "$PSScriptRoot\prod-db-defaults.ps1"

$openedRule = $null
try {
  Assert-AzLoggedIn | Out-Null

  if ([string]::IsNullOrWhiteSpace($RuleName)) {
    $safeUser = ($env:USERNAME -replace '[^a-zA-Z0-9]', '').ToLower()
    if ([string]::IsNullOrWhiteSpace($safeUser)) { $safeUser = 'agent' }
    $RuleName = "$($script:ApexProd.DefaultRulePrefix)-$safeUser"
  }

  Write-Host '=== Step 1: Open temp firewall ==='
  & "$PSScriptRoot\open-temp-firewall.ps1" -RuleName $RuleName | Out-Null
  $openedRule = $RuleName

  Write-Host '=== Step 2: Fetch prod DATABASE_URL ==='
  $dbUrl = Get-ApexProdDatabaseUrl
  $env:DATABASE_URL = $dbUrl
  $env:PROD_DATABASE_URL = $dbUrl

  Write-Host '=== Step 3: List pending migrations ==='
  node "$PSScriptRoot\list-pending-migrations.js"
  if ($LASTEXITCODE -ne 0) { throw "list-pending-migrations failed (exit $LASTEXITCODE)" }

  if ($DryRun) {
    Write-Host 'DRY_RUN=true - skipping migrate:up'
  } elseif (-not [string]::IsNullOrWhiteSpace($NamedMigration)) {
    Write-Host ("=== Step 4: Apply named migration " + $NamedMigration + " ===")
    node "$PSScriptRoot\apply-named-migration.js" $NamedMigration
    if ($LASTEXITCODE -ne 0) { throw "apply-named-migration failed (exit $LASTEXITCODE)" }
    Write-Host 'MIGRATE_NAMED=ok'
  } else {
    Write-Host '=== Step 4: Apply migrations ==='
    if ($Count -gt 0) {
      npx node-pg-migrate up $Count --no-check-order
    } else {
      npm run migrate:up
    }
    if ($LASTEXITCODE -ne 0) { throw "migrate:up failed (exit $LASTEXITCODE)" }
    Write-Host 'MIGRATE_UP=ok'
  }

  if (-not [string]::IsNullOrWhiteSpace($VerifySql)) {
    Write-Host '=== Step 5: Verify ==='
    $verifyArgList = @("$PSScriptRoot\verify-query.js", $VerifySql) + $VerifyArgs
    & node @verifyArgList
    if ($LASTEXITCODE -ne 0) { throw "verify-query failed (exit $LASTEXITCODE)" }
  }

  Write-Host '=== Done ==='
}
finally {
  if ($openedRule -and -not $KeepFirewallOpen) {
    Write-Host '=== Cleanup firewall ==='
    try {
      & "$PSScriptRoot\close-temp-firewall.ps1" -RuleName $openedRule
    } catch {
      Write-Host ("FIREWALL_CLEANUP_FAILED=" + $_.Exception.Message)
    }
  } elseif ($openedRule -and $KeepFirewallOpen) {
    Write-Host ("FIREWALL_LEFT_OPEN=" + $openedRule)
  }

  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:PROD_DATABASE_URL -ErrorAction SilentlyContinue
}
