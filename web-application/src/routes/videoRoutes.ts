import { Router, Request, Response } from 'express';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
import { TableClient } from '@azure/data-tables';
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import {
  getCosmosReadModelStore,
  PlayerManifestProjection,
  PlayDescriptionsProjection,
  PlayOutcomeAnnotation,
  PlayOutcomeReason,
  PlayOutcomeWinner,
} from '../services/cosmosReadModelStore';
import {
  ServeContactOption,
  ServeEvent,
  ServeReviewManifest,
  ServeTimelineProjection,
  buildServeTimeline,
  createServeReviewOverride,
} from '../services/serveReview';

const router = Router();

const DEFAULT_MAX_VIDEO_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
const BLOB_CONTAINER = process.env.VIDEO_BLOB_CONTAINER || 'volleyball-videos';
const BLOB_FOLDER = 'input';
const VIDEO_RECORDS_TABLE_NAME = process.env.VIDEO_RECORDS_TABLE_NAME || 'videoprocessingrecords';
const MAX_VIDEO_BYTES = getMaxVideoBytes();
const UPLOAD_SAS_TTL_MS = 60 * 60 * 1000;

type VideoStatusRecord = {
  partitionKey: string;
  rowKey: string;
  recordId: string;
  requestedVideoUrl?: string;
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
  playDescriptionsBlobName?: string;
  playDescriptionsBlobUrl?: string;
  playCount?: number;
  detectedPlayerCount?: number;
  errorMessage?: string;
  playerManifestGeneratedAt?: string;
  playDescriptionsGeneratedAt?: string;
  detectionSummary?: DetectionSummary;
};

type BlobAsset = {
  name: string;
  blobName: string;
  url: string;
  downloadUrl: string;
  size?: number;
  lastModified?: string;
  contentType?: string;
};

type DetectionSummary = {
  playerCount: number;
  peakPlayersInFrame: number;
  sampledFrames: number;
  teamCount: number;
};

type PlayerManifestRecord = PlayerManifestProjection;

type PlayDescriptionsRecord = PlayDescriptionsProjection;

type TeamSide = 'main' | 'opponent';

type TeamScore = Record<TeamSide, number>;

type PlayerAggregateStats = {
  totalContacts: number;
  serves: number;
  passes: number;
  sets: number;
  attacks: number;
  unknownContacts: number;
  ralliesInvolved: number;
  rallyWinsInvolved: number;
  rallyLossesInvolved: number;
};

type PlayerManifestPlayer = PlayerManifestRecord['players'][number];

type PlayDescription = PlayDescriptionsRecord['plays'][number];

type PlayerStatsResponseItem = {
  trackId: number;
  teamId: number;
  teamSide?: TeamSide;
  frameCount?: number;
  avgConfidence?: number;
  bestConfidence?: number;
  sampleTimestamp?: number;
  imageBlobName?: string;
  displayName?: string;
  notes?: string;
  imageUrl?: string;
  imageDownloadUrl?: string;
  stats: PlayerAggregateStats;
};

type PlayerStatsAccumulator = Omit<PlayerStatsResponseItem, 'imageUrl' | 'imageDownloadUrl'>;

const PLAY_OUTCOME_WINNERS: PlayOutcomeWinner[] = ['main', 'opponent'];
const PLAY_OUTCOME_REASONS: PlayOutcomeReason[] = ['ace', 'kill', 'block', 'error', 'violation', 'other'];

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

function getVideoUrlImportFunctionUrl(): string {
  const configuredUrl = process.env.VIDEO_URL_IMPORT_FUNCTION_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const isAzureHosted = Boolean(process.env.WEBSITE_HOSTNAME?.trim());
  const isProduction = (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  if (!isAzureHosted && !isProduction) {
    return 'http://127.0.0.1:7071/api/videos/import-from-url';
  }

  throw new Error('VIDEO_URL_IMPORT_FUNCTION_URL is not configured.');
}

class VideoImportRequestError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function queueVideoUrlImport(videoUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(getVideoUrlImportFunctionUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ videoUrl }),
  });

  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const errorMessage = typeof payload.error === 'string' ? payload.error : 'Failed to queue video import';
    throw new VideoImportRequestError(errorMessage, response.status);
  }

  return payload;
}

async function handleVideoUrlImportRequest(req: Request, res: Response): Promise<void> {
  try {
    const videoUrlValue = typeof req.body?.videoUrl === 'string' ? req.body.videoUrl.trim() : '';
    if (!videoUrlValue) {
      res.status(400).json({ error: 'videoUrl is required.' });
      return;
    }

    const importResult = await queueVideoUrlImport(videoUrlValue);
    res.status(202).json(importResult);
  } catch (handlerError) {
    console.error('Video URL import error:', handlerError);

    if (handlerError instanceof VideoImportRequestError) {
      res.status(handlerError.statusCode).json({ error: handlerError.message });
      return;
    }

    const errorMessage = handlerError instanceof Error && handlerError.message === 'VIDEO_URL_IMPORT_FUNCTION_URL is not configured.'
      ? 'Video URL import is not configured for this environment.'
      : handlerError instanceof Error
        ? handlerError.message
        : 'Failed to queue video import';
    res.status(500).json({ error: errorMessage });
  }
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

function createBlobUploadTarget(containerName: string, blobName: string): {
  uploadUrl: string;
  blobUrl: string;
  expiresAt: string;
} {
  const connectionString = getStorageConnectionString();
  const containerClient = getBlobContainerClient(containerName);
  const blobClient = containerClient.getBlockBlobClient(blobName);
  const sharedKey = parseSharedKey(connectionString);

  if (!sharedKey) {
    throw new Error('Storage shared key is required to create upload SAS URLs');
  }

  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + UPLOAD_SAS_TTL_MS);
  const sas = generateBlobSASQueryParameters({
    containerName,
    blobName,
    permissions: BlobSASPermissions.parse('cw'),
    startsOn,
    expiresOn,
  }, sharedKey).toString();

  return {
    uploadUrl: `${blobClient.url}?${sas}`,
    blobUrl: blobClient.url,
    expiresAt: expiresOn.toISOString(),
  };
}

