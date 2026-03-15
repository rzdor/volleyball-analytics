import { createHash } from 'crypto';

export const VIDEO_RECORD_PARTITION_KEY = 'video';
export const PROCESSING_INPUT_PREFIX = 'input/';
export const PROCESSING_OUTPUT_PREFIX = 'processed/';
export const PROCESSING_DETECTION_PREFIX = 'detections/';

export type ProcessingJobType = 'trim' | 'detect';
export type VideoProcessingStatus = 'uploaded' | 'queued' | 'processing' | 'completed' | 'failed';
export type VideoProcessingStage = 'ingest' | 'trim' | 'detect' | 'completed';

export interface UploadedVideoDescriptor {
  containerName: string;
  blobName: string;
  blobUrl: string;
}

export interface ProcessingJobMessage {
  version: 1;
  jobType: ProcessingJobType;
  recordId: string;
  sourceContainer: string;
  sourceBlobName: string;
  processedBlobName?: string;
}

export interface VideoRecordEntity {
  partitionKey: string;
  rowKey: string;
  recordId: string;
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
  lastJobType?: ProcessingJobType;
  processedBlobName?: string;
  processedBlobUrl?: string;
  detectionBlobName?: string;
  detectionBlobUrl?: string;
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
  };
}

export function isInputBlob(blobName: string): boolean {
  return blobName.startsWith(PROCESSING_INPUT_PREFIX);
}

export function isProcessedBlob(blobName: string): boolean {
  return blobName.startsWith(PROCESSING_OUTPUT_PREFIX);
}
