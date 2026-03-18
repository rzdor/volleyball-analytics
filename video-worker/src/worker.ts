import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DequeuedMessageItem } from '@azure/storage-queue';
import { detectPlayers } from './services/playerDetector';
import { downloadBlobToFile } from './services/blobUtils';
import { buildPlayerManifest } from './services/playerProfiles';
import { getProcessingQueue, ProcessingQueueName } from './services/processingQueue';
import { createVideoStorage } from './services/storageProvider';
import { NoSegmentsDetectedError, runTrimPipeline } from './services/trimPipeline';
import { convertVideoTo720p } from './services/videoConverter';
import { getVideoRecordStore } from './services/videoRecordStore';
import { ProcessingJobMessage } from './types/processing';

const convertQueue = getProcessingQueue('convert');
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

  if (parsed.version !== 1 || !parsed.jobType || !parsed.jobToken || !parsed.recordId || !parsed.sourceContainer || !parsed.sourceBlobName) {
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

function getRetryCount(message: DequeuedMessageItem): number {
  const dequeueCount = Number(message.dequeueCount ?? 1);
  if (!Number.isFinite(dequeueCount) || dequeueCount <= 1) {
    return 0;
  }

  return dequeueCount - 1;
}

function isRedelivery(message: DequeuedMessageItem): boolean {
  return getRetryCount(message) > 0;
}

function getStageJobToken(jobType: ProcessingJobMessage['jobType'], record: Awaited<ReturnType<typeof recordStore.get>>): string | undefined {
  if (!record) {
    return undefined;
  }

  if (jobType === 'convert') {
    return record.convertJobToken;
  }

  return jobType === 'trim' ? record.trimJobToken : record.detectJobToken;
}

async function runConvertJob(job: ProcessingJobMessage, retryCount: number): Promise<void> {
  const convertStartedAt = await recordStore.markProcessing(job.recordId, 'convert', retryCount);
  const tempInputPath = getTempVideoPath('convert', job.sourceBlobName);
  const sourceBaseName = path.basename(job.sourceBlobName, path.extname(job.sourceBlobName));
  const convertedFilename = path.posix.join(job.recordId, `${sourceBaseName}-720p.mp4`);
  const localConvertedPath = path.join(storage.getLocalOutputDir(), convertedFilename);

  fs.mkdirSync(path.dirname(localConvertedPath), { recursive: true });

  try {
    await downloadBlobToFile({
      containerName: job.sourceContainer,
      blobName: job.sourceBlobName,
    }, tempInputPath);

    await convertVideoTo720p(tempInputPath, localConvertedPath);

    const storedConverted = await storage.saveOutput(localConvertedPath, convertedFilename);
    const convertedBlobName = `processed/${storedConverted.name}`;
    const trimJob: ProcessingJobMessage = {
      version: 1,
      jobType: 'trim',
      jobToken: randomUUID(),
      recordId: job.recordId,
      sourceContainer: job.sourceContainer,
      sourceBlobName: job.sourceBlobName,
      convertedBlobName,
    };

    await trimQueue.enqueue(trimJob);
    await recordStore.markConvertCompletedAndQueueTrim(
      job.recordId,
      convertedBlobName,
      storedConverted.url,
      convertStartedAt,
      trimJob.jobToken
    );

    console.log('[worker] Convert job completed', {
      recordId: job.recordId,
      convertedBlobName,
      trimJobToken: trimJob.jobToken,
    });
  } finally {
    if (fs.existsSync(tempInputPath)) {
      fs.unlinkSync(tempInputPath);
    }

    if (storage.isRemoteStorage() && fs.existsSync(localConvertedPath)) {
      fs.unlinkSync(localConvertedPath);
    }
  }
}

async function runTrimJob(job: ProcessingJobMessage, retryCount: number): Promise<void> {
  const trimStartedAt = await recordStore.markProcessing(job.recordId, 'trim', retryCount);
  const trimInputBlobName = job.convertedBlobName ?? job.sourceBlobName;
  const tempInputPath = getTempVideoPath('trim', trimInputBlobName);

  try {
    await downloadBlobToFile({
      containerName: job.sourceContainer,
      blobName: trimInputBlobName,
    }, tempInputPath);

    const sourceBaseName = path.basename(job.sourceBlobName, path.extname(job.sourceBlobName));
    const outputFolder = path.posix.join('processed', job.recordId);
    const trimResult = await runTrimPipeline({
      videoPath: tempInputPath,
      storage,
      persistInput: false,
      outputFilename: path.posix.join(job.recordId, `${sourceBaseName}-trimmed.mp4`),
      sceneOutputPrefix: job.recordId,
    });
    const processedBlobName = `processed/${trimResult.storedOutput.name}`;

    const detectJob: ProcessingJobMessage = {
      version: 1,
      jobType: 'detect',
      jobToken: randomUUID(),
      recordId: job.recordId,
      sourceContainer: job.sourceContainer,
      sourceBlobName: job.sourceBlobName,
      convertedBlobName: job.convertedBlobName,
      processedBlobName,
    };

    await detectQueue.enqueue(detectJob);
    await recordStore.markTrimCompletedAndQueueDetect(
      job.recordId,
      processedBlobName,
      trimResult.storedOutput.url,
      trimStartedAt,
      detectJob.jobToken,
      outputFolder,
      trimResult.storedScenes.length
    );

    console.log('[worker] Trim job completed', {
      recordId: job.recordId,
      processedBlobName,
      processedSceneCount: trimResult.storedScenes.length,
      processedOutputFolder: outputFolder,
      detectJobToken: detectJob.jobToken,
    });
  } finally {
    if (fs.existsSync(tempInputPath)) {
      fs.unlinkSync(tempInputPath);
    }
  }
}

async function runDetectJob(job: ProcessingJobMessage, retryCount: number): Promise<void> {
  const detectStartedAt = await recordStore.markProcessing(job.recordId, 'detect', retryCount);

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
    const playerManifestResult = await buildPlayerManifest({
      recordId: job.recordId,
      videoPath: tempInputPath,
      sourceVideoBlobName: job.sourceBlobName,
      processedBlobName: job.processedBlobName!,
      detectionResult: result,
      storage,
    });

    await recordStore.markDetectCompleted(
      job.recordId,
      `detections/${storedDetection.name}`,
      storedDetection.url,
      detectStartedAt,
      playerManifestResult.manifestBlobName,
      playerManifestResult.manifestUrl,
      playerManifestResult.manifest.players.length
    );

    console.log('[worker] Detect job completed', {
      recordId: job.recordId,
      detectionBlobName: `detections/${storedDetection.name}`,
      playerManifestBlobName: playerManifestResult.manifestBlobName,
      detectedPlayerCount: playerManifestResult.manifest.players.length,
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
    const retryCount = getRetryCount(message);
    const record = await recordStore.get(job.recordId);

    if (!record) {
      throw new Error(`No video record found for job ${job.recordId}`);
    }

    if (job.jobToken !== getStageJobToken(job.jobType, record)) {
      console.log('[worker] Skipping stale stage message', {
        recordId: job.recordId,
        jobType: job.jobType,
      });
      return;
    }

    if (job.jobType === 'convert' && (record.convertedBlobName || record.currentStage === 'trim' || record.currentStage === 'detect' || record.currentStage === 'completed' || record.status === 'completed')) {
      console.log('[worker] Skipping duplicate convert job', { recordId: job.recordId });
      return;
    }

    if (job.jobType === 'trim' && (record.processedBlobName || record.currentStage === 'detect' || record.currentStage === 'completed' || record.status === 'completed')) {
      console.log('[worker] Skipping duplicate trim job', { recordId: job.recordId });
      return;
    }

    if (job.jobType === 'detect' && (record.detectionBlobName || record.currentStage === 'completed' || record.status === 'completed')) {
      console.log('[worker] Skipping duplicate detect job', { recordId: job.recordId });
      return;
    }

    if (isRedelivery(message)) {
      const errorMessage = `Queue message was delivered more than once for ${job.jobType}; retries are disabled.`;
      await recordStore.markFailed(job.recordId, job.jobType, errorMessage, getRetryCount(message));
      console.error('[worker] Marking redelivered message as failed', {
        recordId: job.recordId,
        jobType: job.jobType,
        dequeueCount: message.dequeueCount,
      });
      return;
    }

    if (job.jobType === 'convert') {
      await runConvertJob(job, retryCount);
    } else if (job.jobType === 'trim') {
      await runTrimJob(job, retryCount);
    } else {
      await runDetectJob(job, retryCount);
    }
  } catch (error) {
    if (error instanceof NoSegmentsDetectedError && recordIdForFailure) {
      await recordStore.markFailed(recordIdForFailure, 'trim', 'No motion segments detected', getRetryCount(message));
    } else if (recordIdForFailure) {
      await recordStore.markFailed(recordIdForFailure, jobTypeForFailure, getErrorMessage(error), getRetryCount(message));
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

    const convertMessages = await convertQueue.receive(1, visibilityTimeoutSeconds);
    if (convertMessages.length > 0) {
      for (const message of convertMessages) {
        await handleMessage(message, 'convert');
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
