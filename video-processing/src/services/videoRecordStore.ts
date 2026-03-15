import { TableClient } from '@azure/data-tables';
import {
  createUploadedVideoEntity,
  ProcessingJobType,
  UploadedVideoDescriptor,
  VIDEO_RECORD_PARTITION_KEY,
  VideoRecordEntity,
} from '../types/processing';

const DEFAULT_TABLE_NAME = 'videoprocessingrecords';

function getStorageConnectionString(): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage must be configured');
  }
  return connectionString;
}

function getTableName(): string {
  return process.env.VIDEO_RECORDS_TABLE_NAME ?? DEFAULT_TABLE_NAME;
}

function getStatusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: number }).statusCode)
    : undefined;
}

export class VideoRecordStore {
  private readonly client: TableClient;
  private readonly tableReady: Promise<void>;

  constructor() {
    this.client = TableClient.fromConnectionString(getStorageConnectionString(), getTableName());
    this.tableReady = this.client.createTable().then(() => undefined).catch((error: unknown) => {
      if (getStatusCode(error) === 409) {
        return;
      }
      throw error;
    });
  }

  async createFromUpload(upload: UploadedVideoDescriptor): Promise<{ created: boolean; record: VideoRecordEntity }> {
    await this.tableReady;
    const entity = createUploadedVideoEntity(upload);

    try {
      await this.client.createEntity(entity);
      return { created: true, record: entity };
    } catch (error) {
      if (getStatusCode(error) !== 409) {
        throw error;
      }

      const record = await this.get(entity.recordId);
      if (!record) {
        throw error;
      }

      return { created: false, record };
    }
  }

  async get(recordId: string): Promise<VideoRecordEntity | undefined> {
    await this.tableReady;

    try {
      return await this.client.getEntity<VideoRecordEntity>(VIDEO_RECORD_PARTITION_KEY, recordId);
    } catch (error) {
      if (getStatusCode(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async update(recordId: string, updates: Partial<VideoRecordEntity>): Promise<void> {
    await this.tableReady;
    await this.client.updateEntity({
      partitionKey: VIDEO_RECORD_PARTITION_KEY,
      rowKey: recordId,
      updatedAt: new Date().toISOString(),
      ...updates,
    }, 'Merge');
  }

  async markQueued(recordId: string, jobType: ProcessingJobType): Promise<void> {
    await this.update(recordId, {
      status: 'queued',
      currentStage: jobType,
      queuedAt: new Date().toISOString(),
      lastJobType: jobType,
      errorMessage: '',
      failedAt: '',
    });
  }

  async markProcessing(recordId: string, jobType: ProcessingJobType): Promise<void> {
    await this.update(recordId, {
      status: 'processing',
      currentStage: jobType,
      processingStartedAt: new Date().toISOString(),
      lastJobType: jobType,
      errorMessage: '',
      failedAt: '',
    });
  }

  async markFailed(recordId: string, jobType: ProcessingJobType, errorMessage: string): Promise<void> {
    await this.update(recordId, {
      status: 'failed',
      currentStage: 'failed',
      lastJobType: jobType,
      failedAt: new Date().toISOString(),
      errorMessage,
    });
  }
}

let defaultStore: VideoRecordStore | undefined;

export function getVideoRecordStore(): VideoRecordStore {
  if (!defaultStore) {
    defaultStore = new VideoRecordStore();
  }

  return defaultStore;
}
