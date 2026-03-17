import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
import { TableClient } from '@azure/data-tables';
import { BlobServiceClient } from '@azure/storage-blob';

const router = Router();

const uploadsInputDir = path.resolve(process.cwd(), 'uploads/inputs');
const DEFAULT_MAX_VIDEO_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
const BLOB_CONTAINER = process.env.VIDEO_BLOB_CONTAINER || 'volleyball-videos';
const BLOB_FOLDER = 'input';
const VIDEO_RECORDS_TABLE_NAME = process.env.VIDEO_RECORDS_TABLE_NAME || 'videoprocessingrecords';
const MAX_VIDEO_BYTES = getMaxVideoBytes();

type VideoStatusRecord = {
  partitionKey: string;
  rowKey: string;
  recordId: string;
  sourceContainer: string;
  sourceBlobName: string;
  sourceBlobUrl: string;
  status: string;
  currentStage: string;
  uploadedAt: string;
  updatedAt: string;
  queuedAt?: string;
  processingStartedAt?: string;
  completedAt?: string;
  failedAt?: string;
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
  processedBlobName?: string;
  processedBlobUrl?: string;
  processedOutputFolder?: string;
  processedSceneCount?: number;
  detectionBlobName?: string;
  detectionBlobUrl?: string;
  errorMessage?: string;
};

function getMaxVideoBytes(): number {
  const configured = Number.parseInt(process.env.VIDEO_UPLOAD_MAX_BYTES ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_VIDEO_BYTES;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function getBlobServiceClient(): BlobServiceClient {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
  }
  return BlobServiceClient.fromConnectionString(connectionString);
}

function getTableClient(): TableClient {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
  }
  return TableClient.fromConnectionString(connectionString, VIDEO_RECORDS_TABLE_NAME);
}

function buildVideoRecordId(containerName: string, blobName: string): string {
  return createHash('sha256')
    .update(`${containerName}/${blobName}`)
    .digest('hex');
}

async function uploadToBlob(filePath: string, blobName: string): Promise<string> {
  const blobService = getBlobServiceClient();
  const containerClient = blobService.getContainerClient(BLOB_CONTAINER);
  await containerClient.createIfNotExists();
  const blockBlobClient = containerClient.getBlockBlobClient(`${BLOB_FOLDER}/${blobName}`);
  await blockBlobClient.uploadFile(filePath);
  return blockBlobClient.url;
}

const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
] as const;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsInputDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = randomUUID();
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (ALLOWED_VIDEO_MIME_TYPES.includes(file.mimetype as typeof ALLOWED_VIDEO_MIME_TYPES[number])) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only video files are allowed.'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_VIDEO_BYTES }
});

const uploadSingleVideo = upload.single('video');

// TODO: Update to call the Function App video-processing endpoint
router.post('/trim', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), (req: Request, res: Response): void => {
  uploadSingleVideo(req, res, async (error?: unknown) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `File exceeds the upload limit of ${formatBytes(MAX_VIDEO_BYTES)}.` });
      return;
    }

    if (error) {
      console.error('Upload middleware error:', error);
      res.status(400).json({ error: 'Failed to read the uploaded file.' });
      return;
    }

    try {
      if (!req.file) {
        res.status(400).json({ error: 'No video file provided.' });
        return;
      }

      const blobName = req.file.filename;
      const blobUrl = await uploadToBlob(req.file.path, blobName);
      const fullBlobName = `${BLOB_FOLDER}/${blobName}`;
      const recordId = buildVideoRecordId(BLOB_CONTAINER, fullBlobName);

      // Clean up local temp file
      fs.unlink(req.file.path, () => {});

      res.json({
        success: true,
        recordId,
        blobUrl,
        blobName: fullBlobName,
        container: BLOB_CONTAINER,
      });
    } catch (handlerError) {
      console.error('Upload error:', handlerError);
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: 'Failed to upload video' });
    }
  });
});

router.get('/config', (_req: Request, res: Response): void => {
  res.json({
    maxVideoBytes: MAX_VIDEO_BYTES,
    maxVideoSizeLabel: formatBytes(MAX_VIDEO_BYTES),
  });
});

router.get('/status/:recordId', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const tableClient = getTableClient();
    let record: VideoStatusRecord;

    try {
      record = await tableClient.getEntity<VideoStatusRecord>('video', recordId);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode?: number }).statusCode) === 404) {
        res.status(404).json({ error: 'Video status not found yet', recordId });
        return;
      }
      throw error;
    }

    res.json({
      recordId: record.recordId,
      status: record.status,
      currentStage: record.currentStage,
      sourceContainer: record.sourceContainer,
      sourceBlobName: record.sourceBlobName,
      sourceBlobUrl: record.sourceBlobUrl,
      uploadedAt: record.uploadedAt,
      updatedAt: record.updatedAt,
      queuedAt: record.queuedAt,
      processingStartedAt: record.processingStartedAt,
      completedAt: record.completedAt,
      failedAt: record.failedAt,
      errorMessage: record.errorMessage,
      processedBlobName: record.processedBlobName,
      processedBlobUrl: record.processedBlobUrl,
      processedOutputFolder: record.processedOutputFolder,
      processedSceneCount: record.processedSceneCount,
      detectionBlobName: record.detectionBlobName,
      detectionBlobUrl: record.detectionBlobUrl,
      trim: {
        queuedAt: record.trimQueuedAt,
        startedAt: record.trimStartedAt,
        completedAt: record.trimCompletedAt,
        failedAt: record.trimFailedAt,
        durationMs: record.trimDurationMs,
        retryCount: record.trimRetryCount ?? 0,
        errorMessage: record.trimErrorMessage,
      },
      detect: {
        queuedAt: record.detectQueuedAt,
        startedAt: record.detectStartedAt,
        completedAt: record.detectCompletedAt,
        failedAt: record.detectFailedAt,
        durationMs: record.detectDurationMs,
        retryCount: record.detectRetryCount ?? 0,
        errorMessage: record.detectErrorMessage,
      },
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: 'Failed to load video status' });
  }
});

router.get('/list', async (_req: Request, res: Response): Promise<void> => {
  try {
    const blobService = getBlobServiceClient();
    const containerClient = blobService.getContainerClient(BLOB_CONTAINER);
    const videos: { name: string; url: string; createdOn?: Date }[] = [];

    for await (const blob of containerClient.listBlobsFlat({ prefix: `${BLOB_FOLDER}/` })) {
      const blobClient = containerClient.getBlobClient(blob.name);
      videos.push({
        name: blob.name.replace(`${BLOB_FOLDER}/`, ''),
        url: blobClient.url,
        createdOn: blob.properties.createdOn,
      });
    }

    res.json({ videos });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

export default router;
