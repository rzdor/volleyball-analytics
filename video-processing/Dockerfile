FROM mcr.microsoft.com/azure-functions/node:4-node20

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true

COPY package.json package-lock.json host.json /home/site/wwwroot/
COPY dist/ /home/site/wwwroot/dist/

WORKDIR /home/site/wwwroot
RUN npm ci --omit=dev
