import { createHash } from 'crypto';

export const VIDEO_RECORD_PARTITION_KEY = 'video';
export const PROCESSING_INPUT_PREFIX = 'input/';
export const PROCESSING_OUTPUT_PREFIX = 'processed/';
export const PROCESSING_DETECTION_PREFIX = 'detections/';

export type ProcessingJobType = 'convert' | 'trim' | 'detect';
export type VideoProcessingStatus = 'uploaded' | 'queued' | 'processing' | 'completed' | 'failed';
export type VideoProcessingStage = 'ingest' | 'import' | 'convert' | 'trim' | 'detect' | 'completed';

export interface UploadedVideoDescriptor {
  containerName: string;
  blobName: string;
  blobUrl: string;
}

export interface UrlImportDescriptor extends UploadedVideoDescriptor {
  requestedVideoUrl: string;
}

export interface ProcessingJobMessage {
  version: 1;
  jobType: ProcessingJobType;
  jobToken: string;
  recordId: string;
  sourceContainer: string;
  sourceBlobName: string;
  convertedBlobName?: string;
  processedBlobName?: string;
}

export interface VideoRecordEntity {
  partitionKey: string;
  rowKey: string;
  recordId: string;
  requestedVideoUrl?: string;
  sourceContainer: string;
  sourceBlobName: string;
  sourceBlobUrl: string;
  status: VideoProcessingStatus;
  currentStage: VideoProcessingStage | 'failed';
  uploadedAt: string;
  updatedAt: string;
  queuedAt?: string;
  processingStartedAt?: string;
  completedAt?: string;
  failedAt?: string;
  importQueuedAt?: string;
  importStartedAt?: string;
  importCompletedAt?: string;
  importFailedAt?: string;
  importDurationMs?: number;
  importRetryCount?: number;
  importErrorMessage?: string;
  convertQueuedAt?: string;
  convertStartedAt?: string;
  convertCompletedAt?: string;
  convertFailedAt?: string;
  convertDurationMs?: number;
  convertRetryCount?: number;
  convertErrorMessage?: string;
  trimQueuedAt?: string;
  trimStartedAt?: string;
  trimCompletedAt?: string;
  trimFailedAt?: string;
  trimDurationMs?: number;
  trimRetryCount?: number;
  trimErrorMessage?: string;
  detectQueuedAt?: string;
  detectStartedAt?: string;
  detectCompletedAt?: string;
  detectFailedAt?: string;
  detectDurationMs?: number;
  detectRetryCount?: number;
  detectErrorMessage?: string;
  convertJobToken?: string;
  trimJobToken?: string;
  detectJobToken?: string;
  lastJobType?: ProcessingJobType;
  convertedBlobName?: string;
  convertedBlobUrl?: string;
  processedBlobName?: string;
  processedBlobUrl?: string;
  processedOutputFolder?: string;
  processedSceneCount?: number;
  detectionBlobName?: string;
  detectionBlobUrl?: string;
  playerManifestBlobName?: string;
  playerManifestBlobUrl?: string;
  detectedPlayerCount?: number;
  errorMessage?: string;
}

export function buildVideoRecordId(containerName: string, blobName: string): string {
  return createHash('sha256')
    .update(`${containerName}/${blobName}`)
    .digest('hex');
}

export function createUploadedVideoEntity(upload: UploadedVideoDescriptor): VideoRecordEntity {
  const now = new Date().toISOString();
  const recordId = buildVideoRecordId(upload.containerName, upload.blobName);

  return {
    partitionKey: VIDEO_RECORD_PARTITION_KEY,
    rowKey: recordId,
    recordId,
    sourceContainer: upload.containerName,
    sourceBlobName: upload.blobName,
    sourceBlobUrl: upload.blobUrl,
    status: 'uploaded',
    currentStage: 'ingest',
    uploadedAt: now,
    updatedAt: now,
    convertRetryCount: 0,
    trimRetryCount: 0,
    detectRetryCount: 0,
  };
}

export function createUrlImportEntity(importRequest: UrlImportDescriptor): VideoRecordEntity {
  const now = new Date().toISOString();
  const recordId = buildVideoRecordId(importRequest.containerName, importRequest.blobName);

  return {
    partitionKey: VIDEO_RECORD_PARTITION_KEY,
    rowKey: recordId,
    recordId,
    requestedVideoUrl: importRequest.requestedVideoUrl,
    sourceContainer: importRequest.containerName,
    sourceBlobName: importRequest.blobName,
    sourceBlobUrl: importRequest.blobUrl,
    status: 'queued',
    currentStage: 'import',
    uploadedAt: now,
    updatedAt: now,
    queuedAt: now,
    importQueuedAt: now,
    importRetryCount: 0,
    convertRetryCount: 0,
    trimRetryCount: 0,
    detectRetryCount: 0,
  };
}

export function isInputBlob(blobName: string): boolean {
  return blobName.startsWith(PROCESSING_INPUT_PREFIX);
}

export function isProcessedBlob(blobName: string): boolean {
  return blobName.startsWith(PROCESSING_OUTPUT_PREFIX);
}
