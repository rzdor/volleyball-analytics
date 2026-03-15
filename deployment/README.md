# Volleyball Analytics — Azure Deployment

ARM templates to provision the project environment. Split into two templates
to support the correct deployment order.

## Deployment Order

```
1. azuredeploy.json        → Infrastructure (storage, table, queue, apps, ACR, worker)
2. Deploy code             → Push Function App + worker images to ACR, deploy web app via CI/CD
3. eventgrid.json          → Event wiring (requires function code to be deployed)
```

## Templates

### `azuredeploy.json` — Infrastructure

Creates all Azure resources needed to run the project.

| Resource | SKU | Purpose |
|---|---|---|
| App Service Plan (Web) | Basic B1 | Hosts the web application |
| Web App | Node.js 20 | Express web application (`web-application/`) |
| Storage Account | Standard_LRS | Blob storage |
| Blob Container (`volleyball-videos`) | — | Video file uploads (input/) and processed output |
| Blob Container (`coordination`) | — | Reserved for coordination/auxiliary assets |
| Blob Container (`detections`) | — | Player detection results (JSON) |
| Azure Table (`videoprocessingrecords`) | — | Tracks one record per uploaded video and processing state |
| Azure Queue (`video-processing-jobs`) | — | Buffers trim/detect jobs for the worker |
| Azure Container Registry | Basic | Hosts Function App Docker images |
| App Service Plan (Functions) | Basic B1, Linux | Hosts the containerized ingestion Function App |
| Function App | Container (Docker) | Event Grid ingestion/orchestration (`video-processing/`) |
| Container Apps Environment | Consumption | Runtime environment for the queue worker |
| Container App | Container (Docker) | Queue-driven trim/detection worker (`video-processing/Dockerfile.worker`) |
| Application Insights | — | Monitoring and telemetry |
| Log Analytics Workspace | — | Log aggregation |

### `eventgrid.json` — Event Wiring

Creates the EventGrid system topic and input subscription. **Must be deployed after function
code is running** — EventGrid validates the function endpoint exists.

| Resource | Purpose |
|---|---|
| EventGrid System Topic | Captures blob events from the storage account |
| EventGrid Subscription (`queue-upload-on-input`) | Routes `BlobCreated` in `volleyball-videos/input/` to `queueVideoUploadBlob`, which creates the Table record and enqueues the first trim job with a single delivery attempt (`maxDeliveryAttempts: 1`) |

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

# Step 3: Build and push the worker image
az acr build \
  --registry volleyballacr \
  --image volleyball-worker:latest \
  --file ../video-processing/Dockerfile.worker \
  ../video-processing

# Step 4: Restart Function App and update the worker image
az webapp restart --name volleyball-functions --resource-group volleyball-rg
az containerapp update \
  --name volleyball-video-worker \
  --resource-group volleyball-rg \
  --image volleyballacr.azurecr.io/volleyball-worker:latest

# Step 5: Deploy EventGrid wiring (function must be running)
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
| `detectionsBlobContainerName` | `detections` | Blob container for detection results |
| `videoRecordsTableName` | `videoprocessingrecords` | Azure Table used for per-video processing state |
| `processingQueueName` | `video-processing-jobs` | Queue consumed by the worker container app |

### eventgrid.json

| Parameter | Default | Description |
|---|---|---|
| `projectName` | `volleyball` | Must match infrastructure template |
| `location` | Resource group location | Must match infrastructure deployment |
| `videoBlobContainerName` | `volleyball-videos` | Must match infrastructure template |
