import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
import { TableClient } from '@azure/data-tables';
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';

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
};

type BlobAsset = {
  name: string;
  blobName: string;
  url: string;
  downloadUrl: string;
  size?: number;
  lastModified?: string;
};

type DetectionSummary = {
  playerCount: number;
  peakPlayersInFrame: number;
  sampledFrames: number;
  teamCount: number;
};

type PlayerManifestRecord = {
  recordId: string;
  generatedAt: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  players: Array<{
    trackId: number;
    teamId: number;
    frameCount: number;
    avgConfidence: number;
    bestConfidence?: number;
    sampleTimestamp?: number;
    imageBlobName?: string;
    displayName?: string;
    notes?: string;
  }>;
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
  return BlobServiceClient.fromConnectionString(getStorageConnectionString());
}

function getTableClient(): TableClient {
  return TableClient.fromConnectionString(getStorageConnectionString(), VIDEO_RECORDS_TABLE_NAME);
}

function getStorageConnectionString(): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
  }
  return connectionString;
}

function parseConnectionStringEntries(connectionString: string): Record<string, string> {
  return connectionString.split(';').reduce<Record<string, string>>((acc, part) => {
    const index = part.indexOf('=');
    if (index === -1) {
      return acc;
    }

    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (key && value) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function parseSharedKey(connectionString: string): StorageSharedKeyCredential | undefined {
  const entries = parseConnectionStringEntries(connectionString);
  const accountName = entries.AccountName;
  const accountKey = entries.AccountKey;

  if (!accountName || !accountKey) {
    return undefined;
  }

  return new StorageSharedKeyCredential(accountName, accountKey);
}

function getBlobContainerClient(containerName = BLOB_CONTAINER) {
  return getBlobServiceClient().getContainerClient(containerName);
}

function createBlobUrl(containerName: string, blobName: string, asAttachment = false, downloadName?: string): string {
  const connectionString = getStorageConnectionString();
  const containerClient = getBlobContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  const sharedKey = parseSharedKey(connectionString);

  if (!sharedKey) {
    return blobClient.url;
  }

  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + 60 * 60 * 1000);
  const sas = generateBlobSASQueryParameters({
    containerName,
    blobName,
    permissions: BlobSASPermissions.parse('r'),
    startsOn,
    expiresOn,
    contentDisposition: asAttachment
      ? `attachment; filename="${downloadName ?? path.basename(blobName)}"`
      : undefined,
  }, sharedKey).toString();

  return `${blobClient.url}?${sas}`;
}

function buildBlobAsset(containerName: string, blobName: string, size?: number, lastModified?: Date): BlobAsset {
  return {
    name: path.basename(blobName),
    blobName,
    url: createBlobUrl(containerName, blobName),
    downloadUrl: createBlobUrl(containerName, blobName, true),
    size,
    lastModified: lastModified?.toISOString(),
  };
}

async function readStreamAsString(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!stream) {
    return '';
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBlob<T>(containerName: string, blobName: string): Promise<T> {
  const blobClient = getBlobContainerClient(containerName).getBlobClient(blobName);
  const response = await blobClient.download();
  const raw = await readStreamAsString(response.readableStreamBody);
  return JSON.parse(raw) as T;
}

async function writeJsonBlob(containerName: string, blobName: string, payload: unknown): Promise<void> {
  const blobClient = getBlobContainerClient(containerName).getBlockBlobClient(blobName);
  const content = JSON.stringify(payload, null, 2);
  await blobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: {
      blobContentType: 'application/json',
    },
  });
}

async function getVideoRecord(recordId: string): Promise<VideoStatusRecord | undefined> {
  const tableClient = getTableClient();

  try {
    return await tableClient.getEntity<VideoStatusRecord>('video', recordId);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode?: number }).statusCode) === 404) {
      return undefined;
    }
    throw error;
  }
}

function mapStatusResponse(record: VideoStatusRecord) {
  return {
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
    convertedBlobName: record.convertedBlobName,
    convertedBlobUrl: record.convertedBlobName ? createBlobUrl(record.sourceContainer, record.convertedBlobName) : record.convertedBlobUrl,
    processedBlobName: record.processedBlobName,
    processedBlobUrl: record.processedBlobName ? createBlobUrl(record.sourceContainer, record.processedBlobName) : record.processedBlobUrl,
    processedOutputFolder: record.processedOutputFolder,
    processedSceneCount: record.processedSceneCount,
    detectionBlobName: record.detectionBlobName,
    detectionBlobUrl: record.detectionBlobName ? createBlobUrl(record.sourceContainer, record.detectionBlobName) : record.detectionBlobUrl,
    playerManifestBlobName: record.playerManifestBlobName,
    playerManifestBlobUrl: record.playerManifestBlobName ? createBlobUrl(record.sourceContainer, record.playerManifestBlobName) : record.playerManifestBlobUrl,
    detectedPlayerCount: record.detectedPlayerCount,
    convert: {
      queuedAt: record.convertQueuedAt,
      startedAt: record.convertStartedAt,
      completedAt: record.convertCompletedAt,
      failedAt: record.convertFailedAt,
      durationMs: record.convertDurationMs,
      retryCount: record.convertRetryCount ?? 0,
      errorMessage: record.convertErrorMessage,
    },
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
  };
}

