FROM mcr.microsoft.com/azure-functions/node:4-node20

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true

COPY dist/ /home/site/wwwroot/
COPY package.json package-lock.json /home/site/wwwroot/

WORKDIR /home/site/wwwroot
RUN npm ci --omit=dev
