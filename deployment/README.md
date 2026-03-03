# Volleyball Analytics — Azure Deployment

ARM template to provision the full project environment.

## Resources Created

| Resource | SKU | Purpose |
|---|---|---|
| App Service Plan (Web) | Free F1 | Hosts the web application |
| Web App | Node.js 24 | Express web application (`web-application/`) |
| Storage Account | Standard_LRS | Video file storage |
| Blob Container (`videos`) | — | Stores uploaded video files |
| App Service Plan (Functions) | Basic B1, Linux | Hosts the containerized Function App |
| Function App | Container (Docker) | Video processing with ffmpeg (`video-processing/`) |
| Application Insights | — | Monitoring and telemetry |
| Log Analytics Workspace | — | Log aggregation |

## Prerequisites

- Azure CLI installed (`az`)
- An Azure subscription
- A Docker image with ffmpeg for the Function App (or use the default base image)

## Deploy

```bash
# Login
az login

# Create resource group (if needed)
az group create --name volleyball-rg --location eastus

# Deploy
az deployment group create \
  --resource-group volleyball-rg \
  --template-file azuredeploy.json \
  --parameters @azuredeploy.parameters.json
```

## Custom Function App Container

The Function App runs in a Linux container. To use ffmpeg for video processing, build and push a custom image:

```dockerfile
FROM mcr.microsoft.com/azure-functions/node:4-node20
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
COPY ./video-processing/dist /home/site/wwwroot
```

Then set the `functionAppDockerImage` parameter to your registry image:

```bash
az deployment group create \
  --resource-group volleyball-rg \
  --template-file azuredeploy.json \
  --parameters projectName=volleyball \
               functionAppDockerImage=myregistry.azurecr.io/volleyball-functions:latest
```

## Parameters

| Parameter | Default | Description |
|---|---|---|
| `projectName` | `volleyball` | Base name for all resources |
| `location` | Resource group location | Azure region |
| `functionAppDockerImage` | `mcr.microsoft.com/azure-functions/node:4-node20` | Docker image for Function App |
| `videoBlobContainerName` | `videos` | Blob container name for video storage |
