# Volleyball Analytics — Azure Deployment

ARM templates to provision the project environment. Split into multiple templates
to support the correct deployment order.

## Deployment Order

```
1. azuredeploy.json        → Infrastructure (storage, table, queue, apps, ACR, worker)
2. Deploy code             → Push Function App + worker images to ACR, deploy web app via CI/CD
3. eventgrid.json          → Event wiring (requires function code to be deployed)
4. monitoring-workbook.json → Monitoring workbook + diagnostics
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
| Azure Queue (`video-convert-jobs`) | — | Buffers 720p conversion jobs for the worker |
| Azure Queue (`video-trim-jobs`) | — | Buffers trim/split jobs after conversion succeeds |
| Azure Queue (`video-detect-jobs`) | — | Buffers detect jobs after trim succeeds |
| Azure Container Registry | Basic | Hosts Function App Docker images |
| App Service Plan (Functions) | Basic B1, Linux | Hosts the containerized ingestion Function App |
| Function App | Container (Docker) | Event Grid ingestion/orchestration (`video-processing/`) |
| Container Apps Environment | Consumption | Runtime environment for the queue worker |
| Container App | Container (Docker) | Queue-driven trim/detection worker (`video-worker/Dockerfile`) |
| Application Insights | — | Monitoring and telemetry |
| Log Analytics Workspace | — | Log aggregation |

### `eventgrid.json` — Event Wiring

Creates the EventGrid system topic and input subscription. **Must be deployed after function
code is running** — EventGrid validates the function endpoint exists.

| Resource | Purpose |
|---|---|
| EventGrid System Topic | Captures blob events from the storage account |
| EventGrid Subscription (`queue-upload-on-input`) | Routes `BlobCreated` and `BlobRenamed` events for `volleyball-videos/input/` to `queueVideoUploadBlob`, which creates the Table record and enqueues the first convert job using the retry policy defined in `eventgrid.json` (`maxDeliveryAttempts: 3` in the current template) |

Queue messages are also handled as single-attempt work items by the worker: on any processing exception the record is marked `failed` and the message is deleted, and if Azure Queue Storage redelivers a message later it is marked failed instead of being retried.

After ingestion, the worker first normalizes the source video to 720p and stores that converted asset under `processed/{recordId}/`. The trim stage then uses the converted blob, writes the consolidated trimmed video plus each individual scene clip under the same `processed/{recordId}/` folder, and the detect stage consumes the full trimmed video from that folder.

`BlobRenamed` is emitted only by storage features that support rename events (for example ADLS Gen2 hierarchical namespace or SFTP rename). When those events are available, the function now uses the rename destination URL and only processes files whose final path is under `input/`.

### `monitoring-workbook.json` — Monitoring Workbook

Creates the final monitoring step of the deployment:

| Resource | Purpose |
|---|---|
| Web App diagnostic setting | Sends App Service HTTP/application logs and metrics to Log Analytics so request volume can be queried in the workbook |
| Blob Service diagnostic setting | Sends blob write logs and metrics to Log Analytics so uploaded/created files can be counted |
| Azure Monitor Workbook | Dashboard for web requests, function-ingested files, worker-processed files, storage blob writes, and worker failures |

The workbook queries these Log Analytics tables:

- `AppServiceHTTPLogs`
- `AppTraces`
- `ContainerAppConsoleLogs_CL`
- `StorageBlobLogs`

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

# Note: the Container App is created with a public bootstrap image first.
# The next step replaces it with the real worker image from ACR.

# Step 2: Build and push Function App container to ACR
az acr build \
  --registry volleyballacr \
  --image volleyball-functions:latest \
  ../video-processing

# Step 3: Build and push the worker image
az acr build \
  --registry volleyballacr \
  --image volleyball-worker:latest \
  ../video-worker

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

# Step 6: Deploy monitoring workbook and diagnostics
az deployment group create \
  --resource-group volleyball-rg \
  --template-file monitoring-workbook.json \
  --parameters @monitoring-workbook.parameters.json
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
| `convertQueueName` | `video-convert-jobs` | Queue consumed by the worker for 720p conversion jobs |
| `trimQueueName` | `video-trim-jobs` | Queue consumed by the worker for trim/split jobs |
| `detectQueueName` | `video-detect-jobs` | Queue consumed by the worker for detect jobs |
| `videoUploadMaxBytes` | `5368709120` | Maximum upload size for the web app in bytes (default 5 GB) |

### eventgrid.json

| Parameter | Default | Description |
|---|---|---|
| `projectName` | `volleyball` | Must match infrastructure template |
| `location` | Resource group location | Must match infrastructure deployment |
| `videoBlobContainerName` | `volleyball-videos` | Must match infrastructure template |

### monitoring-workbook.json

| Parameter | Default | Description |
|---|---|---|
| `projectName` | `volleyball` | Must match infrastructure template |
| `location` | Resource group location | Workbook location |
