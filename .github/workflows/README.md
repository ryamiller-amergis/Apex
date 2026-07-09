# GitHub Actions Deployment Setup

This workflow automatically deploys the application to Azure App Service when changes are pushed to the `main` branch.

## Prerequisites

### 1. Create Azure Service Principal

Run this command in Azure CLI to create a service principal with Contributor access to your resource group:

```bash
az ad sp create-for-rbac --name "github-actions-scrum-calendar" \
  --role contributor \
  --scopes /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/rg-scrum-dev \
  --json-auth
```

Replace `<SUBSCRIPTION_ID>` with your Azure subscription ID. You can find it by running:
```bash
az account show --query id --output tsv
```

This command will output JSON credentials like:
```json
{
  "clientId": "<client-id>",
  "clientSecret": "<client-secret>",
  "subscriptionId": "<subscription-id>",
  "tenantId": "<tenant-id>"
}
```

### 2. Add GitHub Secrets

1. Go to your GitHub repository
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Add the following secrets:

#### Required Secrets:

**AZURE_CREDENTIALS**
- Value: JSON with your service principal credentials in this exact format:
```json
{
  "clientId": "your-client-id",
  "clientSecret": "your-client-secret",
  "subscriptionId": "your-subscription-id",
  "tenantId": "your-tenant-id"
}
```
- **Important:** Must be valid JSON with these exact field names (camelCase)

**ADO_ORG**
- Value: Your Azure DevOps organization URL (e.g., `https://dev.azure.com/Amergis`)

**ADO_PAT**
- Value: Your Azure DevOps Personal Access Token with Work Items read permissions

**ADO_PROJECT**
- Value: Your Azure DevOps project name (e.g., `MaxView`)

#### Required Variables:

**VITE_TEAMS**
- Value: Comma-separated team configurations (e.g., `MaxView|MaxView,MaxView|MaxView\MaxView Infra Team,MaxView|MaxView\Mobile - Team`)
- Go to **Settings** → **Secrets and variables** → **Actions** → **Variables** tab

> **Note:** Variables are used for non-sensitive configuration. Secrets are encrypted and used for credentials.

### 3. Configure Environment Variables in Azure (Optional)

The GitHub Actions workflow automatically sets the Azure DevOps environment variables during deployment. However, if you've already configured them via Terraform, they will remain as configured.

```bash
az webapp config appsettings set \
  --resource-group rg-scrum-dev \
  --name app-scrum-dev \
  --settings ADO_ORG="<your-org>" ADO_PAT="<your-pat>" ADO_PROJECT="<your-project>"
```

## Workflow Triggers

The workflow runs on:
- **Push to main branch**: Automatic deployment when code is pushed
- **Manual trigger**: Via the "Actions" tab in GitHub (workflow_dispatch)

## Deployment Process

1. **Checkout code**: Gets the latest code from the repository
2. **Set up Node.js**: Installs Node.js 24.x
3. **Install dependencies**: Runs `npm ci` for clean install
4. **Build application**: Compiles TypeScript and builds client with Vite
5. **Create deployment package**: Prepares production-ready files
6. **Login to Azure**: Authenticates using service principal
7. **Deploy to Azure Web App**: Pushes the application to App Service
8. **Set App Service Configuration**: Configures Azure DevOps environment variables
9. **Logout**: Cleans up Azure session

## Monitoring Deployments

1. Go to the **Actions** tab in your GitHub repository
2. Click on the latest workflow run to see deployment progress
3. Check the Azure Portal for application logs and monitoring

## Troubleshooting

### Deployment fails with authentication error
- Verify `AZURE_CREDENTIALS` secret is set correctly
- Ensure service principal has Contributor role on the resource group

### Application doesn't start after deployment
- Check Application Insights or App Service logs in Azure Portal
- Verify environment variables are set correctly
- Ensure `npm start` script works locally

### Build fails
- Run `npm run build` locally to test
- Check Node.js version matches (24.x)
