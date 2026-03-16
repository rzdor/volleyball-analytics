FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*

COPY python/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/pyenv && \
    /opt/pyenv/bin/pip install --no-cache-dir -r /tmp/requirements.txt && \
    rm /tmp/requirements.txt

ENV PATH="/opt/pyenv/bin:$PATH" \
    NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY python/ ./python/

CMD ["node", "dist/src/worker.js"]
