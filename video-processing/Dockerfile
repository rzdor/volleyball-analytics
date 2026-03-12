FROM mcr.microsoft.com/azure-functions/node:4-node20

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true

# Install Python dependencies
COPY python/requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages -r /tmp/requirements.txt && \
    rm /tmp/requirements.txt

COPY package.json package-lock.json host.json /home/site/wwwroot/
COPY dist/ /home/site/wwwroot/dist/
COPY python/ /home/site/wwwroot/python/

WORKDIR /home/site/wwwroot
RUN npm ci --omit=dev
