# Shared Apex production Postgres defaults for temporary local access.
# Dot-source from sibling scripts. Do not print secrets.

$script:ApexProd = @{
  SubscriptionHint = 'MSS-Production'
  DataResourceGroup = 'rg-apex-prd-data'
  PostgresServer   = 'psql-apex-eus2'
  AppResourceGroup = 'rg-apex-prd-app'
  AppName          = 'app-apex-prd'
  DefaultRulePrefix = 'temp-cursor-migrate'
}

function Get-ApexPublicIp {
  return (Invoke-RestMethod -Uri 'https://api.ipify.org').ToString().Trim()
}

function Assert-AzLoggedIn {
  $account = az account show -o json 2>$null | ConvertFrom-Json
  if (-not $account) {
    throw 'Azure CLI is not logged in. Run: az login'
  }
  Write-Host "AZ_ACCOUNT=$($account.name)"
  return $account
}

function Get-ApexProdDatabaseUrl {
  $dbUrl = az webapp config appsettings list `
    --name $script:ApexProd.AppName `
    --resource-group $script:ApexProd.AppResourceGroup `
    --query "[?name=='DATABASE_URL'].value" `
    -o tsv 2>&1

  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dbUrl) -or $dbUrl -notmatch '^postgres') {
    throw "Failed to fetch DATABASE_URL from $($script:ApexProd.AppName): $dbUrl"
  }

  # Never echo the full URL.
  Write-Host "PROD_DATABASE_URL_SET=true length=$($dbUrl.Length)"
  return $dbUrl.Trim()
}
