import { Container, CosmosClient, SqlQuerySpec } from '@azure/cosmos';

const DEFAULT_DATABASE_NAME = 'readmodel';
const DEFAULT_CONTAINER_NAME = 'videoprocessingrecords';

type ReadModelDocType = 'video' | 'player' | 'play';

type TeamSide = 'main' | 'opponent';

type PlayActionType = 'serve' | 'pass' | 'set' | 'attack' | 'unknown';

export type PlayOutcomeWinner = 'main' | 'opponent';

export type PlayOutcomeReason =
  | 'ace'
  | 'kill'
  | 'block'
  | 'error'
  | 'violation'
  | 'other';

export type PlayOutcomeAnnotation = {
  winner: PlayOutcomeWinner;
  reason: PlayOutcomeReason;
  notes?: string;
  taggedAt: string;
  updatedAt: string;
};

export type DetectionSummary = {
  playerCount: number;
  peakPlayersInFrame: number;
  sampledFrames: number;
  teamCount: number;
};

export type VideoRecordFields = {
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
  convertJobToken?: string;
  trimJobToken?: string;
  detectJobToken?: string;
  lastJobType?: string;
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

export type VideoReadModelDocument = VideoRecordFields & {
  id: 'video';
  docType: 'video';
};

export type PlayerManifestProjection = {
  recordId: string;
  generatedAt: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  players: Array<{
    trackId: number;
    teamId: number;
    teamSide?: TeamSide;
    frameCount: number;
    avgConfidence: number;
    bestConfidence?: number;
    sampleTimestamp?: number;
    imageBlobName?: string;
    displayName?: string;
    notes?: string;
  }>;
};

export type PlayerReadModelDocument = {
  id: string;
  recordId: string;
  docType: 'player';
  updatedAt: string;
  generatedAt: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  trackId: number;
  teamId: number;
  teamSide?: TeamSide;
  frameCount: number;
  avgConfidence: number;
  bestConfidence?: number;
  sampleTimestamp?: number;
  imageBlobName?: string;
  displayName?: string;
  notes?: string;
};

export type PlayDescriptionsProjection = {
  recordId: string;
  generatedAt: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  playCount: number;
  plays: Array<{
    playIndex: number;
    sourceStartSeconds: number;
    sourceEndSeconds: number;
    trimmedStartSeconds: number;
    trimmedEndSeconds: number;
    sceneBlobName: string;
    contactedPlayers: Array<{
      trackId: number;
      teamId: number;
      teamSide?: TeamSide;
      firstContactTimestamp: number;
      contactCount: number;
    }>;
    contacts: Array<{
      playerTrackId: number;
      teamId: number;
      teamSide?: TeamSide;
      frameIndex: number;
      timestamp: number;
      distanceToBallPx: number;
      ballConfidence: number;
      actionType?: PlayActionType;
      actionConfidence?: number;
      actionReason?: string;
    }>;
    outcome?: PlayOutcomeAnnotation;
  }>;
};

export type PlayReadModelDocument = {
  id: string;
  recordId: string;
  docType: 'play';
  updatedAt: string;
  generatedAt: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  playIndex: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  trimmedStartSeconds: number;
  trimmedEndSeconds: number;
  sceneBlobName: string;
  contactedPlayers: Array<{
    trackId: number;
    teamId: number;
    teamSide?: TeamSide;
    firstContactTimestamp: number;
    contactCount: number;
  }>;
  contacts: Array<{
    playerTrackId: number;
    teamId: number;
    teamSide?: TeamSide;
    frameIndex: number;
    timestamp: number;
    distanceToBallPx: number;
    ballConfidence: number;
    actionType?: PlayActionType;
    actionConfidence?: number;
    actionReason?: string;
  }>;
  outcome?: PlayOutcomeAnnotation;
};

type ReadModelDocument = VideoReadModelDocument | PlayerReadModelDocument | PlayReadModelDocument;

type CosmosConfig = {
  endpoint: string;
  key: string;
  databaseName: string;
  containerName: string;
};

function getCosmosStatusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: number }).statusCode)
    : undefined;
}

