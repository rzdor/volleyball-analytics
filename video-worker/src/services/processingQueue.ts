import { DequeuedMessageItem, QueueClient } from '@azure/storage-queue';
import { ProcessingJobMessage } from '../types/processing';

export type ProcessingQueueName = 'convert' | 'trim' | 'detect';

const DEFAULT_CONVERT_QUEUE_NAME = 'video-convert-jobs';
const DEFAULT_TRIM_QUEUE_NAME = 'video-trim-jobs';
const DEFAULT_DETECT_QUEUE_NAME = 'video-detect-jobs';

function getStorageConnectionString(): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage must be configured');
  }
  return connectionString;
}

function getQueueName(queueName: ProcessingQueueName): string {
  if (queueName === 'convert') {
    return process.env.VIDEO_CONVERT_QUEUE_NAME ?? DEFAULT_CONVERT_QUEUE_NAME;
  }

  if (queueName === 'detect') {
    return process.env.VIDEO_DETECT_QUEUE_NAME ?? DEFAULT_DETECT_QUEUE_NAME;
  }

  return process.env.VIDEO_TRIM_QUEUE_NAME ?? DEFAULT_TRIM_QUEUE_NAME;
}

function getStatusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: number }).statusCode)
    : undefined;
}

export class ProcessingQueue {
  private readonly queueClient: QueueClient;
  private readonly queueReady: Promise<void>;

  constructor(queueName: ProcessingQueueName) {
    this.queueClient = new QueueClient(getStorageConnectionString(), getQueueName(queueName));
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

const queues = new Map<ProcessingQueueName, ProcessingQueue>();

export function getProcessingQueue(queueName: ProcessingQueueName): ProcessingQueue {
  const existing = queues.get(queueName);
  if (existing) {
    return existing;
  }

  const queue = new ProcessingQueue(queueName);
  queues.set(queueName, queue);
  return queue;
}
