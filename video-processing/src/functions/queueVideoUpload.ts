import { app, EventGridEvent, InvocationContext } from '@azure/functions';
import { randomUUID } from 'crypto';
import { parseBlobUrl } from '../services/blobUtils';
import { getProcessingQueue } from '../services/processingQueue';
import { getVideoRecordStore } from '../services/videoRecordStore';
import { isInputBlob, ProcessingJobMessage } from '../types/processing';

type BlobCreatedEventData = {
  url?: string;
};

type BlobRenamedEventData = {
  sourceUrl?: string;
  destinationUrl?: string;
};

function getBlobUrl(event: EventGridEvent): string {
  if (event.eventType === 'Microsoft.Storage.BlobRenamed') {
    const data = event.data as BlobRenamedEventData;
    if (!data.destinationUrl) {
      throw new Error('EventGrid blob-renamed event is missing data.destinationUrl');
    }
    return data.destinationUrl;
  }

  const data = event.data as BlobCreatedEventData;
  if (!data.url) {
    throw new Error('EventGrid blob-created event is missing data.url');
  }

  return data.url;
}

export async function queueVideoUploadHandler(event: EventGridEvent, context: InvocationContext): Promise<void> {
  const blobUrl = getBlobUrl(event);

  const blob = parseBlobUrl(blobUrl);
  if (!isInputBlob(blob.blobName)) {
    context.log('queueVideoUpload skipping non-input blob', { blobUrl, blobName: blob.blobName });
    return;
  }

  const recordStore = getVideoRecordStore();
  const queue = getProcessingQueue('convert');
  const { created, record } = await recordStore.createFromUpload({
    containerName: blob.containerName,
    blobName: blob.blobName,
    blobUrl,
  });

  const convertJobToken = randomUUID();
  const convertJob: ProcessingJobMessage = {
    version: 1,
    jobType: 'convert',
    jobToken: convertJobToken,
    recordId: record.recordId,
    sourceContainer: record.sourceContainer,
    sourceBlobName: record.sourceBlobName,
  };

  if (!created) {
    if (record.status === 'uploaded' && record.currentStage === 'ingest') {
      await queue.enqueue(convertJob);
      await recordStore.markQueued(record.recordId, 'convert', 0, convertJobToken);

      context.log('queueVideoUpload recovered unqueued record and queued convert job', {
        recordId: record.recordId,
        sourceBlobName: record.sourceBlobName,
      });
      return;
    }

    context.log('queueVideoUpload found existing record for blob; skipping duplicate enqueue', {
      recordId: record.recordId,
      blobName: record.sourceBlobName,
      status: record.status,
      currentStage: record.currentStage,
    });
    return;
  }

  await queue.enqueue(convertJob);
  await recordStore.markQueued(record.recordId, 'convert', 0, convertJobToken);

  context.log('queueVideoUpload queued convert job', {
    recordId: record.recordId,
    sourceBlobName: record.sourceBlobName,
  });
}

app.eventGrid('queueVideoUploadBlob', {
  handler: queueVideoUploadHandler,
});