async function listProcessedAssets(record: VideoStatusRecord): Promise<BlobAsset[]> {
  const prefix = `processed/${record.recordId}/`;
  const containerClient = getBlobContainerClient(record.sourceContainer);
  const assets: BlobAsset[] = [];

  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    assets.push(buildBlobAsset(
      record.sourceContainer,
      blob.name,
      blob.properties.contentLength,
      blob.properties.lastModified
    ));
  }

  return assets.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadDetectionSummary(record: VideoStatusRecord): Promise<DetectionSummary | undefined> {
  if (!record.detectionBlobName) {
    return undefined;
  }

  const detection = await readJsonBlob<{
    sampledFrames?: number;
    teams?: Array<{ id?: number }>;
    tracks?: Array<{ trackId?: number }>;
    frames?: Array<{ players?: Array<{ trackId?: number }> }>;
  }>(record.sourceContainer, record.detectionBlobName);

  const trackIds = new Set<number>();
  if (Array.isArray(detection.tracks)) {
    for (const track of detection.tracks) {
      if (typeof track.trackId === 'number' && track.trackId >= 0) {
        trackIds.add(track.trackId);
      }
    }
  }

  let peakPlayersInFrame = 0;
  if (Array.isArray(detection.frames)) {
    for (const frame of detection.frames) {
      const framePlayers = Array.isArray(frame.players) ? frame.players : [];
      peakPlayersInFrame = Math.max(peakPlayersInFrame, framePlayers.length);
      for (const player of framePlayers) {
        if (typeof player.trackId === 'number' && player.trackId >= 0) {
          trackIds.add(player.trackId);
        }
      }
    }
  }

  return {
    playerCount: trackIds.size > 0 ? trackIds.size : peakPlayersInFrame,
    peakPlayersInFrame,
    sampledFrames: typeof detection.sampledFrames === 'number'
      ? detection.sampledFrames
      : Array.isArray(detection.frames) ? detection.frames.length : 0,
    teamCount: Array.isArray(detection.teams) ? detection.teams.length : 0,
  };
}

async function loadPlayerManifest(record: VideoStatusRecord): Promise<PlayerManifestRecord | undefined> {
  if (!record.playerManifestBlobName) {
    return undefined;
  }

  try {
    return await readJsonBlob<PlayerManifestRecord>(record.sourceContainer, record.playerManifestBlobName);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode?: number }).statusCode) === 404) {
      return undefined;
    }
    throw error;
  }
}

function buildPlayerManifestResponse(record: VideoStatusRecord, manifest: PlayerManifestRecord | undefined) {
  if (!manifest) {
    return {
      generatedAt: undefined,
      players: [],
    };
  }

  return {
    generatedAt: manifest.generatedAt,
    players: manifest.players.map(player => ({
      ...player,
      imageUrl: player.imageBlobName ? createBlobUrl(record.sourceContainer, player.imageBlobName) : undefined,
      imageDownloadUrl: player.imageBlobName ? createBlobUrl(record.sourceContainer, player.imageBlobName, true) : undefined,
    })),
  };
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

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video status not found yet', recordId });
      return;
    }

    res.json(mapStatusResponse(record));
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: 'Failed to load video status' });
  }
});

router.get('/:recordId/details', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video details not found', recordId });
      return;
    }

    const processedAssets = await listProcessedAssets(record);
    const convertedVideo = record.convertedBlobName
      ? buildBlobAsset(record.sourceContainer, record.convertedBlobName)
      : undefined;
    const trimmedVideo = record.processedBlobName
      ? buildBlobAsset(record.sourceContainer, record.processedBlobName)
      : undefined;
    const detectionFile = record.detectionBlobName
      ? buildBlobAsset(record.sourceContainer, record.detectionBlobName)
      : undefined;
    const sourceVideo = buildBlobAsset(record.sourceContainer, record.sourceBlobName);
    const splitParts = processedAssets.filter(asset =>
      asset.blobName !== record.convertedBlobName && asset.blobName !== record.processedBlobName
    );
    const detectionSummary = await loadDetectionSummary(record);
    const playerManifest = await loadPlayerManifest(record);

    res.json({
      ...mapStatusResponse(record),
      sourceVideo,
      convertedVideo,
      trimmedVideo,
      splitParts,
      detectionFile,
      detectionSummary,
      playersPageUrl: `/videos/${encodeURIComponent(record.recordId)}/players`,
      playerManifest: buildPlayerManifestResponse(record, playerManifest),
    });
  } catch (error) {
    console.error('Video details error:', error);
    res.status(500).json({ error: 'Failed to load video details' });
  }
});