function buildBlobAsset(
  containerName: string,
  blobName: string,
  size?: number,
  lastModified?: Date,
  contentType?: string
): BlobAsset {
  return {
    name: path.basename(blobName),
    blobName,
    url: createBlobUrl(containerName, blobName),
    downloadUrl: createBlobUrl(containerName, blobName, true),
    size,
    lastModified: lastModified?.toISOString(),
    contentType,
  };
}

async function loadBlobAsset(containerName: string, blobName: string): Promise<BlobAsset> {
  const blobClient = getBlobContainerClient(containerName).getBlobClient(blobName);

  try {
    const properties = await blobClient.getProperties();
    return buildBlobAsset(
      containerName,
      blobName,
      properties.contentLength,
      properties.lastModified,
      properties.contentType,
    );
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode?: number }).statusCode) === 404) {
      return buildBlobAsset(containerName, blobName);
    }
    throw error;
  }
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

async function readJsonBlobWithEtag<T>(containerName: string, blobName: string): Promise<{ payload: T; etag?: string }> {
  const blobClient = getBlobContainerClient(containerName).getBlobClient(blobName);
  const response = await blobClient.download();
  const raw = await readStreamAsString(response.readableStreamBody);
  return {
    payload: JSON.parse(raw) as T,
    etag: response.etag,
  };
}

async function readJsonBlob<T>(containerName: string, blobName: string): Promise<T> {
  const { payload } = await readJsonBlobWithEtag<T>(containerName, blobName);
  return payload;
}

async function writeJsonBlob(
  containerName: string,
  blobName: string,
  payload: unknown,
  conditions?: { ifMatch?: string; ifNoneMatch?: string },
): Promise<void> {
  const blobClient = getBlobContainerClient(containerName).getBlockBlobClient(blobName);
  const content = JSON.stringify(payload, null, 2);
  await blobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: {
      blobContentType: 'application/json',
    },
    conditions,
  });
}

async function getTableVideoRecord(recordId: string): Promise<VideoStatusRecord | undefined> {
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

async function getVideoRecord(recordId: string): Promise<VideoStatusRecord | undefined> {
  const readModelStore = getCosmosReadModelStore(console.warn);
  if (readModelStore) {
    const projectedRecord = await readModelStore.getVideoRecord(recordId);
    if (projectedRecord) {
      return projectedRecord;
    }
  }

  return getTableVideoRecord(recordId);
}

async function listVideoRecords(): Promise<VideoStatusRecord[]> {
  const readModelStore = getCosmosReadModelStore(console.warn);
  if (readModelStore) {
    const projectedRecords = await readModelStore.listVideoRecords();
    if (projectedRecords.length > 0) {
      return projectedRecords;
    }
  }

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

  return records;
}

function mapStatusResponse(record: VideoStatusRecord) {
  return {
    recordId: record.recordId,
    requestedVideoUrl: record.requestedVideoUrl,
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
    playDescriptionsBlobName: record.playDescriptionsBlobName,
    playDescriptionsBlobUrl: record.playDescriptionsBlobName ? createBlobUrl(record.sourceContainer, record.playDescriptionsBlobName) : record.playDescriptionsBlobUrl,
    playCount: record.playCount,
    detectedPlayerCount: record.detectedPlayerCount,
    import: {
      queuedAt: record.importQueuedAt,
      startedAt: record.importStartedAt,
      completedAt: record.importCompletedAt,
      failedAt: record.importFailedAt,
      durationMs: record.importDurationMs,
      retryCount: record.importRetryCount ?? 0,
      errorMessage: record.importErrorMessage,
    },
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
      blob.properties.lastModified,
      blob.properties.contentType
    ));
  }

  return assets.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadDetectionSummary(record: VideoStatusRecord): Promise<DetectionSummary | undefined> {
  if (record.detectionSummary) {
    return record.detectionSummary;
  }

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
  const readModelStore = getCosmosReadModelStore(console.warn);
  if (readModelStore) {
    const players = await readModelStore.listPlayerRecords(record.recordId);
    if (players.length > 0 || record.playerManifestGeneratedAt) {
      return {
        recordId: record.recordId,
        generatedAt: record.playerManifestGeneratedAt ?? players[0]?.generatedAt ?? '',
        sourceVideoBlobName: record.sourceBlobName,
        processedBlobName: record.processedBlobName ?? '',
        players: players.map(player => ({
          trackId: player.trackId,
          teamId: player.teamId,
          teamSide: player.teamSide,
          frameCount: player.frameCount,
          avgConfidence: player.avgConfidence,
          bestConfidence: player.bestConfidence,
          sampleTimestamp: player.sampleTimestamp,
          imageBlobName: player.imageBlobName,
          displayName: player.displayName,
          notes: player.notes,
        })),
      };
    }
  }

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

async function loadPlayDescriptions(record: VideoStatusRecord): Promise<PlayDescriptionsRecord | undefined> {
  const readModelStore = getCosmosReadModelStore(console.warn);
  if (readModelStore) {
    const plays = await readModelStore.listPlayRecords(record.recordId);
    if (plays.length > 0 || record.playDescriptionsGeneratedAt) {
      return {
        recordId: record.recordId,
        generatedAt: record.playDescriptionsGeneratedAt ?? plays[0]?.generatedAt ?? '',
        sourceVideoBlobName: record.sourceBlobName,
        processedBlobName: record.processedBlobName ?? '',
        playCount: typeof record.playCount === 'number' ? record.playCount : plays.length,
        plays: plays.map(play => ({
          playIndex: play.playIndex,
          sourceStartSeconds: play.sourceStartSeconds,
          sourceEndSeconds: play.sourceEndSeconds,
          trimmedStartSeconds: play.trimmedStartSeconds,
          trimmedEndSeconds: play.trimmedEndSeconds,
          sceneBlobName: play.sceneBlobName,
          contactedPlayers: play.contactedPlayers,
          contacts: play.contacts,
          outcome: play.outcome,
        })),
      };
    }
  }

  if (!record.playDescriptionsBlobName) {
    return undefined;
  }

  try {
    return await readJsonBlob<PlayDescriptionsRecord>(record.sourceContainer, record.playDescriptionsBlobName);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode?: number }).statusCode) === 404) {
      return undefined;
    }
    throw error;
  }
}

