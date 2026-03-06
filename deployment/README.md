# Volleyball Analytics — Azure Deployment

ARM templates to provision the project environment. Split into two templates
to support the correct deployment order.

## Deployment Order

```
1. azuredeploy.json        → Infrastructure (storage, apps, ACR, containers)
2. Deploy code             → Push Docker image to ACR, deploy web app via CI/CD
3. eventgrid.json          → Event wiring (requires function code to be deployed)
```

## Templates

### `azuredeploy.json` — Infrastructure

Creates all Azure resources needed to run the project.

| Resource | SKU | Purpose |
|---|---|---|
| App Service Plan (Web) | Basic B1 | Hosts the web application |
| Web App | Node.js 24 | Express web application (`web-application/`) |
| Storage Account | Standard_LRS | Blob storage |
| Blob Container (`volleyball-videos`) | — | Video file uploads (input/) and processed output |
| Blob Container (`coordination`) | — | Function coordination logs and metadata |
| Azure Container Registry | Basic | Hosts Function App Docker images |
| App Service Plan (Functions) | Basic B1, Linux | Hosts the containerized Function App |
| Function App | Container (Docker) | Video processing with ffmpeg (`video-processing/`) |
| Application Insights | — | Monitoring and telemetry |
| Log Analytics Workspace | — | Log aggregation |

### `eventgrid.json` — Event Wiring

Creates EventGrid system topic and subscription. **Must be deployed after function
code is running** — EventGrid validates the function endpoint exists.

| Resource | Purpose |
|---|---|
| EventGrid System Topic | Captures blob events from the storage account |
| EventGrid Subscription | Routes `BlobCreated` in `volleyball-videos/input/` to `trimVideoBlob` function |

## Prerequisites

- Azure CLI installed (`az`)
- An Azure subscription

## Deploy

```bash
# Login
az login

# Create resource group (if needed)
az group create --name volleyball-rg --location eastus

# Step 1: Deploy infrastructure
az deployment group create \
  --resource-group volleyball-rg \
  --template-file azuredeploy.json \
  --parameters @azuredeploy.parameters.json

# Step 2: Build and push Function App container to ACR
az acr build \
  --registry volleyballacr \
  --image volleyball-functions:latest \
  ../video-processing

# Step 3: Restart Function App to pull the new image and wait for it to start
az webapp restart --name volleyball-functions --resource-group volleyball-rg

# Step 4: Deploy EventGrid wiring (function must be running)
az deployment group create \
  --resource-group volleyball-rg \
  --template-file eventgrid.json \
  --parameters @eventgrid.parameters.json
```

## Parameters

### azuredeploy.json

| Parameter | Default | Description |
|---|---|---|
| `projectName` | `volleyball` | Base name for all resources |
| `location` | Resource group location | Azure region |
| `acrSku` | `Basic` | ACR tier (Basic/Standard/Premium) |
| `videoBlobContainerName` | `volleyball-videos` | Blob container for video storage |
| `coordinationBlobContainerName` | `coordination` | Blob container for logs/metadata |

### eventgrid.json

| Parameter | Default | Description |
|---|---|---|
| `projectName` | `volleyball` | Must match infrastructure template |
| `location` | Resource group location | Must match infrastructure deployment |
| `videoBlobContainerName` | `volleyball-videos` | Must match infrastructure template |