router.get('/:recordId/players', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video players not found', recordId });
      return;
    }

    const manifest = await loadPlayerManifest(record);
    res.json({
      ...mapStatusResponse(record),
      playersPageUrl: `/videos/${encodeURIComponent(record.recordId)}/players`,
      videoDetailsUrl: `/videos/${encodeURIComponent(record.recordId)}`,
      playerManifest: buildPlayerManifestResponse(record, manifest),
    });
  } catch (error) {
    console.error('Player manifest error:', error);
    res.status(500).json({ error: 'Failed to load player list' });
  }
});

router.put('/:recordId/players', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video players not found', recordId });
      return;
    }

    if (!record.playerManifestBlobName) {
      res.status(409).json({ error: 'Player manifest is not available for this video yet.' });
      return;
    }

    const currentManifest = await loadPlayerManifest(record);
    if (!currentManifest) {
      res.status(409).json({ error: 'Player manifest is not available for this video yet.' });
      return;
    }

    const requestedPlayers = Array.isArray(req.body?.players) ? req.body.players : undefined;
    if (!requestedPlayers) {
      res.status(400).json({ error: 'players array is required' });
      return;
    }

    const requestedByTrackId = new Map<number, { displayName?: string; notes?: string }>();
    for (const player of requestedPlayers) {
      if (typeof player?.trackId !== 'number') {
        continue;
      }

      requestedByTrackId.set(player.trackId, {
        displayName: typeof player.displayName === 'string' ? player.displayName.trim() : '',
        notes: typeof player.notes === 'string' ? player.notes.trim() : '',
      });
    }

    const updatedManifest: PlayerManifestRecord = {
      ...currentManifest,
      generatedAt: currentManifest.generatedAt,
      players: currentManifest.players.map(player => {
        const requested = requestedByTrackId.get(player.trackId);
        return requested
          ? {
              ...player,
              displayName: requested.displayName ?? '',
              notes: requested.notes ?? '',
            }
          : player;
      }),
    };

    await writeJsonBlob(record.sourceContainer, record.playerManifestBlobName, updatedManifest);

    res.json({
      success: true,
      playerManifest: buildPlayerManifestResponse(record, updatedManifest),
    });
  } catch (error) {
    console.error('Player manifest update error:', error);
    res.status(500).json({ error: 'Failed to update player list' });
  }
});

router.get('/list', async (_req: Request, res: Response): Promise<void> => {
  try {
    const tableClient = getTableClient();
    const records: VideoStatusRecord[] = [];

    for await (const entity of tableClient.listEntities<VideoStatusRecord>()) {
      records.push(entity);
    }

    records.sort((left, right) => {
      const leftTime = new Date(left.uploadedAt ?? 0).getTime();
      const rightTime = new Date(right.uploadedAt ?? 0).getTime();
      return rightTime - leftTime;
    });

    const uploads = records.map(record => ({
      name: record.sourceBlobName.replace(/^input\//, ''),
      url: createBlobUrl(record.sourceContainer, record.sourceBlobName),
      downloadUrl: createBlobUrl(record.sourceContainer, record.sourceBlobName, true),
      detailUrl: `/videos/${encodeURIComponent(record.recordId)}`,
      lastModified: record.updatedAt,
      status: record.status,
      currentStage: record.currentStage,
      recordId: record.recordId,
    }));

    const processed = records
      .filter(record => Boolean(record.processedBlobName))
      .map(record => ({
        name: record.processedBlobName ? path.basename(record.processedBlobName) : record.recordId,
        url: createBlobUrl(record.sourceContainer, record.processedBlobName!),
        downloadUrl: createBlobUrl(record.sourceContainer, record.processedBlobName!, true),
        detailUrl: `/videos/${encodeURIComponent(record.recordId)}`,
        lastModified: record.updatedAt,
        status: record.status,
        currentStage: record.currentStage,
        recordId: record.recordId,
      }));

    res.json({ uploads, processed });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

export default router;
