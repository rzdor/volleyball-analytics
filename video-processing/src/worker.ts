import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DequeuedMessageItem } from '@azure/storage-queue';
import { detectPlayers } from './services/playerDetector';
import { downloadBlobToFile } from './services/blobUtils';
import { getProcessingQueue, ProcessingQueueName } from './services/processingQueue';
import { createVideoStorage } from './services/storageProvider';
import { NoSegmentsDetectedError, runTrimPipeline } from './services/trimPipeline';
import { getVideoRecordStore } from './services/videoRecordStore';
import { ProcessingJobMessage } from './types/processing';

const trimQueue = getProcessingQueue('trim');
const detectQueue = getProcessingQueue('detect');
const recordStore = getVideoRecordStore();
const storage = createVideoStorage({
  baseDir: path.join(os.tmpdir(), 'va-processing-worker'),
  inputFolder: process.env.AZURE_STORAGE_INPUT_FOLDER ?? 'input',
});

const pollIntervalMs = Number.parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? '5000', 10);
const visibilityTimeoutSeconds = Number.parseInt(process.env.WORKER_VISIBILITY_TIMEOUT_SECONDS ?? '900', 10);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseJobMessage(messageText: string): ProcessingJobMessage {
  const parsed = JSON.parse(messageText) as Partial<ProcessingJobMessage>;

  if (parsed.version !== 1 || !parsed.jobType || !parsed.recordId || !parsed.sourceContainer || !parsed.sourceBlobName) {
    throw new Error(`Invalid queue message payload: ${messageText}`);
  }

  if (parsed.jobType === 'detect' && !parsed.processedBlobName) {
    throw new Error(`Detect job is missing processedBlobName: ${messageText}`);
  }

  return parsed as ProcessingJobMessage;
}

function getTempVideoPath(prefix: string, blobName: string): string {
  const filename = `${prefix}-${randomUUID()}-${path.basename(blobName)}`;
  return path.join(os.tmpdir(), 'va-processing-worker', 'inputs', filename);
}

function getErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 2000 ? `${raw.slice(0, 1997)}...` : raw;
}

async function runTrimJob(job: ProcessingJobMessage): Promise<void> {
  await recordStore.markProcessing(job.recordId, 'trim');

  const tempInputPath = getTempVideoPath('trim', job.sourceBlobName);

  try {
    await downloadBlobToFile({
      containerName: job.sourceContainer,
      blobName: job.sourceBlobName,
    }, tempInputPath);

    const sourceBaseName = path.basename(job.sourceBlobName, path.extname(job.sourceBlobName));
    const trimResult = await runTrimPipeline({
      videoPath: tempInputPath,
      storage,
      persistInput: false,
      outputFilename: `${sourceBaseName}-trimmed.mp4`,
    });

    await recordStore.update(job.recordId, {
      processedBlobName: `processed/${trimResult.storedOutput.name}`,
      processedBlobUrl: trimResult.storedOutput.url,
    });

    const detectJob: ProcessingJobMessage = {
      version: 1,
      jobType: 'detect',
      recordId: job.recordId,
      sourceContainer: job.sourceContainer,
      sourceBlobName: job.sourceBlobName,
      processedBlobName: `processed/${trimResult.storedOutput.name}`,
    };

    await detectQueue.enqueue(detectJob);
    await recordStore.markQueued(job.recordId, 'detect');
  } finally {
    if (fs.existsSync(tempInputPath)) {
      fs.unlinkSync(tempInputPath);
    }
  }
}

async function runDetectJob(job: ProcessingJobMessage): Promise<void> {
  await recordStore.markProcessing(job.recordId, 'detect');

  const tempInputPath = getTempVideoPath('detect', job.processedBlobName!);

  try {
    await downloadBlobToFile({
      containerName: job.sourceContainer,
      blobName: job.processedBlobName!,
    }, tempInputPath);

    const detectionDir = storage.getLocalDetectionDir();
    const result = await detectPlayers(tempInputPath, detectionDir);
    const detectionFilename = `${path.basename(job.processedBlobName!, path.extname(job.processedBlobName!))}-detection.json`;
    const detectionJsonPath = path.join(detectionDir, detectionFilename);
    fs.writeFileSync(detectionJsonPath, JSON.stringify(result, null, 2));

    const storedDetection = await storage.saveDetection(detectionJsonPath, detectionFilename);

    await recordStore.update(job.recordId, {
      status: 'completed',
      currentStage: 'completed',
      completedAt: new Date().toISOString(),
      detectionBlobName: `detections/${storedDetection.name}`,
      detectionBlobUrl: storedDetection.url,
      errorMessage: '',
      failedAt: '',
    });

    if (fs.existsSync(detectionJsonPath)) {
      fs.unlinkSync(detectionJsonPath);
    }
  } finally {
    if (fs.existsSync(tempInputPath)) {
      fs.unlinkSync(tempInputPath);
    }
  }
}

async function handleMessage(message: DequeuedMessageItem, queueName: ProcessingQueueName): Promise<void> {
  let jobTypeForFailure: ProcessingJobMessage['jobType'] = 'trim';
  let recordIdForFailure: string | undefined;

  try {
    const job = parseJobMessage(message.messageText);
    jobTypeForFailure = job.jobType;
    recordIdForFailure = job.recordId;
    const record = await recordStore.get(job.recordId);

    if (!record) {
      throw new Error(`No video record found for job ${job.recordId}`);
    }

    if (job.jobType === 'trim' && (record.processedBlobName || record.currentStage === 'detect' || record.currentStage === 'completed' || record.status === 'completed')) {
      console.log('[worker] Skipping duplicate trim job', { recordId: job.recordId });
      return;
    }

    if (job.jobType === 'detect' && (record.detectionBlobName || record.currentStage === 'completed' || record.status === 'completed')) {
      console.log('[worker] Skipping duplicate detect job', { recordId: job.recordId });
      return;
    }

    if (job.jobType === 'trim') {
      await runTrimJob(job);
    } else {
      await runDetectJob(job);
    }
  } catch (error) {
    if (error instanceof NoSegmentsDetectedError && recordIdForFailure) {
      await recordStore.markFailed(recordIdForFailure, 'trim', 'No motion segments detected');
    } else if (recordIdForFailure) {
      await recordStore.markFailed(recordIdForFailure, jobTypeForFailure, getErrorMessage(error));
    }

    console.error('[worker] Failed to process queue message', error);
  } finally {
    await getProcessingQueue(queueName).deleteMessage(message.messageId, message.popReceipt);
  }
}

async function runWorker(): Promise<void> {
  console.log('[worker] Starting video-processing worker', {
    pollIntervalMs,
    visibilityTimeoutSeconds,
  });

  while (true) {
    const detectMessages = await detectQueue.receive(1, visibilityTimeoutSeconds);
    if (detectMessages.length > 0) {
      for (const message of detectMessages) {
        await handleMessage(message, 'detect');
      }
      continue;
    }

    const trimMessages = await trimQueue.receive(1, visibilityTimeoutSeconds);
    if (trimMessages.length === 0) {
      await sleep(pollIntervalMs);
      continue;
    }

    for (const message of trimMessages) {
      await handleMessage(message, 'trim');
    }
  }
}

runWorker().catch(error => {
  console.error('[worker] Fatal startup error', error);
  process.exit(1);
});
