import path from 'path';
import { randomUUID } from 'crypto';
import { HttpRequest, HttpResponseInit, InvocationContext, app } from '@azure/functions';
import { BlobServiceClient } from '@azure/storage-blob';
import { getVideoRecordStore } from '../services/videoRecordStore';
import { getVideoUrlImportQueue } from '../services/urlImportQueue';

const DEFAULT_VIDEO_CONTAINER = 'volleyball-videos';

function getStorageConnectionString(): string {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage must be configured');
  }
  return connectionString;
}

function getVideoContainerName(): string {
  return process.env.VIDEO_BLOB_CONTAINER ?? DEFAULT_VIDEO_CONTAINER;
}

function inferTargetExtension(videoUrl: string): string {
  try {
    const url = new URL(videoUrl);
    const ext = path.extname(url.pathname).toLowerCase();
    return ['.mp4', '.webm', '.mov', '.avi'].includes(ext) ? ext : '.mp4';
  } catch {
    return '.mp4';
  }
}

function buildBlobUrl(containerName: string, blobName: string): string {
  const blobService = BlobServiceClient.fromConnectionString(getStorageConnectionString());
  return blobService.getContainerClient(containerName).getBlobClient(blobName).url;
}

export async function queueVideoUrlImportHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = await request.json() as { videoUrl?: unknown };
    const videoUrl = typeof body?.videoUrl === 'string' ? body.videoUrl.trim() : '';

    if (!videoUrl) {
      return {
        status: 400,
        jsonBody: { error: 'videoUrl is required' },
      };
    }

    const url = new URL(videoUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return {
        status: 400,
        jsonBody: { error: 'Only HTTP(S) video URLs are supported' },
      };
    }

    const extension = inferTargetExtension(videoUrl);
    const containerName = getVideoContainerName();
    const blobName = `input/url-${randomUUID()}${extension}`;
    const blobUrl = buildBlobUrl(containerName, blobName);

    const recordStore = getVideoRecordStore();
    const { record } = await recordStore.createForUrlImport({
      containerName,
      blobName,
      blobUrl,
      requestedVideoUrl: videoUrl,
    });

    await getVideoUrlImportQueue().enqueue({
      version: 1,
      recordId: record.recordId,
      requestedVideoUrl: videoUrl,
      sourceContainer: containerName,
      sourceBlobName: blobName,
    });

    context.log('queueVideoUrlImport queued import job', {
      recordId: record.recordId,
      sourceBlobName: blobName,
    });

    return {
      status: 202,
      jsonBody: {
        success: true,
        recordId: record.recordId,
        blobName,
        container: containerName,
        currentStage: 'import',
        status: 'queued',
        requestedVideoUrl: videoUrl,
      },
    };
  } catch (error) {
    context.error('queueVideoUrlImport failed', error);
    return {
      status: 500,
      jsonBody: {
        error: 'Failed to queue video URL import',
      },
    };
  }
}

app.http('queueVideoUrlImport', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'videos/import-from-url',
  handler: queueVideoUrlImportHandler,
});
