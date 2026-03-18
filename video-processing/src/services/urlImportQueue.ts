import { QueueClient } from '@azure/storage-queue';

export interface VideoUrlImportMessage {
  version: 1;
  recordId: string;
  requestedVideoUrl: string;
  sourceContainer: string;
  sourceBlobName: string;
}

const DEFAULT_URL_IMPORT_QUEUE_NAME = 'video-url-import-jobs';

function getStorageConnectionString(): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage must be configured');
  }
  return connectionString;
}

function getStatusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: number }).statusCode)
    : undefined;
}

export class VideoUrlImportQueue {
  private readonly queueClient: QueueClient;
  private readonly queueReady: Promise<void>;

  constructor() {
    const queueName = process.env.VIDEO_URL_IMPORT_QUEUE_NAME ?? DEFAULT_URL_IMPORT_QUEUE_NAME;
    this.queueClient = new QueueClient(getStorageConnectionString(), queueName);
    this.queueReady = this.queueClient.createIfNotExists().then(() => undefined).catch((error: unknown) => {
      if (getStatusCode(error) === 409) {
        return;
      }
      throw error;
    });
  }

  async enqueue(message: VideoUrlImportMessage): Promise<void> {
    await this.queueReady;
    await this.queueClient.sendMessage(JSON.stringify(message));
  }
}

let defaultQueue: VideoUrlImportQueue | undefined;

export function getVideoUrlImportQueue(): VideoUrlImportQueue {
  if (!defaultQueue) {
    defaultQueue = new VideoUrlImportQueue();
  }

  return defaultQueue;
}