function getServeReviewBlobName(recordId: string): string {
  return `metadata/serve-reviews/${recordId}.json`;
}

async function loadServeReviewManifest(record: VideoStatusRecord): Promise<ServeReviewManifest | undefined> {
  const result = await loadServeReviewManifestWithEtag(record);
  return result.manifest;
}

async function loadServeReviewManifestWithEtag(record: VideoStatusRecord): Promise<{ manifest?: ServeReviewManifest; etag?: string }> {
  try {
    const { payload, etag } = await readJsonBlobWithEtag<ServeReviewManifest>(record.sourceContainer, getServeReviewBlobName(record.recordId));
    return {
      manifest: payload,
      etag,
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode?: number }).statusCode) === 404) {
      return {};
    }
    throw error;
  }
}

function buildPlayerImageUrls(record: VideoStatusRecord, imageBlobName?: string) {
  return {
    imageUrl: imageBlobName ? createBlobUrl(record.sourceContainer, imageBlobName) : undefined,
    imageDownloadUrl: imageBlobName ? createBlobUrl(record.sourceContainer, imageBlobName, true) : undefined,
  };
}

function buildServeContactOptionResponse(record: VideoStatusRecord, option: ServeContactOption) {
  return {
    ...option,
    ...buildPlayerImageUrls(record, option.imageBlobName),
  };
}

function buildServeEventResponse(record: VideoStatusRecord, serve: ServeEvent) {
  return {
    ...serve,
    ...buildPlayerImageUrls(record, serve.imageBlobName),
    sceneUrl: createBlobUrl(record.sourceContainer, serve.sceneBlobName),
    sceneDownloadUrl: createBlobUrl(record.sourceContainer, serve.sceneBlobName, true),
  };
}

function buildServeTimelineResponse(record: VideoStatusRecord, serveTimeline: ServeTimelineProjection) {
  return {
    generatedAt: serveTimeline.generatedAt,
    trimmedDurationSeconds: serveTimeline.trimmedDurationSeconds,
    summary: serveTimeline.summary,
    serves: serveTimeline.serves.map(serve => buildServeEventResponse(record, serve)),
    plays: serveTimeline.plays.map(play => ({
      playIndex: play.playIndex,
      sourceStartSeconds: play.sourceStartSeconds,
      sourceEndSeconds: play.sourceEndSeconds,
      trimmedStartSeconds: play.trimmedStartSeconds,
      trimmedEndSeconds: play.trimmedEndSeconds,
      sceneBlobName: play.sceneBlobName,
      sceneUrl: createBlobUrl(record.sourceContainer, play.sceneBlobName),
      sceneDownloadUrl: createBlobUrl(record.sourceContainer, play.sceneBlobName, true),
      detectedContactIndex: play.detectedContactIndex,
      selectedContactIndex: play.selectedContactIndex,
      detectedServe: play.detectedServe ? buildServeEventResponse(record, play.detectedServe) : undefined,
      serve: play.serve ? buildServeEventResponse(record, play.serve) : undefined,
      reviewStatus: play.reviewStatus,
      hasReviewOverride: play.hasReviewOverride,
      updatedAt: play.updatedAt,
      contactOptions: play.contactOptions.map(option => buildServeContactOptionResponse(record, option)),
    })),
  };
}

function buildPlayerManifestEntryResponse(record: VideoStatusRecord, player: PlayerManifestPlayer) {
  return {
    ...player,
    ...buildPlayerImageUrls(record, player.imageBlobName),
  };
}

function createEmptyScore(): TeamScore {
  return {
    main: 0,
    opponent: 0,
  };
}

function createEmptyOutcomeReasonCounts(): Record<PlayOutcomeReason, number> {
  return {
    ace: 0,
    kill: 0,
    block: 0,
    error: 0,
    violation: 0,
    other: 0,
  };
}

function createEmptyPlayerStats(): PlayerAggregateStats {
  return {
    totalContacts: 0,
    serves: 0,
    passes: 0,
    sets: 0,
    attacks: 0,
    unknownContacts: 0,
    ralliesInvolved: 0,
    rallyWinsInvolved: 0,
    rallyLossesInvolved: 0,
  };
}

function ensurePlayerStatsAccumulator(
  playersByTrackId: Map<number, PlayerStatsAccumulator>,
  player: Omit<PlayerStatsAccumulator, 'stats'>,
): PlayerStatsAccumulator {
  const existing = playersByTrackId.get(player.trackId);
  if (existing) {
    existing.teamSide = existing.teamSide ?? player.teamSide;
    existing.frameCount = existing.frameCount ?? player.frameCount;
    existing.avgConfidence = existing.avgConfidence ?? player.avgConfidence;
    existing.bestConfidence = existing.bestConfidence ?? player.bestConfidence;
    existing.sampleTimestamp = existing.sampleTimestamp ?? player.sampleTimestamp;
    existing.imageBlobName = existing.imageBlobName ?? player.imageBlobName;
    existing.displayName = existing.displayName ?? player.displayName;
    existing.notes = existing.notes ?? player.notes;
    return existing;
  }

  const created: PlayerStatsAccumulator = {
    ...player,
    stats: createEmptyPlayerStats(),
  };
  playersByTrackId.set(player.trackId, created);
  return created;
}

