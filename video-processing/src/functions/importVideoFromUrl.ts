import { randomUUID } from 'crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { InvocationContext, app } from '@azure/functions';
import { getProcessingQueue } from '../services/processingQueue';
import { downloadVideoToBlob, VideoDownloadError } from '../services/remoteVideoDownloader';
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

function getImportedBlobClient(containerName: string, blobName: string) {
  const blobService = BlobServiceClient.fromConnectionString(getStorageConnectionString());
  const containerClient = blobService.getContainerClient(containerName);
  return {
    containerClient,
    blockBlobClient: containerClient.getBlockBlobClient(blobName),
  };
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

function getDequeueCount(context: InvocationContext): number | undefined {
  const metadata = context.triggerMetadata;
  const rawValues = [
    metadata?.dequeueCount,
    metadata?.DequeueCount,
    metadata?.dequeuecount,
  ];

  for (const rawValue of rawValues) {
    const parsed = typeof rawValue === 'number'
      ? rawValue
      : Number.parseInt(String(rawValue ?? ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function getRetryCount(context: InvocationContext): number {
  const dequeueCount = getDequeueCount(context);
  return dequeueCount && dequeueCount > 1 ? dequeueCount - 1 : 0;
}

export async function importVideoFromUrlHandler(queueEntry: unknown, context: InvocationContext): Promise<void> {
  let parsedMessage: VideoUrlImportMessage | undefined;
  let recordStore: ReturnType<typeof getVideoRecordStore> | undefined;
  const dequeueCount = getDequeueCount(context);
  const retryCount = getRetryCount(context);

  try {
    parsedMessage = parseQueueMessage(queueEntry);
    recordStore = getVideoRecordStore();
    const convertQueue = getProcessingQueue('convert');

    context.log('importVideoFromUrl starting import job', {
      recordId: parsedMessage.recordId,
      sourceBlobName: parsedMessage.sourceBlobName,
      dequeueCount,
      retryCount,
    });

    const record = await recordStore.get(parsedMessage.recordId);

    if (!record) {
      throw new Error(`No video record found for import job ${parsedMessage.recordId}`);
    }

    if (record.currentStage !== 'import' || record.status === 'completed') {
      context.log('importVideoFromUrl skipping stale import job', {
        recordId: parsedMessage.recordId,
        currentStage: record.currentStage,
        status: record.status,
        dequeueCount,
        retryCount,
      });
      return;
    }

    const importStartedAt = await recordStore.markImportProcessing(parsedMessage.recordId, retryCount);
    const { containerClient, blockBlobClient } = getImportedBlobClient(parsedMessage.sourceContainer, parsedMessage.sourceBlobName);
    await containerClient.createIfNotExists();
    const blobUrl = await downloadVideoToBlob(
      parsedMessage.requestedVideoUrl,
      blockBlobClient,
      getMaxVideoBytes()
    );
    const convertJob: ProcessingJobMessage = {
      version: 1,
      jobType: 'convert',
      jobToken: randomUUID(),
      recordId: parsedMessage.recordId,
      sourceContainer: parsedMessage.sourceContainer,
      sourceBlobName: parsedMessage.sourceBlobName,
    };

    await convertQueue.enqueue(convertJob);
    await recordStore.markImportCompletedAndQueueConvert(
      parsedMessage.recordId,
      blobUrl,
      importStartedAt,
      convertJob.jobToken
    );

    context.log('importVideoFromUrl uploaded blob and queued convert job', {
      recordId: parsedMessage.recordId,
      sourceBlobName: parsedMessage.sourceBlobName,
      convertJobToken: convertJob.jobToken,
      dequeueCount,
      retryCount,
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    context.error('importVideoFromUrl failed', {
      recordId: parsedMessage?.recordId,
      sourceBlobName: parsedMessage?.sourceBlobName,
      dequeueCount,
      retryCount,
      errorMessage,
    });
    context.error(error);

    if (parsedMessage && error instanceof VideoDownloadError) {
      try {
        const effectiveRecordStore = recordStore ?? getVideoRecordStore();
        await effectiveRecordStore.markImportFailed(parsedMessage.recordId, errorMessage, retryCount);
      } catch (markError) {
        context.error('Failed to mark import job as failed', markError);
        throw markError;
      }
      return;
    }

    context.warn('importVideoFromUrl will rely on queue retry for transient failure', {
      recordId: parsedMessage?.recordId,
      sourceBlobName: parsedMessage?.sourceBlobName,
      dequeueCount,
      retryCount,
    });
    throw error;
  }
}

app.storageQueue('importVideoFromUrl', {
  queueName: process.env.VIDEO_URL_IMPORT_QUEUE_NAME ?? 'video-url-import-jobs',
  connection: 'AzureWebJobsStorage',
  handler: importVideoFromUrlHandler,
});
