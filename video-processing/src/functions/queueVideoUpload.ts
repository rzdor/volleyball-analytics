import { app, EventGridEvent, InvocationContext } from '@azure/functions';
import { randomUUID } from 'crypto';
import { parseBlobUrl } from '../services/blobUtils';
import { getProcessingQueue } from '../services/processingQueue';
import { getVideoRecordStore } from '../services/videoRecordStore';
import { isInputBlob, ProcessingJobMessage } from '../types/processing';

export async function queueVideoUploadHandler(event: EventGridEvent, context: InvocationContext): Promise<void> {
  const data = event.data as { url?: string };
  const blobUrl = data.url;

  if (!blobUrl) {
    throw new Error('EventGrid blob-created event is missing data.url');
  }

  const blob = parseBlobUrl(blobUrl);
  if (!isInputBlob(blob.blobName)) {
    context.log('queueVideoUpload skipping non-input blob', { blobUrl, blobName: blob.blobName });
    return;
  }

  const recordStore = getVideoRecordStore();
  const queue = getProcessingQueue('trim');
  const { created, record } = await recordStore.createFromUpload({
    containerName: blob.containerName,
    blobName: blob.blobName,
    blobUrl,
  });

  const trimJobToken = randomUUID();
  const trimJob: ProcessingJobMessage = {
    version: 1,
    jobType: 'trim',
    jobToken: trimJobToken,
    recordId: record.recordId,
    sourceContainer: record.sourceContainer,
    sourceBlobName: record.sourceBlobName,
  };

  if (!created) {
    if (record.status === 'uploaded' && record.currentStage === 'ingest') {
      await queue.enqueue(trimJob);
      await recordStore.markQueued(record.recordId, 'trim', 0, trimJobToken);

      context.log('queueVideoUpload recovered unqueued record and queued trim job', {
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

  await queue.enqueue(trimJob);
  await recordStore.markQueued(record.recordId, 'trim', 0, trimJobToken);

  context.log('queueVideoUpload queued trim job', {
    recordId: record.recordId,
    sourceBlobName: record.sourceBlobName,
  });
}

app.eventGrid('queueVideoUploadBlob', {
  handler: queueVideoUploadHandler,
});