function buildPlayerStatsResponse(
  record: VideoStatusRecord,
  playerManifest: PlayerManifestRecord | undefined,
  playDescriptions: PlayDescriptionsRecord | undefined,
) {
  const playersByTrackId = new Map<number, PlayerStatsAccumulator>();

  for (const player of playerManifest?.players ?? []) {
    ensurePlayerStatsAccumulator(playersByTrackId, player);
  }

  for (const play of playDescriptions?.plays ?? []) {
    const involvedTrackIds = new Set<number>();
    const observedTeamSides = new Map<number, TeamSide>();
    const expectedContactCounts = new Map<number, number>();
    const recordedContactCounts = new Map<number, number>();

    for (const contactedPlayer of play.contactedPlayers) {
      ensurePlayerStatsAccumulator(playersByTrackId, {
        trackId: contactedPlayer.trackId,
        teamId: contactedPlayer.teamId,
        teamSide: contactedPlayer.teamSide,
      });
      involvedTrackIds.add(contactedPlayer.trackId);
      expectedContactCounts.set(
        contactedPlayer.trackId,
        Math.max(expectedContactCounts.get(contactedPlayer.trackId) ?? 0, contactedPlayer.contactCount),
      );
      if (contactedPlayer.teamSide) {
        observedTeamSides.set(contactedPlayer.trackId, contactedPlayer.teamSide);
      }
    }

    for (const contact of play.contacts) {
      const player = ensurePlayerStatsAccumulator(playersByTrackId, {
        trackId: contact.playerTrackId,
        teamId: contact.teamId,
        teamSide: contact.teamSide,
      });
      involvedTrackIds.add(contact.playerTrackId);
      recordedContactCounts.set(contact.playerTrackId, (recordedContactCounts.get(contact.playerTrackId) ?? 0) + 1);
      if (contact.teamSide) {
        observedTeamSides.set(contact.playerTrackId, contact.teamSide);
      }

      player.stats.totalContacts += 1;
      switch (contact.actionType) {
        case 'serve':
          player.stats.serves += 1;
          break;
        case 'pass':
          player.stats.passes += 1;
          break;
        case 'set':
          player.stats.sets += 1;
          break;
        case 'attack':
          player.stats.attacks += 1;
          break;
        case 'unknown':
        default:
          player.stats.unknownContacts += 1;
          break;
      }
    }

    for (const [trackId, expectedCount] of expectedContactCounts.entries()) {
      const player = playersByTrackId.get(trackId);
      if (!player) {
        continue;
      }

      const missingContacts = expectedCount - (recordedContactCounts.get(trackId) ?? 0);
      if (missingContacts > 0) {
        player.stats.totalContacts += missingContacts;
        player.stats.unknownContacts += missingContacts;
      }
    }

    for (const trackId of involvedTrackIds) {
      const player = playersByTrackId.get(trackId);
      if (!player) {
        continue;
      }

      player.stats.ralliesInvolved += 1;

      if (!play.outcome) {
        continue;
      }

      const teamSide = observedTeamSides.get(trackId) ?? player.teamSide;
      if (!teamSide) {
        continue;
      }

      if (teamSide === play.outcome.winner) {
        player.stats.rallyWinsInvolved += 1;
      } else {
        player.stats.rallyLossesInvolved += 1;
      }
    }
  }

  const players = Array.from(playersByTrackId.values())
    .sort((left, right) => left.trackId - right.trackId)
    .map<PlayerStatsResponseItem>(player => ({
      trackId: player.trackId,
      teamId: player.teamId,
      teamSide: player.teamSide,
      frameCount: player.frameCount,
      avgConfidence: player.avgConfidence,
      bestConfidence: player.bestConfidence,
      sampleTimestamp: player.sampleTimestamp,
      imageBlobName: player.imageBlobName,
      displayName: player.displayName,
      notes: player.notes,
      ...buildPlayerImageUrls(record, player.imageBlobName),
      stats: player.stats,
    }));

  return {
    generatedAt: playDescriptions?.generatedAt ?? playerManifest?.generatedAt,
    playerCount: players.length,
    players,
  };
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
    players: manifest.players.map(player => buildPlayerManifestEntryResponse(record, player)),
  };
}

function normalizePlayerTeamSide(value: unknown): TeamSide | undefined {
  if (value === 'main' || value === 'opponent') {
    return value;
  }

  return undefined;
}

function normalizePlayOutcomeWinner(value: unknown): PlayOutcomeWinner | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.trim();
  return PLAY_OUTCOME_WINNERS.includes(normalizedValue as PlayOutcomeWinner)
    ? normalizedValue as PlayOutcomeWinner
    : undefined;
}

function normalizePlayOutcomeReason(value: unknown): PlayOutcomeReason | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.trim();
  return PLAY_OUTCOME_REASONS.includes(normalizedValue as PlayOutcomeReason)
    ? normalizedValue as PlayOutcomeReason
    : undefined;
}

