import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { DequeuedMessageItem } from '@azure/storage-queue';
import { getCosmosReadModelStore } from './services/cosmosReadModelStore';
import { DetectionResult, detectPlayers } from './services/playerDetector';
import { downloadBlobToFile } from './services/blobUtils';
import { inferPlayerBallContacts } from './services/contactDetector';
import { getVideoMetadata } from './services/frameExtractor';
import { buildPlayerManifest } from './services/playerProfiles';
import { buildPlayDescriptionsManifest, buildPlaySceneManifest, PlaySceneManifest } from './services/playDescriptions';
import { getProcessingQueue, ProcessingQueueName } from './services/processingQueue';
import { createVideoStorage } from './services/storageProvider';
import { NoSegmentsDetectedError, runTrimPipeline } from './services/trimPipeline';
import { convertVideoTo720p, shouldConvertTo720p } from './services/videoConverter';
import { getVideoRecordStore } from './services/videoRecordStore';
import { ProcessingJobMessage } from './types/processing';

const convertQueue = getProcessingQueue('convert');
const trimQueue = getProcessingQueue('trim');
const detectQueue = getProcessingQueue('detect');
const recordStore = getVideoRecordStore();
const readModelStore = getCosmosReadModelStore();
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

function getPlaySceneManifestRelativePath(recordId: string): string {
  return path.posix.join(recordId, 'plays', 'scenes.json');
}

