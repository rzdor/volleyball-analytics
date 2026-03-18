import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { InvocationContext, app } from '@azure/functions';
import { getProcessingQueue } from '../services/processingQueue';
import { downloadVideoFromUrl, VideoDownloadError } from '../services/remoteVideoDownloader';
import { getVideoRecordStore } from '../services/videoRecordStore';
import { VideoUrlImportMessage } from '../services/urlImportQueue';
import { ProcessingJobMessage } from '../types/processing';

function getStorageConnectionString(): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage must be configured');
  }
  return connectionString;
}

function getMaxVideoBytes(): number {
  const configured = Number.parseInt(process.env.VIDEO_UPLOAD_MAX_BYTES ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 5 * 1024 * 1024 * 1024;
}

async function uploadImportedFile(containerName: string, blobName: string, filePath: string): Promise<string> {
  const blobService = BlobServiceClient.fromConnectionString(getStorageConnectionString());
  const containerClient = blobService.getContainerClient(containerName);
  await containerClient.createIfNotExists();
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.uploadFile(filePath);
  return blockBlobClient.url;
}

function parseQueueMessage(queueEntry: unknown): VideoUrlImportMessage {
  if (typeof queueEntry === 'string') {
    return JSON.parse(queueEntry) as VideoUrlImportMessage;
  }

  if (typeof queueEntry === 'object' && queueEntry !== null) {
    return queueEntry as VideoUrlImportMessage;
  }

  throw new Error(`Invalid URL import queue payload: ${String(queueEntry)}`);
}

function getErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 2000 ? `${raw.slice(0, 1997)}...` : raw;
}

export async function importVideoFromUrlHandler(queueEntry: unknown, context: InvocationContext): Promise<void> {
  const recordStore = getVideoRecordStore();
  const convertQueue = getProcessingQueue('convert');
  let tempFilePath: string | undefined;

  try {
    const message = parseQueueMessage(queueEntry);
    const record = await recordStore.get(message.recordId);

    if (!record) {
      throw new Error(`No video record found for import job ${message.recordId}`);
    }

    if (record.currentStage !== 'import' || record.status === 'completed') {
      context.log('importVideoFromUrl skipping stale import job', {
        recordId: message.recordId,
        currentStage: record.currentStage,
        status: record.status,
      });
      return;
    }

    const importStartedAt = await recordStore.markImportProcessing(message.recordId);
    const tempDir = path.join(os.tmpdir(), 'va-url-imports', randomUUID());
    fs.mkdirSync(tempDir, { recursive: true });
    tempFilePath = await downloadVideoFromUrl(
      message.requestedVideoUrl,
      tempDir,
      getMaxVideoBytes()
    );

    const blobUrl = await uploadImportedFile(message.sourceContainer, message.sourceBlobName, tempFilePath);
    const convertJob: ProcessingJobMessage = {
      version: 1,
      jobType: 'convert',
      jobToken: randomUUID(),
      recordId: message.recordId,
      sourceContainer: message.sourceContainer,
      sourceBlobName: message.sourceBlobName,
    };

    await convertQueue.enqueue(convertJob);
    await recordStore.markImportCompletedAndQueueConvert(
      message.recordId,
      blobUrl,
      importStartedAt,
      convertJob.jobToken
    );

    context.log('importVideoFromUrl uploaded blob and queued convert job', {
      recordId: message.recordId,
      sourceBlobName: message.sourceBlobName,
      convertJobToken: convertJob.jobToken,
    });
  } catch (error) {
    const message = getErrorMessage(error);
    context.error('importVideoFromUrl failed', error);

    if (typeof queueEntry === 'string' || (typeof queueEntry === 'object' && queueEntry !== null)) {
      try {
        const parsed = parseQueueMessage(queueEntry);
        await recordStore.markImportFailed(parsed.recordId, message);
      } catch (markError) {
        context.error('Failed to mark import job as failed', markError);
      }
    }

    if (error instanceof VideoDownloadError) {
      return;
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
}

app.storageQueue('importVideoFromUrl', {
  queueName: process.env.VIDEO_URL_IMPORT_QUEUE_NAME ?? 'video-url-import-jobs',
  connection: 'AzureWebJobsStorage',
  handler: importVideoFromUrlHandler,
});