function parsePlayIndexParam(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim();
  if (!/^\d+$/.test(trimmedValue)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmedValue, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parsePlayOutcomeRequest(
  body: unknown,
  existingOutcome?: PlayOutcomeAnnotation,
): { outcome?: PlayOutcomeAnnotation; error?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Outcome payload is required.' };
  }

  const payloadSourceCandidate = 'outcome' in body
    ? (body as { outcome?: unknown }).outcome
    : body;

  if (typeof payloadSourceCandidate !== 'object' || payloadSourceCandidate === null || Array.isArray(payloadSourceCandidate)) {
    return { error: 'Outcome payload is required.' };
  }

  const payload = payloadSourceCandidate as {
    winner?: unknown;
    reason?: unknown;
    notes?: unknown;
  };

  const winner = normalizePlayOutcomeWinner(payload.winner);
  if (!winner) {
    return { error: `winner must be one of: ${PLAY_OUTCOME_WINNERS.join(', ')}.` };
  }

  const reason = normalizePlayOutcomeReason(payload.reason);
  if (!reason) {
    return { error: `reason must be one of: ${PLAY_OUTCOME_REASONS.join(', ')}.` };
  }

  const notesValue = typeof payload.notes === 'string' ? payload.notes : undefined;
  if (payload.notes !== undefined && notesValue === undefined) {
    return { error: 'notes must be a string when provided.' };
  }

  const timestamp = new Date().toISOString();
  const normalizedNotes = notesValue === undefined
    ? existingOutcome?.notes
    : notesValue.trim() || undefined;

  return {
    outcome: {
      winner,
      reason,
      ...(normalizedNotes ? { notes: normalizedNotes } : {}),
      taggedAt: existingOutcome?.taggedAt ?? timestamp,
      updatedAt: timestamp,
    },
  };
}

function parseServeSelectionRequest(body: unknown): { selectedContactIndex?: number | null; error?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Serve review payload is required.' };
  }

  if (!('selectedContactIndex' in body)) {
    return { error: 'selectedContactIndex is required.' };
  }

  const rawValue = (body as { selectedContactIndex?: unknown }).selectedContactIndex;
  if (rawValue === null) {
    return { selectedContactIndex: null };
  }

  if (typeof rawValue === 'number' && Number.isInteger(rawValue) && rawValue >= 0) {
    return { selectedContactIndex: rawValue };
  }

  if (typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim())) {
    return { selectedContactIndex: Number.parseInt(rawValue.trim(), 10) };
  }

  return { error: 'selectedContactIndex must be a non-negative integer or null.' };
}

function getPlayerTeamKey(teamId: number, teamSide?: TeamSide): string {
  return `${teamId}:${teamSide ?? ''}`;
}

function buildRunningScoreForPlay(
  manifest: PlayDescriptionsRecord | undefined,
  playIndex: number,
  fallbackOutcome?: PlayOutcomeAnnotation,
): TeamScore {
  const runningScore = createEmptyScore();
  let matchedPlay = false;

  for (const play of manifest?.plays ?? []) {
    if (play.playIndex > playIndex) {
      break;
    }

    const outcome = play.playIndex === playIndex
      ? fallbackOutcome ?? play.outcome
      : play.outcome;

    if (outcome) {
      runningScore[outcome.winner] += 1;
    }

    if (play.playIndex === playIndex) {
      matchedPlay = true;
      break;
    }
  }

  if (!matchedPlay && fallbackOutcome) {
    runningScore[fallbackOutcome.winner] += 1;
  }

  return runningScore;
}

function buildPlayDescriptionsResponse(record: VideoStatusRecord, manifest: PlayDescriptionsRecord | undefined) {
  const scoreSummary = createEmptyScore();
  const outcomeSummary = {
    annotatedPlayCount: 0,
    pendingPlayCount: manifest?.playCount ?? 0,
    reasonCounts: createEmptyOutcomeReasonCounts(),
  };

  if (!manifest) {
    return {
      generatedAt: undefined,
      playCount: 0,
      scoreSummary,
      outcomeSummary,
      plays: [],
    };
  }

  const plays = manifest.plays.map(play => {
    if (play.outcome) {
      scoreSummary[play.outcome.winner] += 1;
      outcomeSummary.annotatedPlayCount += 1;
      outcomeSummary.reasonCounts[play.outcome.reason] += 1;
    }

    return {
      ...play,
      sceneUrl: createBlobUrl(record.sourceContainer, play.sceneBlobName),
      sceneDownloadUrl: createBlobUrl(record.sourceContainer, play.sceneBlobName, true),
      runningScore: {
        ...scoreSummary,
      },
    };
  });

  outcomeSummary.pendingPlayCount = Math.max(manifest.playCount - outcomeSummary.annotatedPlayCount, 0);

  return {
    generatedAt: manifest.generatedAt,
    playCount: manifest.playCount,
    scoreSummary: {
      ...scoreSummary,
    },
    outcomeSummary,
    plays,
  };
}

function buildVideoRecordId(containerName: string, blobName: string): string {
  return createHash('sha256')
    .update(`${containerName}/${blobName}`)
    .digest('hex');
}

const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
] as const;

const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi'] as const;

function inferVideoExtension(filename: string, contentType?: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ALLOWED_VIDEO_EXTENSIONS.includes(ext as typeof ALLOWED_VIDEO_EXTENSIONS[number])) {
    return ext;
  }

  if (contentType) {
    const normalized = contentType.split(';')[0].trim().toLowerCase();
    if (normalized.includes('webm')) return '.webm';
    if (normalized.includes('quicktime')) return '.mov';
    if (normalized.includes('x-msvideo')) return '.avi';
  }

  return '.mp4';
}

function isAllowedVideoUpload(contentType: string | undefined, filename: string): boolean {
  const ext = inferVideoExtension(filename, contentType);
  const normalizedType = contentType ? contentType.split(';')[0].trim().toLowerCase() : '';

  if (normalizedType) {
    if (normalizedType.startsWith('video/')) {
      return true;
    }

    if (ALLOWED_VIDEO_MIME_TYPES.includes(normalizedType as typeof ALLOWED_VIDEO_MIME_TYPES[number])) {
      return true;
    }

    if (normalizedType === 'application/octet-stream') {
      return ALLOWED_VIDEO_EXTENSIONS.includes(ext as typeof ALLOWED_VIDEO_EXTENSIONS[number]);
    }

    return false;
  }

  return ALLOWED_VIDEO_EXTENSIONS.includes(ext as typeof ALLOWED_VIDEO_EXTENSIONS[number]);
}

