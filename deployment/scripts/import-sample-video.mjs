#!/usr/bin/env node

const DEFAULT_SAMPLE_VIDEO_URL = 'https://ruslanzdorstorage.blob.core.windows.net/video-examples/MLT.MP4';
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_DELAY_MS = 10000;

function getBaseUrl() {
  const cliValue = process.argv[2]?.trim();
  const envValue = process.env.WEB_APP_BASE_URL?.trim();
  const baseUrl = cliValue || envValue;

  if (!baseUrl) {
    throw new Error('Provide the web app base URL as the first argument or WEB_APP_BASE_URL.');
  }

  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postSampleVideoImport(endpointUrl, sampleVideoUrl) {
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ videoUrl: sampleVideoUrl }),
  });

  const responseText = await response.text();
  let parsedBody;

  try {
    parsedBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    parsedBody = { raw: responseText };
  }

  return { response, parsedBody };
}

async function main() {
  const baseUrl = getBaseUrl();
  const sampleVideoUrl = process.env.SAMPLE_VIDEO_URL?.trim() || DEFAULT_SAMPLE_VIDEO_URL;
  const endpointUrl = new URL('/api/videos/import-from-url', `${baseUrl}/`).toString();
  const maxAttempts = Number.parseInt(process.env.SAMPLE_IMPORT_MAX_ATTEMPTS ?? '', 10) || DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = Number.parseInt(process.env.SAMPLE_IMPORT_RETRY_DELAY_MS ?? '', 10) || DEFAULT_RETRY_DELAY_MS;

  console.log(`[sample-import] Posting sample video import to ${endpointUrl}`);
  console.log(`[sample-import] Source video URL: ${sampleVideoUrl}`);
  console.log(`[sample-import] Max attempts: ${maxAttempts}, retry delay: ${retryDelayMs}ms`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { response, parsedBody } = await postSampleVideoImport(endpointUrl, sampleVideoUrl);

      if (response.ok) {
        console.log('[sample-import] Sample video import queued successfully');
        console.log(JSON.stringify(parsedBody, null, 2));
        return;
      }

      if (response.status < 500 && response.status !== 429) {
        throw new Error(`Sample video import failed with ${response.status}: ${JSON.stringify(parsedBody)}`);
      }

      if (attempt === maxAttempts) {
        throw new Error(`Sample video import failed with ${response.status}: ${JSON.stringify(parsedBody)}`);
      }

      console.warn(`[sample-import] Attempt ${attempt}/${maxAttempts} failed with ${response.status}; retrying in ${retryDelayMs}ms`);
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      console.warn(`[sample-import] Attempt ${attempt}/${maxAttempts} failed: ${error instanceof Error ? error.message : error}`);
      console.warn(`[sample-import] Retrying in ${retryDelayMs}ms`);
    }

    await sleep(retryDelayMs);
  }
}

main().catch((error) => {
  console.error('[sample-import] Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