function getCosmosConfig(): CosmosConfig | undefined {
  const endpoint = process.env.COSMOS_DB_ENDPOINT?.trim();
  const key = process.env.COSMOS_DB_KEY?.trim();
  if (!endpoint || !key) {
    return undefined;
  }

  return {
    endpoint,
    key,
    databaseName: process.env.COSMOS_DB_DATABASE_NAME?.trim() || DEFAULT_DATABASE_NAME,
    containerName: process.env.COSMOS_DB_CONTAINER_NAME?.trim() || DEFAULT_CONTAINER_NAME,
  };
}

function buildPlayerDocumentId(trackId: number): string {
  return `player:${trackId}`;
}

function buildPlayDocumentId(playIndex: number): string {
  return `play:${playIndex}`;
}

export class CosmosReadModelStore {
  private readonly container: Container;

  constructor(config: CosmosConfig) {
    const client = new CosmosClient({
      endpoint: config.endpoint,
      key: config.key,
    });
    this.container = client.database(config.databaseName).container(config.containerName);
  }

  async getVideoRecord(recordId: string): Promise<VideoReadModelDocument | undefined> {
    try {
      const { resource } = await this.container.item('video', recordId).read<VideoReadModelDocument>();
      return resource ?? undefined;
    } catch (error) {
      if (getCosmosStatusCode(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async listVideoRecords(): Promise<VideoReadModelDocument[]> {
    const querySpec: SqlQuerySpec = {
      query: 'SELECT * FROM c WHERE c.docType = @docType',
      parameters: [
        { name: '@docType', value: 'video' },
      ],
    };

    const { resources } = await this.container.items.query<VideoReadModelDocument>(querySpec).fetchAll();
    return resources.sort((left, right) => {
      const leftTime = new Date(left.uploadedAt ?? 0).getTime();
      const rightTime = new Date(right.uploadedAt ?? 0).getTime();
      return rightTime - leftTime;
    });
  }

  async listPlayerRecords(recordId: string): Promise<PlayerReadModelDocument[]> {
    const resources = await this.queryByDocType<PlayerReadModelDocument>(recordId, 'player');
    return resources.sort((left, right) => left.trackId - right.trackId);
  }

  async listPlayRecords(recordId: string): Promise<PlayReadModelDocument[]> {
    const resources = await this.queryByDocType<PlayReadModelDocument>(recordId, 'play');
    return resources.sort((left, right) => left.playIndex - right.playIndex);
  }

  async getPlayRecord(recordId: string, playIndex: number): Promise<PlayReadModelDocument | undefined> {
    try {
      const { resource } = await this.container.item(buildPlayDocumentId(playIndex), recordId).read<PlayReadModelDocument>();
      return resource ?? undefined;
    } catch (error) {
      if (getCosmosStatusCode(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async updatePlayOutcome(
    recordId: string,
    playIndex: number,
    outcome: PlayOutcomeAnnotation | undefined,
    existingPlay?: PlayReadModelDocument,
  ): Promise<PlayReadModelDocument | undefined> {
    const play = existingPlay ?? await this.getPlayRecord(recordId, playIndex);
    if (!play) {
      return undefined;
    }

    const updatedAt = outcome?.updatedAt ?? new Date().toISOString();
    const updated: PlayReadModelDocument = {
      ...play,
      updatedAt,
      ...(outcome ? { outcome } : {}),
    };

    if (!outcome) {
      delete updated.outcome;
    }

    await this.container.items.upsert(updated);
    return updated;
  }

  async mergeVideoRecord(recordId: string, updates: Partial<VideoReadModelDocument>): Promise<void> {
    const existing = await this.getVideoRecord(recordId);
    const updatedAt = typeof updates.updatedAt === 'string' ? updates.updatedAt : new Date().toISOString();
    const merged: VideoReadModelDocument = {
      ...(existing ?? {} as VideoReadModelDocument),
      ...(updates as VideoReadModelDocument),
      id: 'video',
      docType: 'video',
      recordId,
      updatedAt,
    };

    await this.container.items.upsert(merged);
  }

  async replacePlayerManifest(manifest: PlayerManifestProjection): Promise<void> {
    const updatedAt = new Date().toISOString();
    const documents: PlayerReadModelDocument[] = manifest.players.map((player) => ({
      id: buildPlayerDocumentId(player.trackId),
      recordId: manifest.recordId,
      docType: 'player',
      updatedAt,
      generatedAt: manifest.generatedAt,
      sourceVideoBlobName: manifest.sourceVideoBlobName,
      processedBlobName: manifest.processedBlobName,
      ...player,
    }));

    await this.replaceDocuments(manifest.recordId, 'player', documents);
    await this.mergeVideoRecord(manifest.recordId, {
      detectedPlayerCount: manifest.players.length,
      playerManifestGeneratedAt: manifest.generatedAt,
      updatedAt,
    });
  }

  async replacePlayDescriptions(manifest: PlayDescriptionsProjection): Promise<void> {
    const updatedAt = new Date().toISOString();
    const existingDocuments = await this.queryByDocType<PlayReadModelDocument>(manifest.recordId, 'play');
    const existingOutcomesById = new Map(existingDocuments.map((document) => [document.id, document.outcome]));
    const documents: PlayReadModelDocument[] = manifest.plays.map((play) => ({
      id: buildPlayDocumentId(play.playIndex),
      recordId: manifest.recordId,
      docType: 'play',
      updatedAt,
      generatedAt: manifest.generatedAt,
      sourceVideoBlobName: manifest.sourceVideoBlobName,
      processedBlobName: manifest.processedBlobName,
      ...play,
      outcome: existingOutcomesById.get(buildPlayDocumentId(play.playIndex)),
    }));

    await this.replaceDocuments(manifest.recordId, 'play', documents, existingDocuments);
    await this.mergeVideoRecord(manifest.recordId, {
      playCount: manifest.playCount,
      playDescriptionsGeneratedAt: manifest.generatedAt,
      updatedAt,
    });
  }

  private async queryByDocType<T extends ReadModelDocument>(recordId: string, docType: ReadModelDocType): Promise<T[]> {
    const querySpec: SqlQuerySpec = {
      query: 'SELECT * FROM c WHERE c.recordId = @recordId AND c.docType = @docType',
      parameters: [
        { name: '@recordId', value: recordId },
        { name: '@docType', value: docType },
      ],
    };

    const { resources } = await this.container.items.query<T>(querySpec, { partitionKey: recordId }).fetchAll();
    return resources;
  }

  private async replaceDocuments<T extends ReadModelDocument>(
    recordId: string,
    docType: ReadModelDocType,
    documents: T[],
    existingDocuments?: Array<{ id: string } & ReadModelDocument>,
  ): Promise<void> {
    const currentDocuments = existingDocuments
      ?? await this.queryByDocType<{ id: string } & ReadModelDocument>(recordId, docType);
    const nextIds = new Set(documents.map((document) => document.id));

    for (const document of documents) {
      await this.container.items.upsert(document);
    }

    for (const existing of currentDocuments) {
      if (nextIds.has(existing.id)) {
        continue;
      }
      await this.container.item(existing.id, recordId).delete();
    }
  }
}

let cachedStore: CosmosReadModelStore | null | undefined;
let loggedDisabledMessage = false;

export function getCosmosReadModelStore(
  log: (message: string, ...args: unknown[]) => void = console.warn,
): CosmosReadModelStore | undefined {
  if (cachedStore !== undefined) {
    return cachedStore ?? undefined;
  }

  const config = getCosmosConfig();
  if (!config) {
    if (!loggedDisabledMessage) {
      log('[cosmosReadModel] Cosmos DB config is incomplete; read-model integration is disabled.');
      loggedDisabledMessage = true;
    }
    cachedStore = null;
    return undefined;
  }

  cachedStore = new CosmosReadModelStore(config);
  return cachedStore;
}
