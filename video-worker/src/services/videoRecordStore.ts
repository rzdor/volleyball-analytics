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

function toDurationMs(startedAt: string, completedAt: string): number {
  return Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
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

  async markQueued(recordId: string, jobType: ProcessingJobType, retryCount = 0, jobToken?: string): Promise<string> {
    const queuedAt = new Date().toISOString();
    let updates: Partial<VideoRecordEntity>;

    if (jobType === 'convert') {
      updates = {
        status: 'queued',
        currentStage: 'convert',
        queuedAt,
        convertQueuedAt: queuedAt,
        convertRetryCount: retryCount,
        convertJobToken: jobToken,
        convertErrorMessage: '',
        convertFailedAt: '',
        lastJobType: 'convert',
        errorMessage: '',
        failedAt: '',
      };
    } else if (jobType === 'trim') {
      updates = {
        status: 'queued',
        currentStage: 'trim',
        queuedAt,
        trimQueuedAt: queuedAt,
        trimRetryCount: retryCount,
        trimJobToken: jobToken,
        trimErrorMessage: '',
        trimFailedAt: '',
        lastJobType: 'trim',
        errorMessage: '',
        failedAt: '',
      };
    } else {
      updates = {
        status: 'queued',
        currentStage: 'detect',
        queuedAt,
        detectQueuedAt: queuedAt,
        detectRetryCount: retryCount,
        detectJobToken: jobToken,
        detectErrorMessage: '',
        detectFailedAt: '',
        lastJobType: 'detect',
        errorMessage: '',
        failedAt: '',
      };
    }

    await this.update(recordId, updates);
    return queuedAt;
  }

  async markProcessing(recordId: string, jobType: ProcessingJobType, retryCount = 0): Promise<string> {
    const startedAt = new Date().toISOString();
    let updates: Partial<VideoRecordEntity>;

    if (jobType === 'convert') {
      updates = {
        status: 'processing',
        currentStage: 'convert',
        processingStartedAt: startedAt,
        convertStartedAt: startedAt,
        convertRetryCount: retryCount,
        convertErrorMessage: '',
        convertFailedAt: '',
        lastJobType: 'convert',
        errorMessage: '',
        failedAt: '',
      };
    } else if (jobType === 'trim') {
      updates = {
        status: 'processing',
        currentStage: 'trim',
        processingStartedAt: startedAt,
        trimStartedAt: startedAt,
        trimRetryCount: retryCount,
        trimErrorMessage: '',
        trimFailedAt: '',
        lastJobType: 'trim',
        errorMessage: '',
        failedAt: '',
      };
    } else {
      updates = {
        status: 'processing',
        currentStage: 'detect',
        processingStartedAt: startedAt,
        detectStartedAt: startedAt,
        detectRetryCount: retryCount,
        detectErrorMessage: '',
        detectFailedAt: '',
        lastJobType: 'detect',
        errorMessage: '',
        failedAt: '',
      };
    }

    await this.update(recordId, updates);
    return startedAt;
  }

  async markConvertCompletedAndQueueTrim(
    recordId: string,
    convertedBlobName: string,
    convertedBlobUrl: string,
    convertStartedAt: string,
    trimJobToken: string
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.update(recordId, {
      status: 'queued',
      currentStage: 'trim',
      lastJobType: 'trim',
      convertedBlobName,
      convertedBlobUrl,
      queuedAt: now,
      convertCompletedAt: now,
      convertDurationMs: toDurationMs(convertStartedAt, now),
      convertErrorMessage: '',
      convertFailedAt: '',
      trimQueuedAt: now,
      trimJobToken,
      trimErrorMessage: '',
      trimFailedAt: '',
      errorMessage: '',
      failedAt: '',
    });
  }

  async markTrimCompletedAndQueueDetect(
    recordId: string,
    processedBlobName: string,
    processedBlobUrl: string,
    trimStartedAt: string,
    detectJobToken: string,
    processedOutputFolder: string,
    processedSceneCount: number
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.update(recordId, {
      status: 'queued',
      currentStage: 'detect',
      lastJobType: 'detect',
      processedBlobName,
      processedBlobUrl,
      processedOutputFolder,
      processedSceneCount,
      queuedAt: now,
      trimCompletedAt: now,
      trimDurationMs: toDurationMs(trimStartedAt, now),
      trimErrorMessage: '',
      trimFailedAt: '',
      detectQueuedAt: now,
      detectJobToken,
      detectErrorMessage: '',
      detectFailedAt: '',
      errorMessage: '',
      failedAt: '',
    });
  }

  async markDetectCompleted(
    recordId: string,
    detectionBlobName: string,
    detectionBlobUrl: string,
    detectStartedAt: string
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.update(recordId, {
      status: 'completed',
      currentStage: 'completed',
      lastJobType: 'detect',
      completedAt: now,
      detectionBlobName,
      detectionBlobUrl,
      detectCompletedAt: now,
      detectDurationMs: toDurationMs(detectStartedAt, now),
      detectErrorMessage: '',
      detectFailedAt: '',
      detectJobToken: '',
      errorMessage: '',
      failedAt: '',
    });
  }

  async markFailed(recordId: string, jobType: ProcessingJobType, errorMessage: string, retryCount = 0): Promise<void> {
    const failedAt = new Date().toISOString();
    let updates: Partial<VideoRecordEntity>;

    if (jobType === 'convert') {
      updates = {
        status: 'failed',
        currentStage: 'failed',
        lastJobType: 'convert',
        failedAt,
        convertFailedAt: failedAt,
        convertRetryCount: retryCount,
        convertJobToken: '',
        convertErrorMessage: errorMessage,
        errorMessage,
      };
    } else if (jobType === 'trim') {
      updates = {
        status: 'failed',
        currentStage: 'failed',
        lastJobType: 'trim',
        failedAt,
        trimFailedAt: failedAt,
        trimRetryCount: retryCount,
        trimJobToken: '',
        trimErrorMessage: errorMessage,
        errorMessage,
      };
    } else {
      updates = {
        status: 'failed',
        currentStage: 'failed',
        lastJobType: 'detect',
        failedAt,
        detectFailedAt: failedAt,
        detectRetryCount: retryCount,
        detectJobToken: '',
        detectErrorMessage: errorMessage,
        errorMessage,
      };
    }

    await this.update(recordId, updates);
  }
}

let defaultStore: VideoRecordStore | undefined;

export function getVideoRecordStore(): VideoRecordStore {
  if (!defaultStore) {
    defaultStore = new VideoRecordStore();
  }

  return defaultStore;
}