router.post('/upload-target', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const rawFilename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : '';
    const contentType = typeof req.body?.contentType === 'string' ? req.body.contentType.trim() : '';
    const size = typeof req.body?.size === 'number'
      ? req.body.size
      : Number.parseInt(String(req.body?.size ?? ''), 10);

    if (!rawFilename) {
      res.status(400).json({ error: 'filename is required' });
      return;
    }

    if (!Number.isFinite(size) || size <= 0) {
      res.status(400).json({ error: 'size must be a positive number' });
      return;
    }

    if (size > MAX_VIDEO_BYTES) {
      res.status(413).json({ error: `File exceeds the upload limit of ${formatBytes(MAX_VIDEO_BYTES)}.` });
      return;
    }

    if (!isAllowedVideoUpload(contentType || undefined, rawFilename)) {
      res.status(400).json({ error: 'Invalid file type. Only video files are allowed.' });
      return;
    }

    const extension = inferVideoExtension(rawFilename, contentType || undefined);
    const blobName = `${BLOB_FOLDER}/${randomUUID()}${extension}`;
    const containerClient = getBlobContainerClient(BLOB_CONTAINER);
    await containerClient.createIfNotExists();

    const { uploadUrl, blobUrl, expiresAt } = createBlobUploadTarget(BLOB_CONTAINER, blobName);
    const recordId = buildVideoRecordId(BLOB_CONTAINER, blobName);

    res.status(202).json({
      success: true,
      recordId,
      uploadUrl,
      blobUrl,
      blobName,
      container: BLOB_CONTAINER,
      expiresAt,
      currentStage: 'ingest',
      status: 'uploaded',
    });
  } catch (error) {
    console.error('Create upload target error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to create upload target';
    res.status(500).json({ error: errorMessage });
  }
});

router.post('/trim', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), handleVideoUrlImportRequest);

router.post('/import-from-url', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), handleVideoUrlImportRequest);

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
    const processedAssetMap = new Map(processedAssets.map(asset => [asset.blobName, asset]));
    const convertedVideo = record.convertedBlobName
      ? processedAssetMap.get(record.convertedBlobName) ?? buildBlobAsset(record.sourceContainer, record.convertedBlobName)
      : undefined;
    const trimmedVideo = record.processedBlobName
      ? processedAssetMap.get(record.processedBlobName) ?? buildBlobAsset(record.sourceContainer, record.processedBlobName)
      : undefined;
    const detectionFile = record.detectionBlobName
      ? processedAssetMap.get(record.detectionBlobName) ?? buildBlobAsset(record.sourceContainer, record.detectionBlobName)
      : undefined;
    const playerManifestFile = record.playerManifestBlobName
      ? processedAssetMap.get(record.playerManifestBlobName) ?? buildBlobAsset(record.sourceContainer, record.playerManifestBlobName)
      : undefined;
    const sourceVideo = await loadBlobAsset(record.sourceContainer, record.sourceBlobName);
    const splitParts = processedAssets.filter(asset =>
      asset.blobName !== record.convertedBlobName && asset.blobName !== record.processedBlobName
    );
    const detectionSummary = await loadDetectionSummary(record);
    const playerManifest = await loadPlayerManifest(record);
    const playDescriptions = await loadPlayDescriptions(record);
    const serveReviewManifest = await loadServeReviewManifest(record);
    const serveTimeline = buildServeTimelineResponse(record, buildServeTimeline({
      playerManifest,
      playDescriptions,
      reviewManifest: serveReviewManifest,
    }));

    res.json({
      ...mapStatusResponse(record),
      sourceVideo,
      convertedVideo,
      trimmedVideo,
      splitParts,
      detectionFile,
      playerManifestFile,
      detectionSummary,
      playersPageUrl: `/videos/${encodeURIComponent(record.recordId)}/players`,
      playerManifest: buildPlayerManifestResponse(record, playerManifest),
      playDescriptions: buildPlayDescriptionsResponse(record, playDescriptions),
      serves: serveTimeline,
    });
  } catch (error) {
    console.error('Video details error:', error);
    res.status(500).json({ error: 'Failed to load video details' });
  }
});

router.get('/:recordId/plays', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video plays not found', recordId });
      return;
    }

    const playDescriptions = await loadPlayDescriptions(record);
    res.json({
      ...mapStatusResponse(record),
      videoDetailsUrl: `/videos/${encodeURIComponent(record.recordId)}`,
      playDescriptions: buildPlayDescriptionsResponse(record, playDescriptions),
    });
  } catch (error) {
    console.error('Play descriptions error:', error);
    res.status(500).json({ error: 'Failed to load play descriptions' });
  }
});

router.get('/:recordId/serves', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video serves not found', recordId });
      return;
    }

    const playerManifest = await loadPlayerManifest(record);
    const playDescriptions = await loadPlayDescriptions(record);
    const serveReviewManifest = await loadServeReviewManifest(record);

    res.json({
      ...mapStatusResponse(record),
      playersPageUrl: `/videos/${encodeURIComponent(record.recordId)}/players`,
      videoDetailsUrl: `/videos/${encodeURIComponent(record.recordId)}`,
      serves: buildServeTimelineResponse(record, buildServeTimeline({
        playerManifest,
        playDescriptions,
        reviewManifest: serveReviewManifest,
      })),
    });
  } catch (error) {
    console.error('Serve timeline error:', error);
    res.status(500).json({ error: 'Failed to load serve timeline' });
  }
});