function getPlayManifestRelativePath(recordId: string): string {
  return path.posix.join(recordId, 'plays', 'manifest.json');
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

function buildDetectionSummary(result: DetectionResult) {
  let peakPlayersInFrame = 0;

  for (const frame of result.frames) {
    peakPlayersInFrame = Math.max(peakPlayersInFrame, frame.players.length);
  }

  return {
    playerCount: result.tracks.length,
    peakPlayersInFrame,
    sampledFrames: result.sampledFrames,
    teamCount: result.teams.length,
  };
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

  try {
    await downloadBlobToFile({
      containerName: job.sourceContainer,
      blobName: job.sourceBlobName,
    }, tempInputPath);

    const metadata = await getVideoMetadata(tempInputPath);
    if (metadata.height <= 0) {
      throw new Error(`Unable to determine source video height for ${job.sourceBlobName}`);
    }

    let convertedBlobName: string | undefined;
    let convertedBlobUrl: string | undefined;

    if (shouldConvertTo720p(metadata.height)) {
      fs.mkdirSync(path.dirname(localConvertedPath), { recursive: true });
      await convertVideoTo720p(tempInputPath, localConvertedPath);

      const storedConverted = await storage.saveOutput(localConvertedPath, convertedFilename);
      convertedBlobName = `processed/${storedConverted.name}`;
      convertedBlobUrl = storedConverted.url;
    } else {
      console.log('[worker] Skipping conversion for source already at or below 720p', {
        recordId: job.recordId,
        sourceBlobName: job.sourceBlobName,
        width: metadata.width,
        height: metadata.height,
      });
    }

    const trimJob: ProcessingJobMessage = {
      version: 1,
      jobType: 'trim',
      jobToken: randomUUID(),
      recordId: job.recordId,
      sourceContainer: job.sourceContainer,
      sourceBlobName: job.sourceBlobName,
      ...(convertedBlobName ? { convertedBlobName } : {}),
    };

    await trimQueue.enqueue(trimJob);
    await recordStore.markConvertCompletedAndQueueTrim(
      job.recordId,
      convertedBlobName,
      convertedBlobUrl,
      convertStartedAt,
      trimJob.jobToken
    );

    console.log('[worker] Convert job completed', {
      recordId: job.recordId,
      convertedBlobName: convertedBlobName ?? job.sourceBlobName,
      skippedConversion: !convertedBlobName,
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
    const playSceneManifest = buildPlaySceneManifest({
      recordId: job.recordId,
      sourceVideoBlobName: job.sourceBlobName,
      processedBlobName,
      segments: trimResult.segments,
      storedScenes: trimResult.storedScenes,
    });
    const playSceneManifestRelativePath = getPlaySceneManifestRelativePath(job.recordId);
    const playSceneManifestOutputPath = path.join(storage.getLocalOutputDir(), playSceneManifestRelativePath);
    fs.mkdirSync(path.dirname(playSceneManifestOutputPath), { recursive: true });
    fs.writeFileSync(playSceneManifestOutputPath, JSON.stringify(playSceneManifest, null, 2));
    await storage.saveOutput(playSceneManifestOutputPath, playSceneManifestRelativePath);

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

    const playSceneManifestOutputPath = path.join(storage.getLocalOutputDir(), getPlaySceneManifestRelativePath(job.recordId));
    if (storage.isRemoteStorage() && fs.existsSync(playSceneManifestOutputPath)) {
      fs.unlinkSync(playSceneManifestOutputPath);
    }
  }
}

async function runDetectJob(job: ProcessingJobMessage, retryCount: number): Promise<void> {
  const detectStartedAt = await recordStore.markProcessing(job.recordId, 'detect', retryCount);

  const tempInputPath = getTempVideoPath('detect', job.processedBlobName!);
  const playSceneManifestPath = path.join(storage.getLocalOutputDir(), getPlaySceneManifestRelativePath(job.recordId));
  const playManifestPath = path.join(storage.getLocalOutputDir(), getPlayManifestRelativePath(job.recordId));
  const detectionDir = storage.getLocalDetectionDir();

  try {
    await downloadBlobToFile({
      containerName: job.sourceContainer,
      blobName: job.processedBlobName!,
    }, tempInputPath);
    await downloadBlobToFile({
      containerName: job.sourceContainer,
      blobName: `processed/${getPlaySceneManifestRelativePath(job.recordId)}`,
    }, playSceneManifestPath);

    const playSceneManifest = JSON.parse(fs.readFileSync(playSceneManifestPath, 'utf-8')) as PlaySceneManifest;
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
    const contactEvents = inferPlayerBallContacts(result);
    const playDescriptions = buildPlayDescriptionsManifest({
      recordId: job.recordId,
      sourceVideoBlobName: job.sourceBlobName,
      processedBlobName: job.processedBlobName!,
      sceneManifest: playSceneManifest,
      contactEvents,
    });
    fs.mkdirSync(path.dirname(playManifestPath), { recursive: true });
    fs.writeFileSync(playManifestPath, JSON.stringify(playDescriptions, null, 2));
    const storedPlayManifest = await storage.saveOutput(playManifestPath, getPlayManifestRelativePath(job.recordId));

    await recordStore.markDetectCompleted(
      job.recordId,
      `detections/${storedDetection.name}`,
      storedDetection.url,
      detectStartedAt,
      playerManifestResult.manifestBlobName,
      playerManifestResult.manifestUrl,
      playerManifestResult.manifest.players.length,
      `processed/${storedPlayManifest.name}`,
      storedPlayManifest.url,
      playDescriptions.playCount
    );
    await readModelStore?.mergeVideoRecord(job.recordId, {
      detectionSummary: buildDetectionSummary(result),
      playerManifestGeneratedAt: playerManifestResult.manifest.generatedAt,
      playDescriptionsGeneratedAt: playDescriptions.generatedAt,
      updatedAt: new Date().toISOString(),
    });

    console.log('[worker] Detect job completed', {
      recordId: job.recordId,
      detectionBlobName: `detections/${storedDetection.name}`,
      playerManifestBlobName: playerManifestResult.manifestBlobName,
      playDescriptionsBlobName: `processed/${storedPlayManifest.name}`,
      playCount: playDescriptions.playCount,
      detectedPlayerCount: playerManifestResult.manifest.players.length,
    });

    if (fs.existsSync(detectionJsonPath)) {
      fs.unlinkSync(detectionJsonPath);
    }
  } finally {
    if (fs.existsSync(tempInputPath)) {
      fs.unlinkSync(tempInputPath);
    }

    if (storage.isRemoteStorage() && fs.existsSync(playSceneManifestPath)) {
      fs.unlinkSync(playSceneManifestPath);
    }

    if (storage.isRemoteStorage() && fs.existsSync(playManifestPath)) {
      fs.unlinkSync(playManifestPath);
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
