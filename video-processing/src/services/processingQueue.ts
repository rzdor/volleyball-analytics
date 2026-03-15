import { DequeuedMessageItem, QueueClient } from '@azure/storage-queue';
import { ProcessingJobMessage } from '../types/processing';

const DEFAULT_QUEUE_NAME = 'video-processing-jobs';

function getStorageConnectionString(): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage must be configured');
  }
  return connectionString;
}

function getQueueName(): string {
  return process.env.VIDEO_PROCESSING_QUEUE_NAME ?? DEFAULT_QUEUE_NAME;
}

function getStatusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: number }).statusCode)
    : undefined;
}

export class ProcessingQueue {
  private readonly queueClient: QueueClient;
  private readonly queueReady: Promise<void>;

  constructor() {
    this.queueClient = new QueueClient(getStorageConnectionString(), getQueueName());
    this.queueReady = this.queueClient.createIfNotExists().then(() => undefined).catch((error: unknown) => {
      if (getStatusCode(error) === 409) {
        return;
      }
      throw error;
    });
  }

  async enqueue(job: ProcessingJobMessage): Promise<void> {
    await this.queueReady;
    await this.queueClient.sendMessage(JSON.stringify(job));
  }

  async receive(maxMessages: number, visibilityTimeout: number): Promise<DequeuedMessageItem[]> {
    await this.queueReady;
    const response = await this.queueClient.receiveMessages({
      numberOfMessages: maxMessages,
      visibilityTimeout,
    });
    return response.receivedMessageItems;
  }

  async deleteMessage(messageId: string, popReceipt: string): Promise<void> {
    await this.queueReady;
    await this.queueClient.deleteMessage(messageId, popReceipt);
  }
}

let defaultQueue: ProcessingQueue | undefined;

export function getProcessingQueue(): ProcessingQueue {
  if (!defaultQueue) {
    defaultQueue = new ProcessingQueue();
  }

  return defaultQueue;
}