router.put('/:recordId/serves/:playIndex', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const playIndex = parsePlayIndexParam(req.params.playIndex);
    if (playIndex === undefined) {
      res.status(400).json({ error: 'playIndex must be a non-negative integer.' });
      return;
    }

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video serve not found', recordId, playIndex });
      return;
    }

    const playDescriptions = await loadPlayDescriptions(record);
    if (!playDescriptions) {
      res.status(409).json({ error: 'Serve review is not available until play descriptions have been generated.' });
      return;
    }

    const play = playDescriptions.plays.find(item => item.playIndex === playIndex);
    if (!play) {
      res.status(404).json({ error: `Play ${playIndex} not found for this video.`, recordId, playIndex });
      return;
    }

    const { selectedContactIndex, error } = parseServeSelectionRequest(req.body);
    if (error || selectedContactIndex === undefined) {
      res.status(400).json({ error: error ?? 'selectedContactIndex is required.' });
      return;
    }

    if (selectedContactIndex !== null && !play.contacts[selectedContactIndex]) {
      res.status(400).json({ error: `selectedContactIndex must reference one of the ${play.contacts.length} contacts in play ${playIndex}.` });
      return;
    }

    const updatedAt = new Date().toISOString();
    const { manifest: existingManifest, etag } = await loadServeReviewManifestWithEtag(record);
    const nextPlayOverrides = (existingManifest?.plays ?? []).filter(item => item.playIndex !== playIndex);
    const nextOverride = selectedContactIndex === null
      ? {
          playIndex,
          dismissed: true,
          updatedAt,
        }
      : createServeReviewOverride(play, selectedContactIndex, updatedAt);

    if (!nextOverride) {
      res.status(400).json({ error: `selectedContactIndex must reference one of the ${play.contacts.length} contacts in play ${playIndex}.` });
      return;
    }

    const nextManifest: ServeReviewManifest = {
      recordId,
      updatedAt,
      plays: [...nextPlayOverrides, nextOverride].sort((left, right) => left.playIndex - right.playIndex),
    };

    await writeJsonBlob(
      record.sourceContainer,
      getServeReviewBlobName(recordId),
      nextManifest,
      existingManifest ? { ifMatch: etag } : { ifNoneMatch: '*' },
    );

    const playerManifest = await loadPlayerManifest(record);
    const serves = buildServeTimelineResponse(record, buildServeTimeline({
      playerManifest,
      playDescriptions,
      reviewManifest: nextManifest,
    }));

    res.json({
      success: true,
      serves,
      play: serves.plays.find(item => item.playIndex === playIndex),
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode?: number }).statusCode) === 412) {
      res.status(409).json({ error: 'Serve review changed while you were editing. Reload the page and try again.' });
      return;
    }
    console.error('Serve review update error:', error);
    res.status(500).json({ error: 'Failed to update serve review' });
  }
});

router.delete('/:recordId/serves/:playIndex', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const playIndex = parsePlayIndexParam(req.params.playIndex);
    if (playIndex === undefined) {
      res.status(400).json({ error: 'playIndex must be a non-negative integer.' });
      return;
    }

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video serve not found', recordId, playIndex });
      return;
    }

    const playDescriptions = await loadPlayDescriptions(record);
    if (!playDescriptions) {
      res.status(409).json({ error: 'Serve review is not available until play descriptions have been generated.' });
      return;
    }

    const play = playDescriptions.plays.find(item => item.playIndex === playIndex);
    if (!play) {
      res.status(404).json({ error: `Play ${playIndex} not found for this video.`, recordId, playIndex });
      return;
    }

    const updatedAt = new Date().toISOString();
    const { manifest: existingManifest, etag } = await loadServeReviewManifestWithEtag(record);
    const nextManifest: ServeReviewManifest = {
      recordId,
      updatedAt,
      plays: (existingManifest?.plays ?? []).filter(item => item.playIndex !== playIndex),
    };

    if (existingManifest) {
      await writeJsonBlob(
        record.sourceContainer,
        getServeReviewBlobName(recordId),
        nextManifest,
        { ifMatch: etag },
      );
    }

    const playerManifest = await loadPlayerManifest(record);
    const serves = buildServeTimelineResponse(record, buildServeTimeline({
      playerManifest,
      playDescriptions,
      reviewManifest: nextManifest,
    }));

    res.json({
      success: true,
      serves,
      play: serves.plays.find(item => item.playIndex === playIndex),
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode?: number }).statusCode) === 412) {
      res.status(409).json({ error: 'Serve review changed while you were editing. Reload the page and try again.' });
      return;
    }
    console.error('Serve review reset error:', error);
    res.status(500).json({ error: 'Failed to reset serve review' });
  }
});

