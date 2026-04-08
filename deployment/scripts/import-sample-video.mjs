#!/usr/bin/env node

const DEFAULT_SAMPLE_VIDEO_URL = 'https://ruslanzdorstorage.blob.core.windows.net/video-examples/MLT.MP4';
const DEFAULT_POST_MAX_ATTEMPTS = 8;
const DEFAULT_POST_RETRY_DELAY_MS = 10000;
const DEFAULT_STATUS_MAX_ATTEMPTS = 30;
const DEFAULT_STATUS_RETRY_DELAY_MS = 10000;

class NonRetryableError extends Error {}

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
  return requestJson(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ videoUrl: sampleVideoUrl }),
  });
}

async function requestJson(url, options = undefined) {
  const response = await fetch(url, options);
  const responseText = await response.text();
  let parsedBody;

  try {
    parsedBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    parsedBody = { raw: responseText };
  }

  return { response, parsedBody };
}

async function getSampleVideoStatus(statusUrl) {
  return requestJson(statusUrl);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeStatus(payload) {
  const parts = [
    `status=${payload?.status ?? 'unknown'}`,
    `stage=${payload?.currentStage ?? 'unknown'}`,
  ];

  if (typeof payload?.errorMessage === 'string' && payload.errorMessage) {
    parts.push(`error=${payload.errorMessage}`);
  } else if (typeof payload?.import?.errorMessage === 'string' && payload.import.errorMessage) {
    parts.push(`importError=${payload.import.errorMessage}`);
  }

  return parts.join(', ');
}

function hasImportProgressed(payload) {
  return ['convert', 'trim', 'detect', 'completed'].includes(payload?.currentStage);
}

async function waitForImportProgress(baseUrl, recordId, maxAttempts, retryDelayMs) {
  const statusUrl = new URL(`/api/videos/status/${encodeURIComponent(recordId)}`, `${baseUrl}/`).toString();

  console.log(`[sample-import] Polling import progress at ${statusUrl}`);
  console.log(`[sample-import] Status attempts: ${maxAttempts}, retry delay: ${retryDelayMs}ms`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { response, parsedBody } = await getSampleVideoStatus(statusUrl);

      if (!response.ok) {
        if (attempt === maxAttempts) {
          throw new Error(`Sample video status check failed with ${response.status}: ${JSON.stringify(parsedBody)}`);
        }

        console.warn(`[sample-import] Status attempt ${attempt}/${maxAttempts} failed with ${response.status}; retrying in ${retryDelayMs}ms`);
      } else if (parsedBody?.status === 'failed' || parsedBody?.currentStage === 'failed') {
        throw new NonRetryableError(`Sample video import failed: ${summarizeStatus(parsedBody)}`);
      } else if (hasImportProgressed(parsedBody)) {
        console.log(`[sample-import] Sample video import progressed successfully (${summarizeStatus(parsedBody)})`);
        console.log(JSON.stringify(parsedBody, null, 2));
        return;
      } else if (attempt === maxAttempts) {
        throw new Error(`Sample video import did not advance beyond import. Last observed state: ${summarizeStatus(parsedBody)}`);
      } else {
        console.log(`[sample-import] Sample video record ${recordId} is still waiting in import (${summarizeStatus(parsedBody)}); retrying in ${retryDelayMs}ms`);
      }
    } catch (error) {
      if (error instanceof NonRetryableError || attempt === maxAttempts) {
        throw error;
      }

      console.warn(`[sample-import] Status attempt ${attempt}/${maxAttempts} failed: ${error instanceof Error ? error.message : error}`);
      console.warn(`[sample-import] Retrying in ${retryDelayMs}ms`);
    }

    await sleep(retryDelayMs);
  }
}

async function main() {
  const baseUrl = getBaseUrl();
  const sampleVideoUrl = process.env.SAMPLE_VIDEO_URL?.trim() || DEFAULT_SAMPLE_VIDEO_URL;
  const endpointUrl = new URL('/api/videos/import-from-url', `${baseUrl}/`).toString();
  const postMaxAttempts = parsePositiveInteger(process.env.SAMPLE_IMPORT_MAX_ATTEMPTS, DEFAULT_POST_MAX_ATTEMPTS);
  const postRetryDelayMs = parsePositiveInteger(process.env.SAMPLE_IMPORT_RETRY_DELAY_MS, DEFAULT_POST_RETRY_DELAY_MS);
  const statusMaxAttempts = parsePositiveInteger(process.env.SAMPLE_IMPORT_STATUS_MAX_ATTEMPTS, DEFAULT_STATUS_MAX_ATTEMPTS);
  const statusRetryDelayMs = parsePositiveInteger(process.env.SAMPLE_IMPORT_STATUS_RETRY_DELAY_MS, DEFAULT_STATUS_RETRY_DELAY_MS);

  console.log(`[sample-import] Posting sample video import to ${endpointUrl}`);
  console.log(`[sample-import] Source video URL: ${sampleVideoUrl}`);
  console.log(`[sample-import] POST attempts: ${postMaxAttempts}, retry delay: ${postRetryDelayMs}ms`);

  let queuedImport;

  for (let attempt = 1; attempt <= postMaxAttempts; attempt += 1) {
    try {
      const { response, parsedBody } = await postSampleVideoImport(endpointUrl, sampleVideoUrl);

      if (response.ok) {
        queuedImport = parsedBody;
        break;
      }

      if (response.status < 500 && response.status !== 429) {
        throw new NonRetryableError(`Sample video import failed with ${response.status}: ${JSON.stringify(parsedBody)}`);
      }

      if (attempt === postMaxAttempts) {
        throw new Error(`Sample video import failed with ${response.status}: ${JSON.stringify(parsedBody)}`);
      }

      console.warn(`[sample-import] Attempt ${attempt}/${postMaxAttempts} failed with ${response.status}; retrying in ${postRetryDelayMs}ms`);
    } catch (error) {
      if (error instanceof NonRetryableError || attempt === postMaxAttempts) {
        throw error;
      }

      console.warn(`[sample-import] Attempt ${attempt}/${postMaxAttempts} failed: ${error instanceof Error ? error.message : error}`);
      console.warn(`[sample-import] Retrying in ${postRetryDelayMs}ms`);
    }

    await sleep(postRetryDelayMs);
  }

  if (!queuedImport || typeof queuedImport.recordId !== 'string' || !queuedImport.recordId.trim()) {
    throw new Error(`Sample video import response did not include a recordId: ${JSON.stringify(queuedImport ?? {})}`);
  }

  console.log('[sample-import] Sample video import queued successfully');
  console.log(JSON.stringify(queuedImport, null, 2));

  await waitForImportProgress(baseUrl, queuedImport.recordId.trim(), statusMaxAttempts, statusRetryDelayMs);
}

main().catch((error) => {
  console.error('[sample-import] Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