router.put('/:recordId/plays/:playIndex/outcome', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const playIndex = parsePlayIndexParam(req.params.playIndex);
    if (playIndex === undefined) {
      res.status(400).json({ error: 'playIndex must be a non-negative integer.' });
      return;
    }

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video play not found', recordId, playIndex });
      return;
    }

    const readModelStore = getCosmosReadModelStore(console.warn);
    if (!readModelStore) {
      res.status(503).json({ error: 'Play outcome updates require Cosmos read-model integration.' });
      return;
    }

    const existingPlay = await readModelStore.getPlayRecord(recordId, playIndex);
    if (!existingPlay) {
      res.status(404).json({ error: `Play ${playIndex} not found for this video.`, recordId, playIndex });
      return;
    }

    const { outcome, error } = parsePlayOutcomeRequest(req.body, existingPlay.outcome);
    if (error || !outcome) {
      res.status(400).json({ error: error ?? 'Outcome payload is required.' });
      return;
    }

    const updatedPlayRecord = await readModelStore.updatePlayOutcome(recordId, playIndex, outcome, existingPlay);
    if (!updatedPlayRecord) {
      res.status(404).json({ error: `Play ${playIndex} not found for this video.`, recordId, playIndex });
      return;
    }

    const playDescriptions = await loadPlayDescriptions(record);
    const playDescriptionsResponse = buildPlayDescriptionsResponse(record, playDescriptions);
    const updatedPlay = playDescriptionsResponse.plays.find(play => play.playIndex === playIndex);

    res.json({
      success: true,
      play: updatedPlay ?? {
        playIndex: updatedPlayRecord.playIndex,
        sourceStartSeconds: updatedPlayRecord.sourceStartSeconds,
        sourceEndSeconds: updatedPlayRecord.sourceEndSeconds,
        trimmedStartSeconds: updatedPlayRecord.trimmedStartSeconds,
        trimmedEndSeconds: updatedPlayRecord.trimmedEndSeconds,
        sceneBlobName: updatedPlayRecord.sceneBlobName,
        contactedPlayers: updatedPlayRecord.contactedPlayers,
        contacts: updatedPlayRecord.contacts,
        outcome: updatedPlayRecord.outcome,
        runningScore: buildRunningScoreForPlay(playDescriptions, updatedPlayRecord.playIndex, updatedPlayRecord.outcome),
        sceneUrl: createBlobUrl(record.sourceContainer, updatedPlayRecord.sceneBlobName),
        sceneDownloadUrl: createBlobUrl(record.sourceContainer, updatedPlayRecord.sceneBlobName, true),
      },
      scoreSummary: playDescriptionsResponse.scoreSummary,
      outcomeSummary: playDescriptionsResponse.outcomeSummary,
    });
  } catch (error) {
    console.error('Play outcome update error:', error);
    res.status(500).json({ error: 'Failed to update play outcome' });
  }
});

router.get('/:recordId/stats', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }), async (req: Request, res: Response): Promise<void> => {
  try {
    const recordIdParam = req.params.recordId;
    const recordId = typeof recordIdParam === 'string' ? recordIdParam.trim() : '';
    if (!recordId) {
      res.status(400).json({ error: 'recordId is required' });
      return;
    }

    const record = await getVideoRecord(recordId);
    if (!record) {
      res.status(404).json({ error: 'Video stats not found', recordId });
      return;
    }

    const playerManifest = await loadPlayerManifest(record);
    const playDescriptions = await loadPlayDescriptions(record);
    const playDescriptionsResponse = buildPlayDescriptionsResponse(record, playDescriptions);

    res.json({
      ...mapStatusResponse(record),
      playersPageUrl: `/videos/${encodeURIComponent(record.recordId)}/players`,
      videoDetailsUrl: `/videos/${encodeURIComponent(record.recordId)}`,
      playerStats: buildPlayerStatsResponse(record, playerManifest, playDescriptions),
      scoreSummary: playDescriptionsResponse.scoreSummary,
      outcomeSummary: playDescriptionsResponse.outcomeSummary,
    });
  } catch (error) {
    console.error('Player stats error:', error);
    res.status(500).json({ error: 'Failed to load player stats' });
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

    const knownPlayersByTrackId = new Map(currentManifest.players.map(player => [player.trackId, player]));
    const allowedTeams = new Set(
      currentManifest.players.map(player => getPlayerTeamKey(player.teamId, player.teamSide))
    );
    const requestedByTrackId = new Map<number, {
      displayName: string;
      notes: string;
      teamId: number;
      teamSide?: 'main' | 'opponent';
    }>();

    for (const player of requestedPlayers) {
      if (typeof player?.trackId !== 'number' || !Number.isInteger(player.trackId)) {
        res.status(400).json({ error: 'Each player update must include an integer trackId.' });
        return;
      }

      if (!knownPlayersByTrackId.has(player.trackId)) {
        res.status(400).json({ error: `Unknown player trackId ${player.trackId}.` });
        return;
      }

      if (requestedByTrackId.has(player.trackId)) {
        res.status(400).json({ error: `Duplicate player trackId ${player.trackId}.` });
        return;
      }

      if (typeof player?.teamId !== 'number' || !Number.isInteger(player.teamId)) {
        res.status(400).json({ error: `Player ${player.trackId} must include an integer teamId.` });
        return;
      }

      const teamSide = normalizePlayerTeamSide(player.teamSide);
      if (player.teamSide !== undefined && teamSide === undefined) {
        res.status(400).json({ error: `Player ${player.trackId} has an invalid teamSide.` });
        return;
      }

      if (!allowedTeams.has(getPlayerTeamKey(player.teamId, teamSide))) {
        res.status(400).json({ error: `Player ${player.trackId} must use one of the detected teams for this video.` });
        return;
      }

      requestedByTrackId.set(player.trackId, {
        displayName: typeof player.displayName === 'string' ? player.displayName.trim() : '',
        notes: typeof player.notes === 'string' ? player.notes.trim() : '',
        teamId: player.teamId,
        teamSide,
      });
    }

    const updatedManifest: PlayerManifestRecord = {
      ...currentManifest,
      generatedAt: new Date().toISOString(),
      players: currentManifest.players.flatMap(player => {
        const requested = requestedByTrackId.get(player.trackId);
        return requested
          ? [{
              ...player,
              displayName: requested.displayName ?? '',
              notes: requested.notes ?? '',
              teamId: requested.teamId,
              teamSide: requested.teamSide,
            }]
          : [];
      }),
    };

    await writeJsonBlob(record.sourceContainer, record.playerManifestBlobName, updatedManifest);
    await getCosmosReadModelStore(console.warn)?.replacePlayerManifest(updatedManifest);

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
    const records = await listVideoRecords();

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
